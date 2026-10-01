/** Local launch review and Session ownership for the optional browser entry. */
import { randomUUID } from 'node:crypto'
import { RuntimeLaunchRequestSchema, MAX_RUNTIME_LAUNCH_BYTES } from '@char-pub/contracts'
import { checkCapabilitySupport, digestExactJSON, SessionSchema, RuntimeProfileSchema, type RuntimeProfile, type CreationArtifact, type Story, type ContextIR, type StoryState, type HistoryMessage } from '@char-pub/core'
import { createPreparationCatalog, estimateCounter, noneSelection, startSession } from '@char-pub/assembler'
import { commandId, type ReplayInput } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type RoleplayRuntime from './index.ts'
import type { LoadedContent, RegistryClient } from './registry/client.ts'
import { createRuntimePreviewExports, type RuntimePreviewExportResult, type RuntimePreviewExportReview } from './preview-export.ts'

const supported = ['catalog.v1', 'sources.v1', 'perspective.v1', 'story.v1', 'cast.override', 'view.outward', 'style.scope', 'policy.1-draft', 'story.conditions', 'story.knowing', 'story.items', 'story.events']
const support = { supported, degraded: [{ id: 'story.judge', reason: 'This entry leaves model judgments undetermined; it does not infer story transitions from chat.' }] }
const Start = z.strictObject({
  review: z.string(), bindings: SessionSchema.shape.bindings, start: z.string().optional(),
  for_participant: z.string().optional(), restart: z.boolean(),
})
const Turn = z.strictObject({ session: z.string(), text: z.string().min(1).max(100_000) })
const Synthetic = z.strictObject({ session: z.string(), history: SessionSchema.shape.history, bindings: SessionSchema.shape.bindings })
function fail(code: string): never { throw new Error(`roleplay_app.${code}`) }
function available(value: LoadedContent) {
  const root = value.artifact.root
  if ('origin' in root && (root.origin.kind !== 'draft-build' || Date.parse(root.origin.expires_at) <= Date.now())) fail('source_expired')
}

/** Fixed deployment dependencies; no launch request can replace these endpoints or model routes. */
export interface AppControllerOptions {
  registry: Pick<RegistryClient, 'release' | 'draftBuild' | 'sourceTexts' | 'authorizationVersion'>
  registryOrigin: string
  runtime: Pick<RoleplayRuntime, 'create' | 'submit' | 'inspect'>
  profile: RuntimeProfile
  model: LlmCallConfig
  timeout_ms: number
}

/** Metadata reviewed locally before creating a new Session; it contains no Registry credential. */
export interface AppLaunchReview {
  review: string
  source: CreationArtifact['root']
  title: string | Record<string, string>
  metadata: CreationArtifact['meta']
  capabilities: CreationArtifact['capabilities']
  support: ReturnType<typeof checkCapabilitySupport>
  starts: NonNullable<Story['starts']>
  participants: Array<Pick<ContextIR['participants'][number], 'key' | 'display_name' | 'cast_key'>>
  late_slots: ContextIR['late_slots']
  locale: string
  start: string | undefined
  view: z.infer<typeof RuntimeLaunchRequestSchema>['view']
  restart_required: boolean
  previous_source: CreationArtifact['root'] | undefined
}
/** Explicit local HTTP operations; opaque handles prevent old tabs from addressing a new Session. */
export interface AppController {
  review(raw: unknown): Promise<AppLaunchReview>
  start(raw: unknown): Promise<{ session: string; history: HistoryMessage[]; state: StoryState }>
  turn(raw: unknown): Promise<{ status: string; history: HistoryMessage[]; state: StoryState }>
  cancel(raw: unknown): void
  prepareExport(raw: unknown): Promise<Pick<RuntimePreviewExportReview, 'digest' | 'payload'>>
  export(raw: unknown): Promise<RuntimePreviewExportResult>
  dispose(): Promise<void>
}

/**
 * Own one local browser workspace; replacing a launch never overwrites a durable Session.
 * @param options - Fixed Registry, driver and model configuration from the local profile.
 * @returns Local review, confirmation, generation and preview export operations.
 */
