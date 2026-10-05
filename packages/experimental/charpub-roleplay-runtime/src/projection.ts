/** Pure roleplay log replay and one text-message mapping. No surface or mutable Session cache. */
import { CharError, digestExactJSON, type StoryState } from '@char-pub/core'
import type { PreparationInput } from '@char-pub/assembler'
import {
  commandId, createReplay, ReplayCursor,
  type CommandId, type ReplayCommand, type ReplayInput, type ReplayLog, type ReplayStep, type TurnEndingProposal,
} from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import {
  assembleAssistantStream, expandAssistantStream, lastAssistantStreamChunk,
  type LlmCallConfig, type Message, type MessageId,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  RoleplayOpenedSchema, RoleplayRequestedSchema, RoleplayTurnRequestedSchema, RoleplaySettledSchema, RoleplayRequestId,
  RoleplayTurnStartedSchema, RoleplayDecisionRequestedSchema, RoleplayDecisionSettledSchema,
  RoleplayTurnAbortedSchema, RoleplayRewoundSchema,
  type RoleplayOpened, type RoleplayRequest, type RoleplayRequested, type RoleplayTurnRequested, type RoleplaySettled,
  type RequestId, type SettlementOutcome, type RoleplayCallConfig,
  type RoleplayTurnStarted, type RoleplayDecisionRequested, type RoleplayDecisionSettled, type RoleplayTurnAborted,
  type RoleplayRewound, type TurnResolution, type PlayResult,
} from './events.ts'

const cursors = new WeakMap<ReplayLog, ReplayCursor>()
function cursor(log: ReplayLog): ReplayCursor {
  let value = cursors.get(log)
  if (!value) { value = ReplayCursor.from(log); cursors.set(value.log, value) }
  return value
}
function remember(value: ReplayCursor): ReplayLog { cursors.set(value.log, value); return value.log }

/**
 * Prepare a prospective command from this projection's immutable, fully verified replay state.
 * @param projection - A reconstructed Session projection.
 * @param command - One fixed or evidenced command.
 * @param phase - Before judgment or after all proposed actions.
 * @returns Trusted SDK preparation input, never a direct model payload.
 */
export function prepareCommand(
  projection: RoleplayProjection, command: ReplayCommand, phase: 'before' | 'after' = 'after',
): PreparationInput {
  return cursor(projection.log).preparation(command, phase)
}

const RESPONSE_ID_PREFIX = 'roleplay.response:'
interface TurnRecord {
  id: CommandId
  started: RoleplayTurnStarted
  before: ReplayLog
  before_pending_ending: TurnEndingProposal | null
  decisions: Map<number, { requested: RoleplayDecisionRequested; settled?: RoleplayDecisionSettled }>
  command?: ReplayCommand
  finished?: RoleplaySettled | RoleplayTurnAborted
  resolution?: TurnResolution
  superseded: boolean
}
/** Recomputed values only; the caller persists Session events rather than this object. */
export interface RoleplayProjection {
  log: ReplayLog
  current: ReplayStep
  head: string
  /** Binds the entire observed event prefix, including failed attempts and rewinds. */
  revision: string
  pending: RoleplayRequest | null
  pending_turn: TurnRecord | null
  /** A successful turn's terminal proposal; private targets and judgments never belong in player DTOs. */
  pending_ending: TurnEndingProposal | null
  requests: Map<RequestId, RoleplayRequest>
  settlements: Map<RequestId, RoleplaySettled>
  turns: Map<CommandId, TurnRecord>
  rewinds: Map<CommandId, RoleplayRewound>
}
function fail(code: string, subject: string): never {
  throw new CharError({ code: `roleplay.${code}`, subject })
}
/**
 * Omit absent optional fields when passing a recorded route to the live LLM service.
 * @param config - Validated persisted route.
 * @returns The same provider/model/options without explicit undefined properties.
 */
export function roleplayCallConfig(config: RoleplayCallConfig): LlmCallConfig {
  return {
    provider: config.provider, model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    ...(config.stop === undefined ? {} : { stop: config.stop }),
  }
}
function fromLog(log: ReplayLog): Pick<RoleplayProjection, 'log' | 'current' | 'head'> {
  const value = cursor(log)
  return { log: remember(value), current: value.current, head: value.log.head_digest }
}

