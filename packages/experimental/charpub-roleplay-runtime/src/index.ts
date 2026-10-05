/** Durable roleplay transactions; only the request recorded in the Session log reaches the LLM. */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { CharError, digestExactJSON } from '@char-pub/core'
import { estimateCounter } from '@char-pub/assembler'
import type { ReplayInput, ReplayCommand } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { AssistantStreamAccumulator, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { validateStoredEvents, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { canRewind, lookupPlay, makeOpened, prepareCommand, makeRequested, makeTurnRequested, makeSettled, projectRoleplay, requestMessages, roleplayCallConfig } from './projection.ts'
import type { RoleplayProjection } from './projection.ts'
import {
  PlayConfigSchema, PlayIntentSchema, RoleplayDecisionRequestedSchema, RoleplayRequestedSchema, RoleplayTurnRequestedSchema,
} from './events.ts'
import type {
  RoleplaySettled, RoleplayOpened, RoleplayRequested, RoleplayTurnRequested, RoleplayTurnStarted,
  RoleplayDecisionRequested, RoleplayDecisionSettled,
  RoleplayTurnAborted, RoleplayRewound, PlayIntent, PlayConfig, PlayResult, SettlementOutcome, PreparedTextMessage,
} from './events.ts'
import { preparePlay, prepareEndingConfirmation, type DecisionAnswer } from './director.ts'

type RoleplayFact = { type: 'roleplay/opened'; data: RoleplayOpened }
  | { type: 'roleplay/requested'; data: RoleplayRequested }
  | { type: 'roleplay/settled'; data: RoleplaySettled }
  | { type: 'roleplay/turn-requested'; data: RoleplayTurnRequested }
  | { type: 'roleplay/turn-started'; data: RoleplayTurnStarted }
  | { type: 'roleplay/decision-requested'; data: RoleplayDecisionRequested }
  | { type: 'roleplay/decision-settled'; data: RoleplayDecisionSettled }
  | { type: 'roleplay/turn-aborted'; data: RoleplayTurnAborted }
  | { type: 'roleplay/rewound'; data: RoleplayRewound }

export { createRegistryClient } from './registry/client.ts'
export type { RegistryClient, RegistryClientOptions, LoadedContent, ConfirmedWrite } from './registry/client.ts'

export * from './ending-proposal.ts'
export * from './preview-export.ts'
export * from './story-continuation.ts'
export * from './events.ts'
export * from './projection.ts'

/** Explicit operation and retained-payload limits for this driver. */
export interface Config {
  /** Operation deadline in milliseconds; an active storage commit finishes before close. */
  timeout_ms: number
  /** Maximum UTF-8 JSON bytes of one complete retained Session event. */
  max_event_bytes: number
  /** Maximum total UTF-8 JSON bytes of retained model stream chunks per request. */
  max_stream_bytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { roleplayRuntime: RoleplayRuntime }
}

function failure(code: string, subject: string): never {
  throw new CharError({ code: `roleplay_runtime.${code}`, subject })
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function operationFailure(signal: AbortSignal, error: unknown, fallback: string): string {
  if (signal.aborted) return signal.reason instanceof CharError && signal.reason.code === 'roleplay_runtime.timeout' ? 'timeout' : 'cancelled'
  return error instanceof CharError ? error.code : fallback
}

/** Session-backed one-request driver; it never mounts the coding loop or its prompt assembly. */
export default class RoleplayRuntime extends Service {
  static inject = ['sessions', 'sessionPersistence', 'llm']
  static Config: Schema<Config> = Schema.object({
    timeout_ms: Schema.number().min(1).max(2_147_483_647).step(1).required(),
    max_event_bytes: Schema.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).required(),
    max_stream_bytes: Schema.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).required(),
  })

  /** Validated deployment limits, shared by all operations on this driver. */
  readonly config: Config
  private active = new Map<SessionId, { controller: AbortController; done: Promise<unknown> }>()
  private closing = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'roleplayRuntime')
    this.config = config
    ctx.effect(() => async () => {
      this.closing = true
      for (const operation of this.active.values()) operation.controller.abort(new Error('Roleplay driver disposed'))
      await Promise.allSettled([...this.active.values()].map(operation => operation.done))
    }, 'roleplayRuntime.operations()')
  }

  private async execute<T>(
    id: SessionId, signal: AbortSignal | undefined, action: (operationSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closing) failure('closed', id)
    if (this.active.has(id)) failure('busy', id)
    signal?.throwIfAborted()
    const controller = new AbortController()
    const onAbort = () => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      controller.abort(new CharError({ code: 'roleplay_runtime.timeout', subject: id }))
    }, this.config.timeout_ms)
    const done = Promise.resolve().then(() => action(controller.signal)).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.active.delete(id)
    })
    this.active.set(id, { controller, done })
    return done
  }

  private async persist(handle: SessionHandle, fact: RoleplayFact): Promise<RoleplayProjection> {
    const stored = await handle.read()
    const event: SessionEvent = { ...fact, seq: SessionSeq(stored.events.length), time: Date.now() }
    if (bytes(event) > this.config.max_event_bytes) failure('event_over_budget', event.type)
    const batch = validateStoredEvents(handle.header, [event])
    const projected = projectRoleplay([...stored.events, ...batch])
    // Validate the transition before append; producer errors must not become unreadable durable facts.
    // After append starts, close/flush must establish the storage outcome rather than cancel halfway.
    await handle.append(batch)
    await handle.flush()
    return projected
  }

  /**
   * Create a durable roleplay Session with one validated opening.
   * @param id - Unique stored Session identity; an existing identity is never overwritten.
   * @param input - Exact static artifact and opening inputs.
   * @param signal - Cancels before storage creation starts; an acquired header is completed with its opening.
   * @returns Initial reconstructed state after the durability barrier.
   */
  create(id: SessionId, input: ReplayInput, signal?: AbortSignal): Promise<RoleplayProjection> {
    return this.execute(id, signal, async (operationSignal) => {
      const opened = makeOpened(input)
      operationSignal.throwIfAborted()
      const session = this.ctx.sessions.prepare(id)
      if (bytes({ type: 'roleplay/opened', data: opened, seq: 0, time: Date.now() }) > this.config.max_event_bytes)
        failure('event_over_budget', 'roleplay/opened')
      const handle = await this.ctx.sessionPersistence.create(session.header, { signal: operationSignal })
      try {
        return await this.persist(handle, { type: 'roleplay/opened', data: opened })
      } finally { await handle.close() }
    })
  }

  /**
   * Read committed Story state and any interrupted request without making a model call.
   * @param id - Existing roleplay Session identity.
   * @returns Reconstructed projection; a pending request never advances committed state.
   */
  async inspect(id: SessionId): Promise<RoleplayProjection> {
    const pending = this.active.get(id)
    if (pending) await pending.done
    const handle = await this.ctx.sessionPersistence.open(id, 'read')
    try { return projectRoleplay((await handle.read()).events) }
    finally { await handle.close() }
  }

  /**
   * Persist one exact request, send it once, then atomically record its outcome.
   * @param id - Existing Session; concurrent submissions fail before dispatch.
   * @param command - Fixed or evidenced decisions for the prospective request.
   * @param config - Explicit model route and output limit within the profile's reserved budget.
   * @param signal - Cancels preparation or generation. Once settlement storage starts, its outcome must be reconciled.
   * @returns Durable settlement. Exact retries return the stored outcome without another model call.
   */
  submit(id: SessionId, command: ReplayCommand, config: LlmCallConfig, signal?: AbortSignal): Promise<RoleplaySettled> {
    return this.execute(id, signal, async (operationSignal) => {
      const handle = await this.ctx.sessionPersistence.open(id, 'write', { signal: operationSignal })
      try {
        let projection = projectRoleplay((await handle.read()).events)
        if (projection.pending_turn) failure('turn_pending', projection.pending_turn.id)
        const previous = [...projection.requests.values()].find(request => request.command.id === command.id)
        if (projection.turns.has(command.id) && !previous) failure('command_conflict', command.id)
        if (projection.pending) {
          projection = await this.persist(handle, { type: 'roleplay/settled',
            data: makeSettled(projection, { status: 'failed', reason: 'interrupted', stream: [] }),
          })
        }
        if (previous) {
          if (digestExactJSON(previous.command) !== digestExactJSON(command)
            || digestExactJSON(previous.proposed_config) !== digestExactJSON(config)) failure('command_conflict', command.id)
          const settled = projection.settlements.get(previous.id)
          if (!settled) failure('missing_settlement', previous.id)
          return settled
        }
        return await this.generate(handle, projection, command, config, operationSignal)
      } finally { await handle.close() }
    })
  }

  private async generate(
    handle: SessionHandle, projection: RoleplayProjection, command: ReplayCommand, config: LlmCallConfig, operationSignal: AbortSignal,
  ): Promise<RoleplaySettled> {
    const id = handle.header.id
    if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens === undefined || config.maxTokens <= 0
      || config.maxTokens > projection.log.input.profile.reserve_for_output) failure('output_reserve', id)
    operationSignal.throwIfAborted()
    const call = await this.ctx.llm.prepareCall(config, operationSignal)
    if (call.config.maxTokens === undefined || call.config.maxTokens > projection.log.input.profile.reserve_for_output)
      failure('output_reserve', id)
    if (call.context && call.context.contextWindow < projection.log.input.profile.context_window) failure('context_window', id)
    const prepareRequest = command.operation.kind === 'turn' ? makeTurnRequested : makeRequested
    const requested = prepareRequest(projection, command.id, command, call.config, config)
    operationSignal.throwIfAborted()
    projection = await this.persist(handle, requested.command.operation.kind === 'turn'
      ? { type: 'roleplay/turn-requested', data: RoleplayTurnRequestedSchema.parse(requested) }
      : { type: 'roleplay/requested', data: RoleplayRequestedSchema.parse(requested) })
    const request = deepFreeze({ ...call.config, messages: requestMessages(requested), sessionId: id, signal: operationSignal })
    const outcome = await this.collect(call.stream(request), operationSignal)
    const artifact = projection.log.input.artifact
    const view = requested.command.for_participant
    const speaker = view && artifact.kind === 'content' ? artifact.story_refs?.participants[view] ?? view : view
    const settled = makeSettled(projection, outcome.status === 'success'
      ? { ...outcome, assistant: { ...outcome.assistant, ...(speaker ? { speaker } : {}) } } : outcome)
    await this.persist(handle, { type: 'roleplay/settled', data: settled })
    return settled
  }

  private async collect(chunks: AsyncIterable<StreamChunk>, operationSignal: AbortSignal): Promise<SettlementOutcome> {
    const stream = new AssistantStreamAccumulator()
    const assembly = new BlockAssembler()
    let size = 0
    let finished = false
    let reason: string | undefined
    try {
      operationSignal.throwIfAborted()
      for await (const chunk of chunks) {
        operationSignal.throwIfAborted()
        size += bytes(chunk)
        if (size > this.config.max_stream_bytes) { reason = 'stream_over_budget'; break }
        stream.push({ time: Date.now(), chunk })
        if (finished) { reason = 'stream_after_finish'; break }
        assembly.push(chunk)
        if (chunk.type === 'finish') finished = true
        if (this.unsupported(chunk)) { reason = 'unsupported_output'; break }
      }
    } catch (error) {
      reason = operationSignal.aborted ? 'cancelled' : error instanceof CharError ? error.code : 'generation_failed'
    }
    const timeout = operationSignal.reason instanceof CharError && operationSignal.reason.code === 'roleplay_runtime.timeout'
    if (operationSignal.aborted) reason = timeout ? 'timeout' : 'cancelled'
    if (!reason && (!finished || assembly.finish.kind !== 'stop')) reason = `finish:${finished ? assembly.finish.kind : 'missing'}`
    const text = reason ? '' : assembly.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    if (!reason && !text.trim()) reason = 'empty_output'
    const common = { stream: [...stream.snapshot()], ...(assembly.usage ? { usage: assembly.usage } : {}) }
    return reason ? { ...common, status: reason === 'cancelled' ? 'cancelled' : 'failed', reason }
      : { ...common, status: 'success', assistant: { text } }
  }

  /**
   * Plan and narrate one fenced player turn using only configured LLM routes.
   * @param id - Existing durable roleplay Session.
   * @param rawIntent - Stable request identity, current revision, player input, and explicit ending confirmation or recovery choice.
   * @param rawConfig - Separate decision/narration routes and aggregate planning limits.
   * @param signal - Cancels preparation and generation; completed writes remain authoritative.
   * @returns The stored outcome; retries never reapply a rewound or already settled turn.
   */
  play(id: SessionId, rawIntent: PlayIntent, rawConfig: PlayConfig, signal?: AbortSignal): Promise<PlayResult> {
    const intent = PlayIntentSchema.parse(rawIntent)
    const config = PlayConfigSchema.parse(rawConfig)
    return this.execute(id, signal, async (operationSignal) => {
      const handle = await this.ctx.sessionPersistence.open(id, 'write', { signal: operationSignal })
      try {
        let projection = projectRoleplay((await handle.read()).events)
        const previous = projection.turns.get(intent.id)
        if (previous) {
          if (digestExactJSON(previous.started.intent) !== digestExactJSON(intent)
            || digestExactJSON(previous.started.config) !== digestExactJSON(config)) failure('command_conflict', intent.id)
          const saved = lookupPlay(projection, intent.id)
          if (saved.status === 'settled') return saved.result
          failure('interrupted_retry_forbidden', intent.id)
        }
        if ([...projection.requests.values()].some(request => request.command.id === intent.id))
          failure('command_conflict', intent.id)
        if (intent.expected_revision !== projection.revision) failure('stale_revision', intent.id)
        if (projection.pending || projection.pending_turn) {
          if (!intent.recover_interrupted) failure('interrupted_request', intent.id)
          projection = await this.interruptTurn(handle, projection)
        }
        if (projection.current.state.stopped) failure('session_stopped', intent.id)
        const input = { text: intent.text, ...(intent.speaker ? { speaker: intent.speaker } : {}),
          ...(intent.choice_id ? { choice_id: intent.choice_id } : {}) }
        // Admission validates the current authored choice and player identity before any paid request.
        prepareCommand(projection, { id: intent.id, operation: { kind: 'turn', input, actions: [], assessments: [] },
          ...(intent.for_participant ? { for_participant: intent.for_participant } : {}) }, 'before')
        const confirmation = intent.confirm_ending ? prepareEndingConfirmation(projection, intent) : undefined
        if (!config.generation.maxTokens || config.generation.maxTokens > projection.log.input.profile.reserve_for_output)
          failure('output_reserve', id)
        if (!config.decisions.maxTokens || config.decisions.maxTokens > config.limits.max_decision_tokens)
          failure('decision_budget', intent.id)
        const fields = { intent, config, parent_head: projection.head, parent_revision: projection.revision }
        projection = await this.persist(handle, { type: 'roleplay/turn-started', data: { ...fields, digest: digestExactJSON(fields) } })
        let consumed = 0
        const storage = { failed: false }
        const save = async (fact: RoleplayFact) => {
          try { projection = await this.persist(handle, fact) }
          catch (error) { storage.failed = true; throw error }
        }
        const ask = async (stage: 'director' | 'selector', messages: PreparedTextMessage[], decisionSignal: AbortSignal): Promise<DecisionAnswer> => {
          decisionSignal.throwIfAborted()
          const record = projection.pending_turn
          if (!record || record.id !== intent.id) failure('turn_missing', intent.id)
          if (record.decisions.size >= config.limits.max_decision_calls) return { dispatched: false, reason: 'decision_call_limit' }
          const call = await this.ctx.llm.prepareCall(roleplayCallConfig(config.decisions), decisionSignal)
          const inputTokens = estimateCounter.count(JSON.stringify(messages))
          const outputTokens = call.config.maxTokens
          if (!outputTokens || consumed + inputTokens + outputTokens > config.limits.max_decision_tokens)
            return { dispatched: false, reason: 'decision_token_budget' }
          if (call.context && inputTokens + outputTokens > call.context.contextWindow)
            return { dispatched: false, reason: 'decision_context_window' }
          const fields = { turn_id: intent.id, index: record.decisions.size, stage,
            config: call.config, proposed_config: config.decisions, messages }
          const requested = RoleplayDecisionRequestedSchema.parse({ ...fields, request_digest: digestExactJSON(fields) })
          await save({ type: 'roleplay/decision-requested', data: requested })
          const mapped = requestMessages({ messages, id: requested.request_digest })
          const dispatched = call.stream({ ...call.config, messages: mapped, sessionId: id, signal: decisionSignal })
          const outcome = await this.collect(dispatched, decisionSignal)
          const usage = outcome.usage
          consumed += usage ? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
            : inputTokens + outputTokens
          const common = { turn_id: intent.id, index: requested.index, request_digest: requested.request_digest,
            stream: outcome.stream, ...(usage ? { usage } : {}) }
          const settled: RoleplayDecisionSettled = outcome.status === 'success'
            ? { ...common, status: 'success', text: outcome.assistant.text }
            : { ...common, status: outcome.status, reason: outcome.reason }
          await save({ type: 'roleplay/decision-settled', data: settled })
          decisionSignal.throwIfAborted()
          if (consumed > config.limits.max_decision_tokens) return { dispatched: true, reason: 'decision_token_budget' }
          return outcome.status === 'success' ? { dispatched: true, text: outcome.assistant.text }
            : { dispatched: true, reason: outcome.reason }
        }
        let command: ReplayCommand
        try { command = confirmation ?? await preparePlay(projection, intent, config, this.config.timeout_ms, ask, operationSignal) }
        catch (error) {
          if (storage.failed) throw error
          projection = await this.abortTurn(handle, projection, operationFailure(operationSignal, error, 'decision_failed'))
          const saved = lookupPlay(projection, intent.id)
          if (saved.status !== 'settled') failure('missing_settlement', intent.id)
          return saved.result
        }
        try { await this.generate(handle, projection, command, roleplayCallConfig(config.generation), operationSignal) }
        catch (error) {
          // Reconcile storage first: a failed flush may already have stored a request or success.
          projection = projectRoleplay((await handle.read()).events)
          if (projection.pending || !projection.pending_turn) throw error
          projection = await this.abortTurn(handle, projection, operationFailure(operationSignal, error, 'preparation_failed'))
        }
        projection = projectRoleplay((await handle.read()).events)
        const saved = lookupPlay(projection, intent.id)
        if (saved.status !== 'settled') failure('missing_settlement', intent.id)
        return saved.result
      } finally { await handle.close() }
    })
  }

  private async abortTurn(handle: SessionHandle, projection: RoleplayProjection, reason: string): Promise<RoleplayProjection> {
    const pending = projection.pending_turn
    if (!pending) return projection
    for (const decision of pending.decisions.values()) if (!decision.settled) {
      projection = await this.persist(handle, { type: 'roleplay/decision-settled', data: {
        turn_id: pending.id, index: decision.requested.index, request_digest: decision.requested.request_digest,
        status: reason === 'cancelled' ? 'cancelled' : 'failed', reason, stream: [],
      } })
    }
    return this.persist(handle, { type: 'roleplay/turn-aborted', data: {
      id: pending.id, parent_head: pending.started.parent_head, status: reason === 'cancelled' ? 'cancelled' : 'failed', reason,
    } })
  }

  private async interruptTurn(handle: SessionHandle, projection: RoleplayProjection): Promise<RoleplayProjection> {
    if (projection.pending) return this.persist(handle, { type: 'roleplay/settled',
      data: makeSettled(projection, { status: 'failed', reason: 'interrupted', stream: [] }) })
    return this.abortTurn(handle, projection, 'interrupted')
  }

  /**
   * Append a rewind of the latest successful play without changing historical requests.
   * @param id - Existing durable roleplay Session.
   * @param intent - Replay command identity for this rewind and the observed revision of the complete event log.
   * @param signal - Cancels before the append/flush commit interval.
   * @returns The restored logical head and its new durable revision.
   */
  rewind(id: SessionId, intent: { id: ReplayCommand['id']; expected_revision: string }, signal?: AbortSignal):
  Promise<{ head: string; revision: string; rewound_turn_id: string }> {
    return this.execute(id, signal, async (operationSignal) => {
      const handle = await this.ctx.sessionPersistence.open(id, 'write', { signal: operationSignal })
      try {
        let projection = projectRoleplay((await handle.read()).events)
        const prior = projection.rewinds.get(intent.id)
        if (prior) {
          if (prior.parent_revision !== intent.expected_revision) failure('command_conflict', intent.id)
          return { head: projection.head, revision: projection.revision, rewound_turn_id: prior.turn_id }
        }
        if (intent.expected_revision !== projection.revision) failure('stale_revision', intent.id)
        if (!canRewind(projection)) failure('rewind_unavailable', intent.id)
        const record = [...projection.turns.values()].reverse().find(value => !value.superseded
          && value.finished?.status === 'success' && value.finished.head === projection.head)
        if (!record) failure('rewind_unavailable', intent.id)
        operationSignal.throwIfAborted()
        projection = await this.persist(handle, { type: 'roleplay/rewound', data: {
          id: intent.id, turn_id: record.id, parent_head: projection.head,
          parent_revision: projection.revision, target_head: record.before.head_digest,
        } })
        return { head: projection.head, revision: projection.revision, rewound_turn_id: record.id }
      } finally { await handle.close() }
    })
  }

  private unsupported(chunk: StreamChunk): boolean {
    if (chunk.type === 'tool-call-delta') return true
    if (chunk.type === 'block-start') return !['text', 'reasoning'].includes(chunk.blockType)
    return chunk.type === 'block-end' && !['text', 'reasoning'].includes(chunk.block.type)
  }
}