export function createAppController(options: AppControllerOptions): AppController {
  const { registry, runtime, registryOrigin } = options
  const deploymentProfile = RuntimeProfileSchema.parse(options.profile)
  const model = structuredClone(options.model)
  let launch: z.infer<typeof RuntimeLaunchRequestSchema> | undefined
  let loaded: LoadedContent | undefined
  let review: string | undefined
  let epoch = 0
  let current: { handle: string; epoch: number; id: SessionId; loaded: LoadedContent; for_participant?: string } | undefined
  let active: AbortController | undefined
  let activeSession: string | undefined
  let pending: Promise<unknown> | undefined
  let closed = false
  const exports = createRuntimePreviewExports({ inspect: id => runtime.inspect(id) })
  let exportReview: Awaited<ReturnType<typeof exports.prepare>> | undefined
  async function operation<T>(fn: (signal: AbortSignal) => Promise<T>, session?: string) {
    if (closed) fail('closed')
    if (active) fail('busy')
    const controller = new AbortController()
    active = controller
    activeSession = session
    const timer = setTimeout(() =>{  controller.abort(new Error('roleplay_app.timeout')) }, options.timeout_ms)
    const result = fn(controller.signal).finally(() => {
      clearTimeout(timer); active = undefined; activeSession = undefined; pending = undefined
    })
    pending = result
    return result
  }
  function checkedReview() {
    if (!launch || !loaded || !review) fail('review_required')
    if (epoch !== registry.authorizationVersion()) fail('authorization_changed')
    available(loaded)
    return { launch, loaded, review }
  }
  function profile(value: LoadedContent, request: z.infer<typeof RuntimeLaunchRequestSchema>) {
    if (value.artifact.kind !== 'content') fail('content_required')
    const locked = value.artifact.assembly?.profile
    if (locked && locked.mode !== request.view.mode) fail('locked_view_mismatch')
    const result = RuntimeProfileSchema.parse({ ...(locked ?? deploymentProfile), mode: request.view.mode, locale: request.locale })
    if (result.tokenizer !== 'estimate') fail('tokenizer_unsupported')
    if (!model.maxTokens || model.maxTokens > result.reserve_for_output) fail('model_output_budget')
    return result
  }
  return {
    async review(raw: unknown) {
      return operation(async (signal) => {
        review = undefined; loaded = undefined; launch = undefined
        if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RUNTIME_LAUNCH_BYTES) fail('launch_too_large')
        const intent = RuntimeLaunchRequestSchema.parse(raw)
        if (intent.registry_origin !== registryOrigin) fail('registry_mismatch')
        const authorization = registry.authorizationVersion()
        const value = 'release' in intent.source ? await registry.release(intent.source, signal) : await registry.draftBuild(intent.source.origin.build_id, signal)
        signal.throwIfAborted()
        if (authorization !== registry.authorizationVersion()) fail('authorization_changed')
        if (digestExactJSON(value.artifact.root) !== digestExactJSON(intent.source) || value.artifact.lock_digest !== intent.lock_digest) fail('source_mismatch')
        available(value)
        const artifact = value.artifact
        if (artifact.kind !== 'content' || !artifact.story || !artifact.story_refs) fail('story_required')
        if (intent.start !== undefined && !artifact.story.starts?.some(start => start.id === intent.start)) fail('start_unknown')
        const perspective = intent.view.mode === 'per-agent' ? intent.view.for_participant : undefined
        if (perspective !== undefined && !artifact.ir.participants.some(participant => participant.key === perspective)) fail('participant_unknown')
        const report = checkCapabilitySupport(artifact.capabilities, support)
        if (report.status === 'unsupported') fail('capability_unsupported')
        profile(value, intent)
        launch = intent; loaded = value; epoch = authorization
        review = digestExactJSON({ intent, artifact, authorization })
        exportReview = undefined
        return { review, source: artifact.root, title: artifact.catalog_index.works.find(work => work.instance === 'root')?.title ?? artifact.root.ref, metadata: artifact.meta,
          capabilities: artifact.capabilities, support: report, starts: artifact.story.starts ?? [],
          participants: artifact.ir.participants.map(({ key, display_name, cast_key }) => ({ key, display_name, cast_key })),
          late_slots: artifact.ir.late_slots, locale: intent.locale, start: intent.start,
          view: intent.view, restart_required: current !== undefined, previous_source: current?.loaded.artifact.root }
      })
    },
    async start(raw: unknown) {
      const input = Start.parse(raw)
      return operation(async (signal) => {
        const selected = checkedReview()
        if (input.review !== selected.review) fail('review_changed')
        if (current && !input.restart) fail('restart_confirmation_required')
        const artifact = selected.loaded.artifact
        if (artifact.kind !== 'content') fail('content_required')
        const runtimeProfile = profile(selected.loaded, selected.launch)
        const forParticipant = runtimeProfile.mode === 'per-agent'
          ? input.for_participant ?? (selected.launch.view.mode === 'per-agent' ? selected.launch.view.for_participant : undefined) : undefined
        if (forParticipant && !artifact.ir.participants.some(participant => participant.key === forParticipant)) fail('participant_unknown')
        const opening = input.start ?? selected.launch.start
        if (opening !== undefined && !artifact.story?.starts?.some(start => start.id === opening)) fail('start_unknown')
        if (runtimeProfile.mode === 'per-agent' && !forParticipant) fail('participant_required')
        const started = startSession({ artifact, bindings: input.bindings, locale: selected.launch.locale,
          ...(opening === undefined ? {} : { start: opening }) })
        const turn = { ...started.turn, ...(forParticipant === undefined ? {} : { for_participant: forParticipant }) }
        const preparation = { artifact, profile: runtimeProfile, turn, counter: estimateCounter }
        const catalog = createPreparationCatalog(preparation, false)
        const plan = noneSelection(catalog)
        const texts = await registry.sourceTexts(selected.loaded, { ...preparation, plan }, signal)
        signal.throwIfAborted()
        checkedReview()
        const id = SessionId(randomUUID())
        const replay: ReplayInput = { artifact, profile: runtimeProfile, support, bindings: input.bindings, source_texts: texts,
          locale: selected.launch.locale,
          ...(opening === undefined ? {} : { start: opening }),
          ...(forParticipant === undefined ? {} : { for_participant: forParticipant }) }
        const projection = await runtime.create(id, replay, signal)
        current = { handle: randomUUID(), epoch, id, loaded: selected.loaded,
          ...(forParticipant === undefined ? {} : { for_participant: forParticipant }) }
        exportReview = undefined
        return { session: current.handle, history: projection.current.turn.history, state: projection.current.state }
      })
    },
    async turn(raw: unknown) {
      const input = Turn.parse(raw)
      return operation(async (signal) => {
        if (!current) fail('session_required')
        if (current.handle !== input.session) fail('stale_session')
        if (current.epoch !== registry.authorizationVersion()) fail('authorization_changed')
        available(current.loaded)
        const result = await runtime.submit(current.id, { id: commandId(randomUUID()), operation: { kind: 'input', text: input.text },
          ...(current.for_participant === undefined ? {} : { for_participant: current.for_participant }) }, model, signal)
        const projection = await runtime.inspect(current.id)
        exportReview = undefined
        return { status: result.status, history: projection.current.turn.history, state: projection.current.state }
      }, input.session)
    },
    cancel(raw: unknown) {
      const input = z.strictObject({ session: z.string().optional() }).parse(raw)
      if (input.session !== activeSession || (input.session !== undefined && current?.handle !== input.session)) fail('stale_session')
      active?.abort(new Error('roleplay_app.cancelled'))
    },
    async prepareExport(raw: unknown) {
      const input = Synthetic.parse(raw)
      return operation(async (signal) => {
        if (!current) fail('session_required')
        if (current.handle !== input.session) fail('stale_session')
        exportReview = await exports.prepare({ session: current.id, history: input.history, bindings: input.bindings,
          ...(current.for_participant === undefined ? {} : { for_participant: current.for_participant }) }, signal)
        return { digest: exportReview.digest, payload: exportReview.payload }
      }, input.session)
    },
    async export(raw: unknown) {
      const { digest, session } = z.strictObject({ session: z.string(), digest: z.string() }).parse(raw)
      return operation(async (signal) => {
        if (!current || current.handle !== session) fail('stale_session')
        if (!exportReview) fail('export_review_required')
        return exports.export(exportReview, { candidate_digest: digest }, signal)
      }, session)
    },
    async dispose() { closed = true; active?.abort(new Error('roleplay_app.closed')); await pending?.catch(() => undefined) },
  }
}