function resolution(before: StoryState, after: StoryState, command: ReplayCommand | undefined, committed: boolean): TurnResolution {
  const assessments = command?.operation.kind === 'turn' ? command.operation.assessments : []
  return {
    committed,
    actions: assessments.map(item => ({ target: item.target, reason: item.reason,
      status: item.status === 'skipped' ? 'skipped' : committed ? 'applied' : 'uncommitted' })),
    scene: { before: before.scene, after: after.scene },
    variables: Object.entries(after.vars).flatMap(([name, value]) => {
      const prior = before.vars[name]
      return prior !== undefined && digestExactJSON(prior) !== digestExactJSON(value) ? [{ name, before: prior, after: value }] : []
    }),
    knowledge: Object.entries(after.knowing).flatMap(([information, who]) => {
      const learned_by = who.filter(person => !(before.knowing[information] ?? []).includes(person))
      return learned_by.length ? [{ information, learned_by }] : []
    }),
  }
}

/**
 * Read a play outcome without dispatching or reapplying a superseded request.
 * @param projection - Current durable projection.
 * @param id - Original caller request ID.
 * @returns A pending marker, the stored result, or a confirmed absence.
 */
export function lookupPlay(projection: RoleplayProjection, id: string):
  { status: 'not_found' } | { status: 'pending' } | { status: 'settled'; result: PlayResult } {
  const record = projection.turns.get(commandId(id))
  if (!record) return { status: 'not_found' }
  if (!record.finished || !record.resolution) return { status: 'pending' }
  return { status: 'settled', result: { settlement: record.finished, resolution: record.resolution,
    superseded: record.superseded, revision: projection.revision } }
}

/**
 * Find the latest successful play at the active branch head.
 * @param projection - Current durable projection.
 * @returns Whether one append-only rewind is available now.
 */
export function canRewind(projection: RoleplayProjection): boolean {
  return !projection.pending && !projection.pending_turn && [...projection.turns.values()].some(record =>
    !record.superseded && record.finished?.status === 'success' && record.finished.head === projection.head)
}

/**
 * Validate and detach a fresh opening for one durable Session.
 * @param input - Fixed public SDK input and explicit roleplay support declaration.
 * @returns The sole self-contained opening event data, without writing it.
 */
export function makeOpened(input: ReplayInput): RoleplayOpened {
  const log = createReplay(input)
  return RoleplayOpenedSchema.parse({ version: 1, input: log.input, head: log.head_digest })
}

/**
 * Build an exact proposed request without advancing the committed projection.
 * @param projection - Reconstructed committed state with no pending request.
 * @param id - Fresh caller-assigned request ID.
 * @param command - Proposed user/Story action, never an assistant response.
 * @param config - Actual resolved LLM call config returned by prepareCall.
 * @param proposedConfig - Original caller route before provider defaults or model resolution.
 * @returns Request event data ready for durable append and flush before network dispatch.
 */
function makeNarrationRequested(
  projection: RoleplayProjection, id: string, command: ReplayCommand, config: LlmCallConfig, proposedConfig: LlmCallConfig = config,
): RoleplayRequest {
  if (projection.current.state.stopped) fail('session_stopped', projection.head)
  if (projection.pending) fail('request_pending', projection.pending.id)
  const requestId = RoleplayRequestId(id)
  if (projection.requests.has(requestId)) fail('request_reused', id)
  if (command.id.startsWith(RESPONSE_ID_PREFIX) || command.operation.kind === 'response') fail('reserved_command', command.id)
  if ([...projection.requests.values()].some(request => request.command.id === command.id)) fail('command_reused', command.id)
  const candidate = cursor(projection.log).append(command)
  const prepared = candidate.current
  if (digestExactJSON(prepared.turn) !== digestExactJSON(prepared.prepared_turn)) fail('request_not_prepared', id)
  const messages = prepared.assembly.messages.map((message) => {
    if (message.attachments?.length) fail('unsupported_message', 'attachments')
    return { role: message.role, content: message.content, source: [...message.source] }
  })
  const fields = {
    id: requestId, parent_head: projection.head, command, config, proposed_config: proposedConfig, messages,
    plan_digest: digestExactJSON(prepared.plan), state_digest: digestExactJSON(prepared.state), turn_digest: digestExactJSON(prepared.turn),
  }
  const schema = command.operation.kind === 'turn' ? RoleplayTurnRequestedSchema : RoleplayRequestedSchema
  return schema.parse({ ...fields, request_digest: digestExactJSON(fields) })
}

/**
 * Prepare the original explicit-command narration contract for a legacy requested event.
 * @param projection - Current committed state with no pending narration request.
 * @param id - Fresh request identifier.
 * @param command - Legacy explicit operation; atomic turns use makeTurnRequested.
 * @param config - Resolved LLM configuration.
 * @param proposedConfig - Original caller route before provider defaults.
 * @returns A validated legacy request, without advancing committed state.
 */
