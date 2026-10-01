/** Offline Story command replay. char.pub owns all content, condition and message semantics. */
import {
  CharError, CreationArtifactSchema, RuntimeProfileSchema, SessionSchema, TurnViewSchema,
  CatalogRefSchema, SelectionPlanSchema, RuntimeCapabilitySupportSchema,
  checkCapabilitySupport, confirm, enterScene, setPresent, toTurnStory, digestExactJSON,
} from '@char-pub/core'
import type { StoryState, TurnView, CapabilitySupportReport } from '@char-pub/core'
import {
  startSession, prepareContext, createPreparationCatalog, fixedSelection, noneSelection,
  estimateCounter, digestAssemblyMessages, validateSelectionPlan,
} from '@char-pub/assembler'
import type { AssembleResult, PreparationInput } from '@char-pub/assembler'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { DecisionRecordSchema } from './decision-record.ts'
export { DecisionRecordSchema, makeDecisionRecord } from './decision-record.ts'
export type { DecisionRecord, DecisionRecordInput } from './decision-record.ts'
export * from './jev.ts'
export * from './laya.ts'

/** Caller-owned idempotency key within one replay log. */
export type CommandId = Branded<'RoleplayCommandId'>

/**
 * Validate an external command ID before using it in this log.
 * @param value - Nonempty caller-assigned identifier.
 * @returns The branded identifier; invalid strings throw a Zod error.
 */
export function commandId(value: string): CommandId {
  return brandString<CommandId>(z.string().min(1).parse(value))
}

/** Validates one explicit Story operation and its fixed or evidenced decisions. */
const CommandSchema = z.strictObject({
  id: z.string().min(1).transform(commandId),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('confirm'), target: z.string().min(1) }),
    z.strictObject({ kind: z.literal('enter-scene'), scene: z.string().min(1) }),
    z.strictObject({ kind: z.literal('set-present'), present: z.array(z.string()) }),
    z.strictObject({ kind: z.literal('input'), text: z.string().min(1) }),
    z.strictObject({ kind: z.literal('response'), text: z.string(), speaker: z.string().optional() }),
    z.strictObject({ kind: z.literal('prepare') }),
  ]),
  judgments: TurnViewSchema.shape.judgments,
  selection: z.array(CatalogRefSchema).optional(),
  plan: SelectionPlanSchema.optional(),
  evidence: z.array(DecisionRecordSchema).optional(),
  for_participant: z.string().optional(),
}).refine(command => command.selection === undefined || command.plan === undefined, 'Use selection refs or a complete Plan, not both')

/** Fixed decisions supplied by the caller; this package does not infer player intent. */
export type ReplayCommand = z.infer<typeof CommandSchema>

/** Validates the complete fixed SDK input retained by replay and Session opened events. */
const InputSchema = z.strictObject({
  artifact: CreationArtifactSchema,
  profile: RuntimeProfileSchema,
  bindings: SessionSchema.shape.bindings,
  start: z.string().optional(),
  locale: SessionSchema.shape.locale,
  judgments: TurnViewSchema.shape.judgments,
  support: RuntimeCapabilitySupportSchema,
  for_participant: z.string().optional(),
  source_texts: z.record(z.string(), z.string()),
})

export { InputSchema as ReplayInputSchema, CommandSchema as ReplayCommandSchema }

/** Complete immutable inputs needed to reproduce an offline exercise. Source bodies stay local. */
export type ReplayInput = z.infer<typeof InputSchema>

const EntrySchema = z.strictObject({
  command: CommandSchema,
  previous: z.string(),
  state_digest: z.string(),
  turn_digest: z.string(),
  prepared_turn_digest: z.string(),
  plan: SelectionPlanSchema,
  messages_digest: z.string(),
  digest: z.string(),
})
const LogSchema = z.strictObject({
  version: z.literal(2),
  input: InputSchema,
  initial_digest: z.string(),
  head_digest: z.string(),
  entries: z.array(EntrySchema),
})

