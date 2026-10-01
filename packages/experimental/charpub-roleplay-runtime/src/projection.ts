/** Pure roleplay log replay and one text-message mapping. No surface or mutable Session cache. */
import { CharError, digestExactJSON } from '@char-pub/core'
import {
  appendCommand, commandId, createReplay, replay,
  type ReplayCommand, type ReplayInput, type ReplayLog, type ReplayStep,
} from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import {
  assembleAssistantStream, expandAssistantStream, lastAssistantStreamChunk,
  type LlmCallConfig, type Message, type MessageId,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  RoleplayOpenedSchema, RoleplayRequestedSchema, RoleplaySettledSchema, RoleplayRequestId,
  type RoleplayOpened, type RoleplayRequested, type RoleplaySettled, type RequestId, type SettlementOutcome, type RoleplayCallConfig,
} from './events.ts'

const RESPONSE_ID_PREFIX = 'roleplay.response:'
/** Recomputed values only; the caller persists Session events rather than this object. */
export interface RoleplayProjection {
  log: ReplayLog
  current: ReplayStep
  head: string
  pending: RoleplayRequested | null
  requests: Map<RequestId, RoleplayRequested>
  settlements: Map<RequestId, RoleplaySettled>
}
function fail(code: string, subject: string): never {
  throw new CharError({ code: `roleplay.${code}`, subject })
}
function callConfig(config: RoleplayCallConfig): LlmCallConfig {
  return {
    provider: config.provider, model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    ...(config.stop === undefined ? {} : { stop: config.stop }),
  }
}
function fromLog(log: ReplayLog): Pick<RoleplayProjection, 'log' | 'current' | 'head'> {
  return { log, current: replay(log).current, head: log.head_digest }
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
export function makeRequested(
  projection: RoleplayProjection, id: string, command: ReplayCommand, config: LlmCallConfig, proposedConfig: LlmCallConfig = config,
): RoleplayRequested {
  if (projection.current.state.stopped) fail('session_stopped', projection.head)
  if (projection.pending) fail('request_pending', projection.pending.id)
  const requestId = RoleplayRequestId(id)
  if (projection.requests.has(requestId)) fail('request_reused', id)
  if (command.id.startsWith(RESPONSE_ID_PREFIX) || command.operation.kind === 'response') fail('reserved_command', command.id)
  if ([...projection.requests.values()].some(request => request.command.id === command.id)) fail('command_reused', command.id)
  const candidate = appendCommand(projection.log, command)
  const prepared = replay(candidate).current
  if (digestExactJSON(prepared.turn) !== digestExactJSON(prepared.prepared_turn)) fail('request_not_prepared', id)
  const messages = prepared.assembly.messages.map((message) => {
    if (message.attachments?.length) fail('unsupported_message', 'attachments')
    return { role: message.role, content: message.content, source: [...message.source] }
  })
  const fields = {
    id: requestId, parent_head: projection.head, command, config, proposed_config: proposedConfig, messages,
    plan_digest: digestExactJSON(prepared.plan), state_digest: digestExactJSON(prepared.state), turn_digest: digestExactJSON(prepared.turn),
  }
  return RoleplayRequestedSchema.parse({ ...fields, request_digest: digestExactJSON(fields) })
}

/**
 * Map recorded SDK messages to stable DSH text messages without adding or merging content.
 * @param requested - A validated requested event from projectRoleplay or makeRequested.
 * @returns Messages in exact role/content order; historical assistant source metadata is explicitly synthetic.
 */
export function requestMessages(requested: RoleplayRequested): Message[] {
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
  const candidate = appendCommand(projection.log, pending.command)
  const artifact = input.artifact
  const view = pending.command.for_participant
  if (input.profile.mode === 'per-agent') {
    const expected = artifact.kind === 'content' && view ? artifact.story_refs?.participants[view] ?? view : undefined
    if (outcome.assistant.speaker !== expected) fail('speaker_mismatch', pending.id)
  }
  return appendCommand(candidate, {
    id: commandId(`${RESPONSE_ID_PREFIX}${pending.id}`),
    operation: { kind: 'response', ...outcome.assistant },
  })
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
  const committed = replay(log).current
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
  for (const event of events) {
    if (event.type === 'roleplay/opened') {
      if (projection) fail('duplicate_opening', String(event.seq))
      const opened = RoleplayOpenedSchema.parse(event.data)
      const log = createReplay(opened.input)
      if (log.head_digest !== opened.head) fail('event_mismatch', 'opening')
      projection = { ...fromLog(log), pending: null, requests: new Map(), settlements: new Map() }
    } else if (event.type === 'roleplay/requested') {
      if (!projection) fail('opening_missing', String(event.seq))
      const requested = RoleplayRequestedSchema.parse(event.data)
      const expected = makeRequested(
        projection, requested.id, requested.command, callConfig(requested.config), callConfig(requested.proposed_config),
      )
      if (digestExactJSON(requested) !== digestExactJSON(expected)) fail('event_mismatch', requested.id)
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
      }
      projection.settlements.set(settled.id, settled)
      projection.pending = null
    }
  }
  if (!projection) fail('opening_missing', 'events')
  return projection
}