export function makeRequested(
  projection: RoleplayProjection, id: string, command: ReplayCommand, config: LlmCallConfig, proposedConfig: LlmCallConfig = config,
): RoleplayRequested {
  return RoleplayRequestedSchema.parse(makeNarrationRequested(projection, id, command, config, proposedConfig))
}

/**
 * Prepare the atomic-turn narration contract for a required turn-requested event.
 * @param projection - Current committed state with no pending narration request.
 * @param id - Fresh request identifier.
 * @param command - One atomic player turn with fixed or evidenced actions and selection.
 * @param config - Resolved LLM configuration.
 * @param proposedConfig - Original caller route before provider defaults.
 * @returns A validated turn request, without advancing committed state.
 */
export function makeTurnRequested(
  projection: RoleplayProjection, id: string, command: ReplayCommand, config: LlmCallConfig, proposedConfig: LlmCallConfig = config,
): RoleplayTurnRequested {
  return RoleplayTurnRequestedSchema.parse(makeNarrationRequested(projection, id, command, config, proposedConfig))
}

/**
 * Map recorded SDK messages to stable DSH text messages without adding or merging content.
 * @param requested - Validated model messages and their stable request identifier.
 * @returns Messages in exact role/content order; historical assistant source metadata is explicitly synthetic.
 */
export function requestMessages(requested: Pick<RoleplayRequest, 'messages'> & { id: string }): Message[] {
  return requested.messages.map((message, index): Message => {
    const id = brandString<MessageId>(`roleplay:${requested.id}:${index}`)
    const content = [{ type: 'text' as const, text: message.content }]
    switch (message.role) {
      case 'system': return { id, role: 'system', content, source: { kind: 'system-prompt' } }
      case 'user': return { id, role: 'user', content, source: { kind: 'user' } }
      case 'assistant': return { id, role: 'assistant', content,
        source: { kind: 'model', provider: 'char.pub', model: 'prepared-history' } }
      default: return assertNever(message.role)
    }
  })
}

function settledCandidate(projection: RoleplayProjection, outcome: Extract<SettlementOutcome, { status: 'success' }>): ReplayLog {
  const pending = projection.pending
  if (!pending) fail('request_missing', 'settlement')
  const input = projection.log.input
  const candidate = cursor(projection.log).append(pending.command)
  const artifact = input.artifact
  const view = pending.command.for_participant
  if (input.profile.mode === 'per-agent') {
    const expected = artifact.kind === 'content' && view ? artifact.story_refs?.participants[view] ?? view : undefined
    if (outcome.assistant.speaker !== expected) fail('speaker_mismatch', pending.id)
  }
  return remember(candidate.append({
    id: commandId(`${RESPONSE_ID_PREFIX}${pending.id}`),
    operation: { kind: 'response', ...outcome.assistant },
  }))
}

function checkStream(outcome: SettlementOutcome): void {
  const expanded = expandAssistantStream(outcome.stream)
  const usage = lastAssistantStreamChunk(outcome.stream, 'usage')?.usage
  if (digestExactJSON(usage ?? null) !== digestExactJSON(outcome.usage ?? null)) fail('usage_mismatch', 'settlement')
  if (outcome.status !== 'success') return
  const finishes = expanded.flatMap(({ chunk }, index) => chunk.type === 'finish' ? [index] : [])
  if (finishes.length > 1 || (finishes.length === 1 && finishes[0] !== expanded.length - 1))
    fail('stream_after_finish', 'settlement')
  const finish = lastAssistantStreamChunk(outcome.stream, 'finish')
  if (finish?.reason.kind !== 'stop') fail('incomplete_generation', 'finish')
  if (expanded.some(({ chunk }) => chunk.type === 'tool-call-delta'
    || (chunk.type === 'block-start' && !['text', 'reasoning'].includes(chunk.blockType))
    || (chunk.type === 'block-end' && !['text', 'reasoning'].includes(chunk.block.type))))
    fail('unsupported_message', 'stream')
  const blocks = assembleAssistantStream(outcome.stream).blocks()
  if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) fail('unsupported_message', 'stream')
  const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (!text.trim() || text !== outcome.assistant.text) fail('assistant_mismatch', 'stream')
}

/**
 * Validate stream evidence and compute one settlement without mutating committed state.
 * @param projection - Reconstructed Session with the exact pending requested event.
 * @param outcome - Complete stream and outcome; success text must match the assembled stream.
 * @returns Bound settlement data. Only a durably committed success event advances the projection.
 */
