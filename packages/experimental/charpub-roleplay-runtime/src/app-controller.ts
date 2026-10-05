/** Local launch review, readable player projections and Session ownership for the browser entry. */
import { randomUUID } from 'node:crypto'
import { RuntimeLaunchRequestSchema, MAX_RUNTIME_LAUNCH_BYTES } from '@char-pub/contracts'
import { CharError, checkCapabilitySupport, digestExactJSON, resolveStoryPlayer, SessionSchema, RuntimeProfileSchema, type RuntimeProfile, type CreationArtifact } from '@char-pub/core'
import { createPreparationCatalog, estimateCounter, noneSelection, projectPlayerView, startSession } from '@char-pub/assembler'
import { commandId, type ReplayInput } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type RoleplayRuntime from './index.ts'
import { canRewind, lookupPlay, type RoleplayProjection } from './projection.ts'
import type { RoleplayPlayConfig } from './events.ts'
import type { LoadedContent, RegistryClient } from './registry/client.ts'
import { createRuntimePreviewExports, type RuntimePreviewExportResult, type RuntimePreviewExportReview } from './preview-export.ts'
import type { AppCredentialState, AppLaunchReview, AppSessionSnapshot, AppSessionsResponse, AppStatus, AppTurnResult, AppTurnStatus, AppWork } from './app-types.ts'
export type { AppLaunchReview } from './app-types.ts'

const supported = ['catalog.v1', 'sources.v1', 'perspective.v1', 'story.v1', 'story.player-control', 'cast.override', 'view.outward', 'style.scope', 'policy.1-draft', 'story.conditions', 'story.knowing', 'story.items', 'story.events']
const RequestID = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)
const SessionRequest = z.strictObject({ session: z.string().min(1) })
const RequestIdentity = SessionRequest.extend({ request_id: RequestID })
const Start = z.strictObject({
  review: z.string(), bindings: SessionSchema.shape.bindings, start: z.string().optional(),
  for_participant: z.string().optional(), restart: z.boolean(),
})
const Turn = RequestIdentity.extend({ text: z.string().min(1).max(100_000), expected_revision: z.string().optional(),
  choice_id: z.string().min(1).optional(), confirm_ending: z.strictObject({ proposal_id: z.string().min(1) }).optional(),
  recover_interrupted: z.literal(true).optional() })
