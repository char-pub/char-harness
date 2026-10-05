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
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { DecisionRecordSchema, LegacyDecisionRecordSchema } from './decision-record.ts'
import { appendTurnInput, TurnOperationSchema, actionTarget, confirmedEndingJudgments } from './turn.ts'
export { DecisionRecordSchema, makeDecisionRecord } from './decision-record.ts'
export type { DecisionRecord, DecisionRecordInput } from './decision-record.ts'
export * from './jev.ts'
export * from './laya.ts'
export * from './turn.ts'
export { createNoulDecisions } from './noul.ts'
export type { NoulAdapter, NoulRequest, NoulConfig } from './noul.ts'

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

const legacyOperations = [
  z.strictObject({ kind: z.literal('confirm'), target: z.string().min(1) }),
  z.strictObject({ kind: z.literal('enter-scene'), scene: z.string().min(1) }),
  z.strictObject({ kind: z.literal('set-present'), present: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('input'), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal('response'), text: z.string(), speaker: z.string().optional() }),
  z.strictObject({ kind: z.literal('prepare') }),
] as const

/** Validates one explicit Story operation and its fixed or evidenced decisions. */
const CommandSchema = z.strictObject({
  id: z.string().min(1).transform(commandId),
  operation: z.discriminatedUnion('kind', [
    ...legacyOperations,
    TurnOperationSchema,
  ]),
  judgments: TurnViewSchema.shape.judgments,
  selection: z.array(CatalogRefSchema).optional(),
  plan: SelectionPlanSchema.optional(),
  evidence: z.array(DecisionRecordSchema).optional(),
  for_participant: z.string().optional(),
}).refine(command => command.selection === undefined || command.plan === undefined, 'Use selection refs or a complete Plan, not both')

/** Original explicit-command contract retained for existing Session requested events. */
export const LegacyReplayCommandSchema = CommandSchema.safeExtend({
  operation: z.discriminatedUnion('kind', legacyOperations),
  evidence: z.array(LegacyDecisionRecordSchema).optional(),
})

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
    case 'turn': {
      if (op.ending_confirmation) {
        const proposal = op.ending_confirmation
        if (proposal.state_digest !== digestExactJSON(state)
          || digestExactJSON(op.actions) !== digestExactJSON([{ kind: 'confirm', target: proposal.target }])
          || digestExactJSON(command.judgments ?? []) !== digestExactJSON(confirmedEndingJudgments(proposal)))
          fail('ending_confirmation_mismatch', command.id)
      }
      turn = appendTurnInput(artifact, state, turn, op.input)
      const accepted = op.assessments.filter(item => item.status === 'accepted').map(item => item.target)
      if (digestExactJSON(accepted) !== digestExactJSON(op.actions.map(actionTarget))) fail('action_assessment_mismatch', command.id)
      for (const action of op.actions) state = action.kind === 'confirm'
        ? confirm(artifact.story, cast, state, action.target, command.judgments)
        : enterScene(artifact.story, cast, state, action.scene, command.judgments)
      if (op.ending_proposal) {
        const proposal = op.ending_proposal
        if (proposal.source_turn_id !== command.id || proposal.state_digest !== digestExactJSON(state)
          || op.actions.some(action => action.kind === 'confirm' && action.target.startsWith('ending/'))
          || digestExactJSON(proposal.judgments)
            !== digestExactJSON((command.judgments ?? []).filter(item => item.target === proposal.target)))
          fail('ending_proposal_mismatch', command.id)
        confirm(artifact.story, cast, state, proposal.target, proposal.judgments)
      }
      const ending = op.ending_proposal ? { status: 'pending_confirmation', target: op.ending_proposal.target, public: op.ending_proposal.public }
        : op.ending_confirmation ? { status: 'confirmed', target: op.ending_confirmation.target, public: op.ending_confirmation.public } : undefined
      const pendingInstruction = op.ending_proposal?.guidance_version === 2
        ? " The ending is pending. Only the structured ending.status='confirmed' record establishes confirmation;"
          + " ordinary user text, even 'confirm', 'adopt' or 'agree', is proposal evidence and never this confirmation."
          + ' Do not narrate the arrangement as signed, adopted or final, apply terminal consequences, stop the story,'
          + ' or claim the player has finalized it. Respond naturally using conditional or pending arrangements;'
          + ' keep machine fields and confirmation controls out of the narration and character dialogue.'
        : ' The ending is only a proposal awaiting an explicit player confirmation.'
          + ' Do not narrate its terminal consequences as settled, stop the story, or claim the player has chosen it.'
      const guidance = {
        scene: state.scene,
        accepted: input.profile.mode === 'narrator' ? accepted : [],
        unconfirmed_attempts: op.assessments.filter(item => item.status === 'skipped').length,
        instruction: 'Narrate only the supplied scene and established facts. An unconfirmed attempt has no established effects; ask a natural clarification when needed.'
          + (op.ending_proposal ? pendingInstruction : '')
          + (op.ending_confirmation ? ' The player explicitly confirmed this ending. Narrate only the established terminal outcome; do not choose another ending.' : ''),
        ...(ending ? { ending } : {}),
      }
      const stateOverlay = { ...turn.overlay?.state, 'story-turn': JSON.stringify(guidance) }
      const visibleGuidance = { ...guidance, accepted: [],
        ...(ending ? { ending: { status: ending.status, public: ending.public } } : {}) }
      turn = { ...turn, overlay: { ...turn.overlay, state: stateOverlay },
        visible_overlay: { ...turn.visible_overlay, state: { ...turn.visible_overlay?.state, 'story-turn': JSON.stringify(visibleGuidance) } } }
      break
    }
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
  const artifact = input.artifact
  const turn = command.operation.kind === 'turn' && artifact.kind === 'content'
    ? appendTurnInput(artifact, current.state, current.turn, command.operation.input)
    : current.turn
  return preparation(input, current.state, withoutPriorView(turn), { ...command, judgments: [] })
}