/** Portable exercise data, not a DeepSeek Harness Session or persistence format. */
export type ReplayLog = z.infer<typeof LogSchema>

/** Recomputed state and actual model messages for one exercise step. */
export interface ReplayStep {
  state: StoryState
  turn: TurnView
  /** Input associated with the latest preparation; response-only steps update turn without reassembly. */
  prepared_turn: TurnView
  plan: z.infer<typeof SelectionPlanSchema>
  assembly: AssembleResult
}

/** Replay evidence, including actual messages rather than only hashes. */
export interface ReplayResult {
  initial: ReplayStep
  steps: ReplayStep[]
  current: ReplayStep
  support: CapabilitySupportReport
  digest: string
}

function fail(code: string, subject: string): never {
  throw new CharError({ code: `roleplay.${code}`, subject })
}

function initialize(input: ReplayInput): { state: StoryState; turn: TurnView; support: CapabilitySupportReport } {
  const artifact = input.artifact
  if (artifact.kind !== 'content' || !artifact.story || !artifact.story_refs)
    fail('story_required', artifact.root.ref)
  if (input.judgments?.some(judgment => !['fixed', 'manual'].includes(judgment.provider.name)))
    fail('initial_judgment_evidence_unavailable', 'judgments')
  const support = checkCapabilitySupport(artifact.capabilities, input.support)
  if (support.status === 'unsupported') fail('unsupported_capabilities', support.missing.map(item => item.id).join(','))
  if (input.profile.tokenizer !== estimateCounter.tokenizer)
    fail('tokenizer_unsupported', input.profile.tokenizer)
  const locale = input.locale ?? input.profile.locale
  const started = startSession({ artifact, bindings: input.bindings,
    ...(input.start === undefined ? {} : { start: input.start }),
    ...(locale === undefined ? {} : { locale }),
    ...(input.judgments === undefined ? {} : { judgments: input.judgments }),
  })
  const { story, scene, present } = started.turn
  if (!story || scene === undefined || !present) fail('story_state_missing', artifact.root.ref)
  return {
    state: { ...story, scene, present },
    turn: { ...started.turn, ...(input.for_participant === undefined ? {} : { for_participant: input.for_participant }) },
    support,
  }
}

function preparation(input: ReplayInput, state: StoryState, turn: TurnView, command?: ReplayCommand) {
  return {
    artifact: input.artifact, profile: input.profile, counter: estimateCounter,
    turn: {
      ...turn, scene: state.scene, present: state.present, story: toTurnStory(state),
      ...(command?.for_participant === undefined ? {} : { for_participant: command.for_participant }),
      judgments: command === undefined ? input.judgments ?? [] : command.judgments ?? [],
    },
  }
}

function prepare(input: ReplayInput, state: StoryState, turn: TurnView, command?: ReplayCommand): ReplayStep {
  const base = preparation(input, state, turn, command)
  const build = createPreparationCatalog(base, command?.plan?.discovery ?? (command?.selection?.length ?? 0) > 0)
  const plan = command?.plan ? validateSelectionPlan(build, command.plan)
    : command?.selection?.length ? fixedSelection(build, command.selection) : noneSelection(build)
  const assembly = prepareContext({ ...base, plan, source_texts: input.source_texts })
  return { state, turn: base.turn, prepared_turn: base.turn, plan, assembly }
}

function withoutPriorView(turn: TurnView): TurnView {
  const { for_participant: _previousView, ...withoutView } = turn
  return withoutView
}