const Synthetic = SessionRequest.extend({ history: SessionSchema.shape.history, bindings: SessionSchema.shape.bindings })
function fail(code: string): never { throw new Error(`roleplay_app.${code}`) }
function available(value: LoadedContent) {
  const root = value.artifact.root
  if ('origin' in root && (root.origin.kind !== 'draft-build' || Date.parse(root.origin.expires_at) <= Date.now())) fail('source_expired')
}
function display(value: unknown, locale: string, fallback = 'en'): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  const picked = row[locale] ?? row[fallback] ?? Object.values(row)[0]
  return typeof picked === 'string' ? picked : ''
}
function work(artifact: CreationArtifact, locale: string, label?: string): AppWork {
  const root = artifact.kind === 'content' ? artifact.catalog_index.works.find(item => item.instance === 'root') : undefined
  const title = display(root?.title, locale, artifact.meta.default_locale) || artifact.root.ref
  const summary = display(root?.description, locale, artifact.meta.default_locale)
  return { title, ...(summary ? { summary } : {}), source: artifact.root, locale,
    source_label: label ?? ('release' in artifact.root ? artifact.root.release : artifact.root.origin.kind === 'draft-build' ? 'draft-build' : 'local-build') }
}
/** One private persistence page; identifiers never cross the HTTP API directly. */
export interface AppStoredRecord { id: SessionId; createdAt: number; projection?: RoleplayProjection; error?: string }
/** Existing services supplied by the owning profile; no launch can replace endpoints or model routes. */
export interface AppControllerOptions {
  registry: Pick<RegistryClient, 'release' | 'draftBuild' | 'sourceTexts' | 'authorizationVersion' | 'authorizationStatus'>
  registryOrigin: string
  runtime: Pick<RoleplayRuntime, 'create' | 'submit' | 'inspect' | 'play' | 'rewind'>
  listRecords(options: { limit: number; after?: SessionId; signal: AbortSignal }): Promise<{
    records: AppStoredRecord[]
    after?: SessionId
  }>
  profile: RuntimeProfile
  model: LlmCallConfig
  play?: Omit<RoleplayPlayConfig, 'generation'>
  timeout_ms: number
}
/** Same-origin operations; Session state stays in its durable log and browser handles are process-local. */
export interface AppController {
  /** @param credential - Current credential presence read by the profile entry for the configured model route. */
  status(credential: AppCredentialState): AppStatus
  sessions(raw: unknown): Promise<AppSessionsResponse>
  resume(raw: unknown): Promise<AppSessionSnapshot>
  session(raw: unknown): Promise<AppSessionSnapshot>
  review(raw: unknown): Promise<AppLaunchReview>
  start(raw: unknown): Promise<AppSessionSnapshot>
  turn(raw: unknown): Promise<AppTurnResult>
  turnStatus(raw: unknown): Promise<AppTurnStatus>
  rewind(raw: unknown): Promise<AppSessionSnapshot>
  cancel(raw: unknown): void
  prepareExport(raw: unknown): Promise<Pick<RuntimePreviewExportReview, 'digest' | 'payload'>>
  export(raw: unknown): Promise<RuntimePreviewExportResult>
  dispose(): Promise<void>
}
/**
 * Own a local player workspace without replacing its durable Session log.
 * @param options - Fixed Registry, persistence, driver and model services.
 * @returns Validated player operations and bounded local record discovery.
 */