export function makeSettled(projection: RoleplayProjection, outcome: SettlementOutcome): RoleplaySettled {
  const pending = projection.pending
  if (!pending) fail('request_missing', 'settlement')
  checkStream(outcome)
  const fields = { id: pending.id, parent_head: projection.head, request_digest: pending.request_digest,
    config: pending.config, stream: outcome.stream, ...(outcome.usage === undefined ? {} : { usage: outcome.usage }) }
  if (outcome.status !== 'success') return RoleplaySettledSchema.parse({ ...fields, status: outcome.status, reason: outcome.reason })
  const log = settledCandidate(projection, outcome)
  const committed = cursor(log).current
  return RoleplaySettledSchema.parse({ ...fields, status: 'success', assistant: outcome.assistant,
    state: committed.state, turn: committed.turn, head: log.head_digest })
}

/**
 * Derive authoritative Story state and exact pending request from a Session log prefix.
 * @param events - Ordered Session facts, including required roleplay events.
 * @returns Fresh pure projection; malformed, duplicate, mismatched or reordered roleplay data throws.
 */
export function projectRoleplay(events: readonly SessionEvent[]): RoleplayProjection {
  let projection: RoleplayProjection | undefined
  let revision = digestExactJSON('roleplay-event-prefix')
  for (const event of events) {
    if (event.type === 'roleplay/opened') {
      if (projection) fail('duplicate_opening', String(event.seq))
      const opened = RoleplayOpenedSchema.parse(event.data)
      const log = createReplay(opened.input)
      if (log.head_digest !== opened.head) fail('event_mismatch', 'opening')
      projection = { ...fromLog(log), revision, pending: null, pending_turn: null, pending_ending: null,
        requests: new Map(), settlements: new Map(), turns: new Map(), rewinds: new Map() }
    } else if (event.type === 'roleplay/turn-started') {
      if (!projection || projection.pending || projection.pending_turn) fail('turn_pending', String(event.seq))
      const started = RoleplayTurnStartedSchema.parse(event.data)
      const { digest, ...fields } = started
      if (digestExactJSON(fields) !== digest || started.parent_head !== projection.head
        || started.parent_revision !== projection.revision
        || (!started.intent.recover_interrupted && started.intent.expected_revision !== projection.revision))
        fail('event_mismatch', started.intent.id)
      if (projection.turns.has(started.intent.id)
        || [...projection.requests.values()].some(request => request.command.id === started.intent.id)) fail('command_reused', started.intent.id)
      const record: TurnRecord = { id: started.intent.id, started, before: projection.log,
        before_pending_ending: projection.pending_ending, decisions: new Map(), superseded: false }
      projection.turns.set(record.id, record)
      projection.pending_turn = record
    } else if (event.type === 'roleplay/decision-requested') {
      const requested = RoleplayDecisionRequestedSchema.parse(event.data)
      const record = projection?.pending_turn
      if (!record || record.id !== requested.turn_id || projection?.pending) fail('turn_missing', requested.turn_id)
      const { request_digest, ...fields } = requested
      if (digestExactJSON(fields) !== request_digest || requested.index !== record.decisions.size
        || [...record.decisions.values()].some(item => !item.settled)
        || digestExactJSON(requested.proposed_config) !== digestExactJSON(record.started.config.decisions)
        || requested.stage !== (requested.index === 0 ? 'director' : 'selector')) fail('event_mismatch', requested.turn_id)
      if (requested.messages.filter(message => message.role === 'system').length !== 1
        || requested.messages[0]?.role !== 'system') fail('decision_system_layout', requested.turn_id)
      record.decisions.set(requested.index, { requested })
    } else if (event.type === 'roleplay/decision-settled') {
      const settled = RoleplayDecisionSettledSchema.parse(event.data)
      const record = projection?.pending_turn
      const decision = record?.decisions.get(settled.index)
      if (!record || record.id !== settled.turn_id || !decision || decision.settled
        || decision.requested.request_digest !== settled.request_digest) fail('event_mismatch', settled.turn_id)
      checkStream(settled.status === 'success'
        ? { status: 'success', assistant: { text: settled.text }, stream: settled.stream, ...(settled.usage ? { usage: settled.usage } : {}) }
        : { status: settled.status, reason: settled.reason, stream: settled.stream, ...(settled.usage ? { usage: settled.usage } : {}) })
      decision.settled = settled
    } else if (event.type === 'roleplay/turn-aborted') {
      const aborted = RoleplayTurnAbortedSchema.parse(event.data)
      const record = projection?.pending_turn
      if (!projection || !record || record.id !== aborted.id || projection.pending
        || record.started.parent_head !== aborted.parent_head || [...record.decisions.values()].some(item => !item.settled))
        fail('event_mismatch', aborted.id)
      record.finished = aborted
      record.resolution = resolution(cursor(record.before).current.state, projection.current.state, record.command, false)
      projection.pending_turn = null
    } else if (event.type === 'roleplay/rewound') {
      const rewound = RoleplayRewoundSchema.parse(event.data)
      const record = projection?.turns.get(rewound.turn_id)
      if (!projection || !record || !canRewind(projection) || record.superseded
        || record.finished?.status !== 'success' || record.finished.head !== projection.head
        || rewound.parent_head !== projection.head || rewound.parent_revision !== projection.revision
        || rewound.target_head !== record.before.head_digest || projection.rewinds.has(rewound.id)) fail('event_mismatch', rewound.id)
      record.superseded = true
      Object.assign(projection, fromLog(record.before))
      projection.pending_ending = record.before_pending_ending
      projection.rewinds.set(rewound.id, rewound)
    } else if (event.type === 'roleplay/requested' || event.type === 'roleplay/turn-requested') {
      if (!projection) fail('opening_missing', String(event.seq))
      const requested = (event.type === 'roleplay/turn-requested' ? RoleplayTurnRequestedSchema : RoleplayRequestedSchema).parse(event.data)
      const prepareRequest = event.type === 'roleplay/turn-requested' ? makeTurnRequested : makeRequested
      const expected = prepareRequest(
        projection, requested.id, requested.command, roleplayCallConfig(requested.config), roleplayCallConfig(requested.proposed_config),
      )
      if (digestExactJSON(requested) !== digestExactJSON(expected)) fail('event_mismatch', requested.id)
      if (projection.pending_turn) {
        const record = projection.pending_turn
        const command = requested.command
        if (command.id !== record.id || command.operation.kind !== 'turn'
          || [...record.decisions.values()].some(item => !item.settled)) fail('event_mismatch', requested.id)
        const { text, speaker, choice_id, for_participant } = record.started.intent
        const originalInput = { text, ...(speaker ? { speaker } : {}), ...(choice_id ? { choice_id } : {}) }
        if (digestExactJSON(command.operation.input) !== digestExactJSON(originalInput)
          || command.for_participant !== for_participant) fail('event_mismatch', requested.id)
        const proposal = command.operation.ending_proposal
        const confirmation = command.operation.ending_confirmation
        const requestedConfirmation = record.started.intent.confirm_ending
        if (proposal && (requestedConfirmation || proposal.source_turn_id !== record.id
          || proposal.parent_head !== record.started.parent_head || proposal.parent_revision !== record.started.parent_revision
          || proposal.state_digest !== requested.state_digest)) fail('ending_proposal_mismatch', requested.id)
        if (requestedConfirmation) {
          if (!confirmation || !projection.pending_ending || confirmation.id !== requestedConfirmation.proposal_id
            || digestExactJSON(confirmation) !== digestExactJSON(projection.pending_ending) || record.decisions.size !== 0)
            fail('ending_confirmation_mismatch', requested.id)
        } else if (confirmation) fail('ending_confirmation_mismatch', requested.id)
        record.command = command
      }
      projection.requests.set(requested.id, requested)
      projection.pending = requested
    } else if (event.type === 'roleplay/settled') {
      if (!projection?.pending) fail('request_missing', String(event.seq))
      const settled = RoleplaySettledSchema.parse(event.data)
      const outcome: SettlementOutcome = settled.status === 'success'
        ? { status: settled.status, assistant: settled.assistant, stream: settled.stream,
          ...(settled.usage === undefined ? {} : { usage: settled.usage }) }
        : { status: settled.status, reason: settled.reason, stream: settled.stream,
          ...(settled.usage === undefined ? {} : { usage: settled.usage }) }
      const expected = makeSettled(projection, outcome)
      if (digestExactJSON(settled) !== digestExactJSON(expected)) fail('event_mismatch', settled.id)
      if (outcome.status === 'success') {
        const log = settledCandidate(projection, outcome)
        Object.assign(projection, fromLog(log))
        const operation = projection.pending.command.operation
        projection.pending_ending = projection.pending_turn && operation.kind === 'turn' ? operation.ending_proposal ?? null : null
      }
      projection.settlements.set(settled.id, settled)
      if (projection.pending_turn) {
        const record = projection.pending_turn
        record.finished = settled
        record.resolution = resolution(cursor(record.before).current.state, projection.current.state, record.command, settled.status === 'success')
        projection.pending_turn = null
      }
      projection.pending = null
    }
    revision = digestExactJSON({ previous: revision, event })
    if (projection) projection.revision = revision
  }
  if (!projection) fail('opening_missing', 'events')
  return projection
}