function project(input: ReplayInput, current: ReplayStep, command: ReplayCommand): { state: StoryState; turn: TurnView } {
  const artifact = input.artifact
  if (artifact.kind !== 'content' || !artifact.story || !artifact.story_refs)
    fail('story_required', artifact.root.ref)
  const cast = Object.keys(artifact.story_refs.participants)
  let state = current.state
  let turn = current.turn
  const op = command.operation
  switch (op.kind) {
    case 'confirm': state = confirm(artifact.story, cast, state, op.target, command.judgments); break
    case 'enter-scene': state = enterScene(artifact.story, cast, state, op.scene, command.judgments); break
    case 'set-present': state = setPresent(artifact.story, cast, state, op.present); break
    case 'input': turn = { ...turn, history: [...turn.history, { role: 'user', text: op.text }] }; break
    case 'response':
      if (op.speaker !== undefined && !artifact.ir.participants.some(participant => participant.key === op.speaker))
        fail('speaker_missing', op.speaker)
      turn = { ...turn, history: [...turn.history, { role: 'assistant', text: op.text,
        ...(op.speaker === undefined ? {} : { speaker: op.speaker }) }] }
      break
    case 'prepare': break
    default: assertNever(op)
  }
  return { state, turn: withoutPriorView(turn) }
}

function beforePreparation(input: ReplayInput, current: ReplayStep, command: ReplayCommand) {
  return preparation(input, current.state, withoutPriorView(current.turn), { ...command, judgments: [] })
}

function checkEvidence(input: ReplayInput, current: ReplayStep, command: ReplayCommand, result: ReplayStep): void {
  let selectorSeen = false
  const judged = new Set<string>()
  for (const record of command.evidence ?? []) {
    if (record.purpose === 'selector') {
      if (selectorSeen) fail('evidence_mismatch', 'duplicate selector evidence')
      selectorSeen = true
      if (digestExactJSON(record.input) !== digestExactJSON(result.plan.input)
        || record.binding.plan_digest !== digestExactJSON(result.plan)
        || record.provider.name !== result.plan.selector.name
        || record.provider.version !== result.plan.selector.version
        || digestExactJSON(record.config) !== result.plan.selector.config_digest)
        fail('evidence_mismatch', 'selector')
    } else {
      const before = createPreparationCatalog(beforePreparation(input, current, command), false)
      if (digestExactJSON(record.input) !== digestExactJSON(before.input)) fail('evidence_mismatch', 'judge input')
      for (const judgment of record.binding.judgments) {
        const key = `${judgment.target}#${judgment.path}`
        if (judged.has(key)
          || judgment.provider.name !== record.provider.name || judgment.provider.version !== record.provider.version
          || !(command.judgments ?? []).some(item => digestExactJSON(item) === digestExactJSON(judgment)))
          fail('evidence_mismatch', key)
        judged.add(key)
      }
    }
  }
  if (!['fixed', 'none'].includes(result.plan.selector.name) && !selectorSeen)
    fail('evidence_required', 'selector')
  for (const judgment of command.judgments ?? []) {
    if (!['fixed', 'manual'].includes(judgment.provider.name) && !judged.has(`${judgment.target}#${judgment.path}`))
      fail('evidence_required', `${judgment.target}#${judgment.path}`)
  }
}

function step(input: ReplayInput, current: ReplayStep, command: ReplayCommand): ReplayStep {
  const projected = project(input, current, command)
  if (command.operation.kind === 'response') {
    if (command.plan || command.selection?.length || command.judgments?.length || command.evidence?.length)
      fail('response_decisions_forbidden', command.id)
    return { ...current, state: projected.state, turn: TurnViewSchema.parse(projected.turn) }
  }
  const result = prepare(input, projected.state, projected.turn, command)
  checkEvidence(input, current, command, result)
  return result
}

/**
 * Prepare a prospective command for a trusted decision adapter, without changing the log.
 * @param log - Existing offline log; replay validates its current state.
 * @param command - Candidate command, including an explicit per-agent view when needed.
 * @param phase - Before for judging the operation; after for selecting the resulting context.
 * @returns Trusted engine input. Send only selectorCatalog/selectorView projections to a provider, never this object.
 */
export function commandPreparation(log: ReplayLog, command: ReplayCommand, phase: 'before' | 'after' = 'after'): PreparationInput {
  const current = replay(log).current
  const parsed = CommandSchema.parse(command)
  if (phase === 'before') return beforePreparation(log.input, current, parsed)
  const projected = project(log.input, current, parsed)
  return preparation(log.input, projected.state, projected.turn, parsed)
}