export function createAppController(options: AppControllerOptions): AppController {
  const { registry, runtime, registryOrigin } = options
  const listRecords: AppControllerOptions['listRecords'] = request => options.listRecords(request)
  const deploymentProfile = RuntimeProfileSchema.parse(options.profile)
  const model = structuredClone(options.model)
  const play = options.play ? { ...structuredClone(options.play), generation: model } : undefined
  const support = play ? { supported: [...supported, 'story.judge'], degraded: [] }
    : { supported, degraded: [{ id: 'story.judge', reason: 'This entry leaves model judgments undetermined; it does not infer story transitions from chat.' }] }
  const limitations = play ? ['text_only', 'shared_scene_dialogue']
    : ['text_only', 'required_direct_context', 'manual_story_progress', 'model_judgments_undetermined']
  let launch: z.infer<typeof RuntimeLaunchRequestSchema> | undefined
  let loaded: LoadedContent | undefined
  let review: string | undefined
  let epoch = 0
  let current: { handle: string; epoch: number; id: SessionId; loaded: LoadedContent; for_participant?: string } | undefined
  let active: AbortController | undefined
  let activity: AppStatus['operation'] = null
  let pending: Promise<unknown> | undefined
  let turnPending: { session: string; id: string; digest: string; promise: Promise<AppTurnResult> } | undefined
  let closed = false
  const records = new Map<string, SessionId>()
  const recordHandles = new Map<SessionId, string>()
  const cursors = new Map<string, SessionId>()
  const cursorHandles = new Map<SessionId, string>()
  const exports = createRuntimePreviewExports({ inspect: id => runtime.inspect(id) })
  let exportReview: Awaited<ReturnType<typeof exports.prepare>> | undefined
  function opaque(id: SessionId, ids: Map<SessionId, string>, values: Map<string, SessionId>) {
    let token = ids.get(id)
    if (!token) { token = values === records ? digestExactJSON({ domain: 'roleplay-local-record', id }) : randomUUID(); ids.set(id, token); values.set(token, id) }
    return token
  }
  async function operation<T>(kind: NonNullable<AppStatus['operation']>['kind'], fn: (signal: AbortSignal) => Promise<T>, session?: string, requestID?: string) {
    if (closed) fail('closed')
    if (active) fail('busy')
    const controller = new AbortController(); active = controller
    activity = { kind, ...(session ? { session } : {}), ...(requestID ? { request_id: requestID } : {}) }
    const timer = setTimeout(() => { controller.abort(new CharError({ code: 'roleplay_runtime.timeout', subject: 'app-operation' })) }, options.timeout_ms)
    const result = fn(controller.signal).finally(() => { clearTimeout(timer); active = undefined; activity = null; pending = undefined })
    pending = result
    return result
  }
  function checkedReview() {
    if (!launch || !loaded || !review) fail('review_required')
    if (epoch !== registry.authorizationVersion()) fail('authorization_changed')
    available(loaded)
    return { launch, loaded, review }
  }
  function checkedSession(handle: string) {
    if (!current) fail('session_required')
    if (current.handle !== handle) fail('stale_session')
    if (current.epoch !== registry.authorizationVersion()) fail('authorization_changed')
    return current
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
  function snapshot(selected: NonNullable<typeof current>, projection: RoleplayProjection): AppSessionSnapshot {
    const input = projection.log.input; const artifact = input.artifact
    if (artifact.kind !== 'content' || !artifact.story) fail('story_required')
    const turn = projection.current.turn
    const locale = turn.locale ?? input.profile.locale ?? artifact.meta.default_locale
    const visible = projectPlayerView({ artifact, turn })
    const participants = visible.participants.map(participant => ({ key: participant.key, name: participant.name,
      present: participant.present, ...(participant.part ? { role: participant.part } : {}),
      ...(participant.portrait ? { portrait: participant.portrait } : {}),
    }))
    const expired = 'origin' in artifact.root && (artifact.root.origin.kind !== 'draft-build' || Date.parse(artifact.root.origin.expires_at) <= Date.now())
    return { session: selected.handle, record: opaque(selected.id, recordHandles, records), work: work(artifact, locale, 'label' in selected.loaded.receipt ? selected.loaded.receipt.label : undefined), history: structuredClone(turn.history), participants, late_slots: structuredClone(artifact.ir.late_slots),
      scene: visible.scene ?? null,
      experience: { revision: projection.revision, player: visible.player, known: visible.known,
        choices: visible.choices, milestones: visible.milestones, can_undo: !!play && canRewind(projection),
        ...(projection.pending_ending ? { pending_ending: { id: projection.pending_ending.id,
          triggering_input: projection.pending_ending.public.triggering_input,
          ...(projection.pending_ending.public.title === undefined ? {} : { title: projection.pending_ending.public.title }),
          ...(projection.pending_ending.public.description === undefined ? {}
            : { description: projection.pending_ending.public.description }),
        } } : {}),
      },
      stopped: projection.current.state.stopped, interrupted: projection.pending !== null || projection.pending_turn !== null,
      can_continue: !expired && !projection.current.state.stopped && projection.pending === null && projection.pending_turn === null,
      limitations: [...limitations],
    }
  }
  function result(selected: NonNullable<typeof current>, projection: RoleplayProjection, requestID: string): AppTurnStatus {
    const planned = lookupPlay(projection, commandId(`app-input:${requestID}`))
    if (planned.status === 'pending') return { request_id: requestID, status: 'failed', error_code: 'interrupted', snapshot: snapshot(selected, projection) }
    if (planned.status === 'settled') {
      const { settlement, superseded, resolution } = planned.result
      const unavailable = settlement.status === 'success' && resolution.actions.some(action => action.target === 'turn')
      return { request_id: requestID, status: settlement.status, ...('reason' in settlement ? { error_code: settlement.reason } : {}),
        ...(superseded ? { superseded: true as const } : {}),
        ...(unavailable ? { story_progress_unavailable: true as const } : {}), snapshot: snapshot(selected, projection) }
    }
    const requested = [...projection.requests.values()].find(item => item.command.id === commandId(`app-input:${requestID}`))
    const state = snapshot(selected, projection)
    if (!requested) return { request_id: requestID, status: 'not_found', snapshot: state }
    const settled = projection.settlements.get(requested.id)
    if (!settled) return { request_id: requestID, status: 'failed', error_code: 'interrupted', snapshot: state }
    return { request_id: requestID, status: settled.status, ...('reason' in settled ? { error_code: settled.reason } : {}), snapshot: state }
  }
  return {
    status(credential) {
      return {
        registry: { origin: registryOrigin, authorization: registry.authorizationStatus() },
        model: { provider: model.provider, id: model.model, credential, online_verified: false },
        operation: activity, ...(current ? { current_session: current.handle } : {}), limitations: [...limitations],
      }
    },
    async sessions(raw) {
      const input = z.strictObject({ limit: z.number().int().min(1).max(20).default(10), cursor: z.string().optional() }).parse(raw)
      const after = input.cursor ? cursors.get(input.cursor) : undefined
      if (input.cursor && !after) fail('cursor_expired')
      return operation('resume', async (signal) => {
        const page = await listRecords({ limit: input.limit, ...(after ? { after } : {}), signal }); signal.throwIfAborted()
        return { items: page.records.map((record) => {
          const projection = record.projection
          const state = record.error ? 'unreadable' as const : projection?.pending || projection?.pending_turn ? 'interrupted' as const : projection?.current.state.stopped ? 'stopped' as const : 'ready' as const
          return { record: opaque(record.id, recordHandles, records), created_at: new Date(record.createdAt).toISOString(), state,
            ...(projection ? { work: work(projection.log.input.artifact,
              projection.current.turn.locale ?? projection.log.input.profile.locale
                ?? projection.log.input.artifact.meta.default_locale) } : {}),
            ...(record.error ? { error_code: record.error } : {}),
          }
        }), ...(page.after ? { next_cursor: opaque(page.after, cursorHandles, cursors) } : {}) }
      })
    },
    async resume(raw) {
      const input = z.strictObject({ record: z.string(), restart: z.boolean() }).parse(raw)
      const id = records.get(input.record); if (!id) fail('record_unknown')
      return operation('resume', async (signal) => {
        if (current && current.id !== id && !input.restart) fail('restart_confirmation_required')
        const authorization = registry.authorizationVersion()
        const projection = await runtime.inspect(id); signal.throwIfAborted()
        const artifact = projection.log.input.artifact
        if (artifact.kind !== 'content' || !artifact.story) fail('story_required')
        const source = artifact.root
        if ('origin' in source && source.origin.kind !== 'draft-build') fail('local_source_unsupported')
        const value = 'release' in source ? await registry.release(source, signal) : source.origin.kind === 'draft-build' ? await registry.draftBuild(source.origin.build_id, signal) : fail('local_source_unsupported')
        signal.throwIfAborted(); available(value)
        if (authorization !== registry.authorizationVersion()) fail('authorization_changed')
        if (digestExactJSON(value.artifact) !== digestExactJSON(artifact)) fail('source_mismatch')
        const inputProfile = projection.log.input.profile
        const report = checkCapabilitySupport(artifact.capabilities, support)
        if (report.status === 'unsupported') fail('capability_unsupported')
        if (inputProfile.tokenizer !== 'estimate') fail('tokenizer_unsupported')
        if (!model.maxTokens || model.maxTokens > inputProfile.reserve_for_output) fail('model_output_budget')
        const forParticipant = projection.current.turn.for_participant ?? projection.log.input.for_participant
        const next = { id, handle: current?.id === id && current.epoch === authorization ? current.handle : randomUUID(),
          epoch: authorization, loaded: value, ...(forParticipant ? { for_participant: forParticipant } : {}),
        }
        const output = snapshot(next, projection)
        current = next; review = undefined; exportReview = undefined
        return output
      })
    },
    async session(raw) {
      const { session } = SessionRequest.parse(raw); const selected = checkedSession(session); available(selected.loaded)
      return operation('resume', async (signal) => { const projection = await runtime.inspect(selected.id); signal.throwIfAborted(); checkedSession(session); return snapshot(selected, projection) }, session)
    },
    async review(raw) {
      return operation('review', async (signal) => {
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
        review = digestExactJSON({ intent, artifact, authorization }); exportReview = undefined
        const readable = work(artifact, intent.locale, 'label' in value.receipt ? value.receipt.label : undefined)
        return { review, work: readable, source: artifact.root, title: readable.title, metadata: artifact.meta,
          capabilities: artifact.capabilities, support: report,
          starts: (artifact.story.starts ?? []).map(start => ({
            id: start.id, title: display(start.title, intent.locale, artifact.meta.default_locale),
            ...(start.description ? { description: display(start.description, intent.locale, artifact.meta.default_locale) } : {}),
          })),
          participants: artifact.ir.participants.map(({ key, display_name, cast_key }) => ({
            key, display_name: display(display_name, intent.locale, artifact.meta.default_locale), ...(cast_key ? { cast_key } : {}),
          })),
          late_slots: artifact.ir.late_slots, locale: intent.locale, ...(intent.start ? { start: intent.start } : {}), view: intent.view,
          restart_required: current !== undefined, ...(current ? { previous_source: current.loaded.artifact.root } : {}) }
      })
    },
    async start(raw) {
      const input = Start.parse(raw)
      return operation('start', async (signal) => {
        const selected = checkedReview()
        if (input.review !== selected.review) fail('review_changed')
        if (current && !input.restart) fail('restart_confirmation_required')
        const artifact = selected.loaded.artifact
        if (artifact.kind !== 'content') fail('content_required')
        const runtimeProfile = profile(selected.loaded, selected.launch)
        const forParticipant = runtimeProfile.mode === 'per-agent' ? input.for_participant ?? (selected.launch.view.mode === 'per-agent' ? selected.launch.view.for_participant : undefined) : undefined
        if (forParticipant && !artifact.ir.participants.some(participant => participant.key === forParticipant)) fail('participant_unknown')
        const opening = input.start ?? selected.launch.start
        if (opening !== undefined && !artifact.story?.starts?.some(start => start.id === opening)) fail('start_unknown')
        if (runtimeProfile.mode === 'per-agent' && !forParticipant) fail('participant_required')
        const started = startSession({ artifact, bindings: input.bindings, locale: selected.launch.locale,
          ...(opening === undefined ? {} : { start: opening }),
        })
        const turn = { ...started.turn, ...(forParticipant === undefined ? {} : { for_participant: forParticipant }) }
        const preparation = { artifact, profile: runtimeProfile, turn, counter: estimateCounter }
        const catalog = createPreparationCatalog(preparation, false); const plan = noneSelection(catalog)
        const texts = await registry.sourceTexts(selected.loaded, { ...preparation, plan }, signal)
        signal.throwIfAborted(); checkedReview()
        const id = SessionId(randomUUID())
        const replay: ReplayInput = { artifact, profile: runtimeProfile, support, bindings: input.bindings,
          source_texts: texts, locale: selected.launch.locale,
          ...(opening === undefined ? {} : { start: opening }),
          ...(forParticipant === undefined ? {} : { for_participant: forParticipant }),
        }
        const projection = await runtime.create(id, replay, signal)
        const next = { handle: randomUUID(), epoch, id, loaded: selected.loaded,
          ...(forParticipant === undefined ? {} : { for_participant: forParticipant }),
        }
        const output = snapshot(next, projection)
        current = next; exportReview = undefined
        return output
      })
    },
    turn(raw) {
      const input = Turn.parse(raw); const selected = checkedSession(input.session)
      const digest = digestExactJSON(input)
      if (turnPending && turnPending.session === input.session && turnPending.id === input.request_id) {
        if (digest !== turnPending.digest) fail('request_conflict')
        return turnPending.promise
      }
      const promise = operation('turn', async (signal) => {
        available(selected.loaded)
        const before = await runtime.inspect(selected.id); signal.throwIfAborted(); checkedSession(input.session)
        if ((before.pending || before.pending_turn) && !input.recover_interrupted) fail('interrupted_request')
        if (before.pending?.command.id === commandId(`app-input:${input.request_id}`)) fail('interrupted_retry_forbidden')
        if (play) {
          if (!input.expected_revision) fail('revision_required')
          const player = resolveStoryPlayer(before.log.input.artifact)
          await runtime.play(selected.id, { id: commandId(`app-input:${input.request_id}`), text: input.text,
            expected_revision: input.expected_revision,
            ...(input.choice_id ? { choice_id: input.choice_id } : {}),
            ...(input.confirm_ending ? { confirm_ending: input.confirm_ending } : {}),
            ...(input.recover_interrupted ? { recover_interrupted: true as const } : {}),
            ...(player ? { speaker: player.participant } : {}),
            ...(selected.for_participant === undefined ? {} : { for_participant: selected.for_participant }),
          }, play, signal)
        } else {
          if (input.confirm_ending) fail('ending_confirmation_unavailable')
          await runtime.submit(selected.id, { id: commandId(`app-input:${input.request_id}`), operation: { kind: 'input', text: input.text }, ...(selected.for_participant === undefined ? {} : { for_participant: selected.for_participant }) }, model, signal)
        }
        const projection = await runtime.inspect(selected.id); checkedSession(input.session); exportReview = undefined
        const outcome = result(selected, projection, input.request_id)
        if (outcome.status === 'sending' || outcome.status === 'not_found') fail('request_missing')
        return outcome
      }, input.session, input.request_id).finally(() => { if (turnPending?.promise === promise) turnPending = undefined })
      turnPending = { session: input.session, id: input.request_id, digest, promise }
      return promise
    },
    async turnStatus(raw) {
      const input = RequestIdentity.parse(raw); const selected = checkedSession(input.session)
      if (turnPending?.session === input.session && turnPending.id === input.request_id) return { request_id: input.request_id, status: 'sending' }
      return operation('resume', async (signal) => { const projection = await runtime.inspect(selected.id); signal.throwIfAborted(); checkedSession(input.session); return result(selected, projection, input.request_id) }, input.session)
    },
    async rewind(raw) {
      const input = RequestIdentity.extend({ expected_revision: z.string().min(1) }).parse(raw)
      const selected = checkedSession(input.session)
      if (!play) fail('rewind_unavailable')
      return operation('rewind', async (signal) => {
        available(selected.loaded)
        await runtime.rewind(selected.id, { id: commandId(`app-rewind:${input.request_id}`), expected_revision: input.expected_revision }, signal)
        checkedSession(input.session)
        const restored = await runtime.inspect(selected.id)
        const next = { ...selected, handle: randomUUID() }
        current = next; exportReview = undefined
        return snapshot(next, restored)
      }, input.session, input.request_id)
    },
    cancel(raw) {
      const input = z.strictObject({ session: z.string().optional(), request_id: RequestID.optional() }).parse(raw)
      if (input.session !== activity?.session || (input.session !== undefined && current?.handle !== input.session)) fail('stale_session')
      if (input.request_id !== activity?.request_id) fail('stale_request')
      active?.abort(new Error('roleplay_app.cancelled'))
    },
    async prepareExport(raw) {
      const input = Synthetic.parse(raw)
      return operation('export', async (signal) => { const selected = checkedSession(input.session)
        exportReview = await exports.prepare({ session: selected.id, history: input.history, bindings: input.bindings,
          ...(selected.for_participant === undefined ? {} : { for_participant: selected.for_participant }),
        }, signal)
        checkedSession(input.session)
        return { digest: exportReview.digest, payload: exportReview.payload }
      }, input.session)
    },
    async export(raw) {
      const { digest, session } = SessionRequest.extend({ digest: z.string() }).parse(raw)
      return operation('export', async (signal) => { checkedSession(session); if (!exportReview) fail('export_review_required'); return exports.export(exportReview, { candidate_digest: digest }, signal) }, session)
    },
    async dispose() { closed = true; active?.abort(new Error('roleplay_app.closed')); await pending?.catch(() => undefined) },
  }
}