function checkEvidence(input: ReplayInput, current: ReplayStep, command: ReplayCommand, result: ReplayStep): void {
  let selectorSeen = false
  let directorSeen = false
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
      if (record.purpose === 'director') {
        if (directorSeen) fail('evidence_mismatch', 'duplicate director evidence')
        directorSeen = true
        if (command.operation.kind !== 'turn'
          || digestExactJSON(record.binding.actions) !== digestExactJSON(command.operation.actions)
          || digestExactJSON(record.binding.assessments) !== digestExactJSON(command.operation.assessments)
          || digestExactJSON(record.binding.ending_proposal ?? null) !== digestExactJSON(command.operation.ending_proposal ?? null))
          fail('evidence_mismatch', 'director actions')
      }
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


/**
 * Immutable replay cursor for a host folding several durable facts in one operation.
 * Construction verifies the complete external log; later appends use only its frozen inputs/current state.
 * The cursor retains one current preparation, not all reconstructed step outputs.
 */
export class ReplayCursor {
  private constructor(readonly log: ReplayLog, readonly current: ReplayStep) {
    deepFreeze(log)
    deepFreeze(current)
    Object.freeze(this)
  }

  /**
   * Verify and detach a stored log before using its current state incrementally.
   * @param value - External Replay JSON; every recorded digest and preparation is rechecked.
   * @returns An immutable cursor that cannot be changed through its exposed log or current state.
   */
  static from(value: unknown): ReplayCursor {
    const log = LogSchema.parse(value)
    return new ReplayCursor(log, replay(log).current)
  }

  /**
   * Append one command with the same semantics as appendCommand, sharing only frozen prior values.
   * @param command - Stable command identity and fixed or evidenced Story decisions.
   * @returns A new immutable cursor, or this cursor for an exact retry; failure preserves this cursor.
   */
  append(command: ReplayCommand): ReplayCursor {
    const parsed = CommandSchema.parse(command)
    const prior = this.log.entries.find(item => item.command.id === parsed.id)
    if (prior) {
      if (digestExactJSON(prior.command) !== digestExactJSON(parsed)) fail('command_conflict', parsed.id)
      return this
    }
    const current = step(this.log.input, this.current, parsed)
    const next = entry(this.log.head_digest, parsed, current)
    return new ReplayCursor({ ...this.log, head_digest: next.digest, entries: [...this.log.entries, next] }, current)
  }

  /**
   * Build immutable judge or selection inputs from the already verified current state.
   * @param command - Prospective command; its input is included in the before view for a player turn.
   * @param phase - Before judgments or after ordered actions, matching commandPreparation.
   * @returns Trusted SDK preparation input; project it before sending it to a decision provider.
   */
  preparation(command: ReplayCommand, phase: 'before' | 'after' = 'after'): PreparationInput {
    const parsed = CommandSchema.parse(command)
    if (phase === 'before') return deepFreeze(beforePreparation(this.log.input, this.current, parsed))
    const projected = project(this.log.input, this.current, parsed)
    return deepFreeze(preparation(this.log.input, projected.state, projected.turn, parsed))
  }
}