function entry(previous: string, command: ReplayCommand, result: ReplayStep): ReplayLog['entries'][number] {
  const value = {
    command, previous, state_digest: digestExactJSON(result.state), turn_digest: digestExactJSON(result.turn),
    prepared_turn_digest: digestExactJSON(result.prepared_turn),
    plan: result.plan, messages_digest: digestAssemblyMessages(result.assembly.messages),
  }
  return { ...value, digest: digestExactJSON(value) }
}

/**
 * Create a detached offline log from validated SDK inputs; no file or model IO occurs.
 * @param value - Artifact with its build origin, explicit profile/support, bindings and verified-source candidates.
 * @returns A fresh exercise log. Unsupported capabilities, invalid Story or unavailable required source text throw.
 */
export function createReplay(value: ReplayInput): ReplayLog {
  const input = InputSchema.parse(value)
  const initialized = initialize(input)
  const initial = prepare(input, initialized.state, initialized.turn)
  const initialDigest = digestExactJSON({ input, state: initial.state, turn: initial.turn, plan: initial.plan,
    messages_digest: digestAssemblyMessages(initial.assembly.messages) })
  return { version: 2, input, initial_digest: initialDigest, head_digest: initialDigest, entries: [] }
}

/**
 * Parse and recompute every event, rejecting changed inputs, operations, state hashes or Plans.
 * @param value - An exercise log, including one loaded from JSON.
 * @returns Every reconstructed state, Plan and actual message sequence. Hashes detect edits, not a malicious author's complete rewrite.
 */
export function replay(value: unknown): ReplayResult {
  const log = LogSchema.parse(value)
  const initialized = initialize(log.input)
  const initial = prepare(log.input, initialized.state, initialized.turn)
  const initialDigest = digestExactJSON({ input: log.input, state: initial.state, turn: initial.turn, plan: initial.plan,
    messages_digest: digestAssemblyMessages(initial.assembly.messages) })
  if (initialDigest !== log.initial_digest) fail('replay_mismatch', 'initial')
  let current = initial
  let previous: string = initialDigest
  const steps: ReplayStep[] = []
  const seen = new Set<CommandId>()
  for (const recorded of log.entries) {
    if (seen.has(recorded.command.id)) fail('duplicate_record', recorded.command.id)
    seen.add(recorded.command.id)
    current = step(log.input, current, recorded.command)
    const computed = entry(previous, recorded.command, current)
    if (digestExactJSON(computed) !== digestExactJSON(recorded)) fail('replay_mismatch', recorded.command.id)
    previous = computed.digest
    steps.push(current)
  }
  if (previous !== log.head_digest) fail('replay_mismatch', 'head')
  return { initial, steps, current, support: initialized.support, digest: previous }
}

/**
 * Atomically return one appended log; errors or cancellation never mutate the caller's log.
 * @param log - Existing exercise data; it is replayed before accepting a command.
 * @param command - Caller-owned ID and fixed decisions. Exact retries are idempotent; changed reuse throws.
 * @param options - Optional cancellation signal, checked before replay and before returning the new value.
 * @returns Detached log with one extra entry, or the unchanged log for an exact retry.
 * Synchronous computation cannot be interrupted between event-loop turns.
 */
export function appendCommand(log: ReplayLog, command: ReplayCommand, options: { signal?: AbortSignal } = {}): ReplayLog {
  options.signal?.throwIfAborted()
  const current = replay(log)
  const parsed = CommandSchema.parse(command)
  const previous = log.entries.find(item => item.command.id === parsed.id)
  if (previous) {
    if (digestExactJSON(previous.command) !== digestExactJSON(parsed)) fail('command_conflict', parsed.id)
    options.signal?.throwIfAborted()
    return log
  }
  const result = step(log.input, current.current, parsed)
  const next = entry(current.digest, parsed, result)
  options.signal?.throwIfAborted()
  return { ...structuredClone(log), head_digest: next.digest, entries: [...structuredClone(log.entries), next] }
}
