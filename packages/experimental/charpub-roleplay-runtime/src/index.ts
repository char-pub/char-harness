/** Durable roleplay transactions; only the request recorded in the Session log reaches the LLM. */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { CharError, digestExactJSON } from '@char-pub/core'
import type { ReplayInput, ReplayCommand } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { AssistantStreamAccumulator, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { validateStoredEvents, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { makeOpened, makeRequested, makeSettled, projectRoleplay, requestMessages } from './projection.ts'
import type { RoleplayProjection } from './projection.ts'
import type { RoleplaySettled, RoleplayOpened, RoleplayRequested } from './events.ts'

type RoleplayFact = { type: 'roleplay/opened'; data: RoleplayOpened }
  | { type: 'roleplay/requested'; data: RoleplayRequested }
  | { type: 'roleplay/settled'; data: RoleplaySettled }

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
    // After append starts, close/flush must establish the storage outcome rather than cancel halfway.
    await handle.append(batch)
    await handle.flush()
    return projectRoleplay([...stored.events, ...batch])
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
        if (projection.pending) {
          projection = await this.persist(handle, { type: 'roleplay/settled',
            data: makeSettled(projection, { status: 'failed', reason: 'interrupted', stream: [] }),
          })
        }
        const previous = [...projection.requests.values()].find(request => request.command.id === command.id)
        if (previous) {
          if (digestExactJSON(previous.command) !== digestExactJSON(command)
            || digestExactJSON(previous.proposed_config) !== digestExactJSON(config)) failure('command_conflict', command.id)
          const settled = projection.settlements.get(previous.id)
          if (!settled) failure('missing_settlement', previous.id)
          return settled
        }
        if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens === undefined || config.maxTokens <= 0
          || config.maxTokens > projection.log.input.profile.reserve_for_output) failure('output_reserve', id)
        operationSignal.throwIfAborted()
        const call = await this.ctx.llm.prepareCall(config, operationSignal)
        if (call.config.maxTokens === undefined || call.config.maxTokens > projection.log.input.profile.reserve_for_output)
          failure('output_reserve', id)
        if (call.context && call.context.contextWindow < projection.log.input.profile.context_window) failure('context_window', id)
        const requested = makeRequested(projection, command.id, command, call.config, config)
        operationSignal.throwIfAborted()
        projection = await this.persist(handle, { type: 'roleplay/requested', data: requested })
        const request = deepFreeze({ ...call.config, messages: requestMessages(requested), sessionId: id, signal: operationSignal })
        const stream = new AssistantStreamAccumulator()
        const assembly = new BlockAssembler()
        let size = 0
        let finished = false
        let reason: string | undefined
        try {
          operationSignal.throwIfAborted()
          for await (const chunk of call.stream(request)) {
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
        const artifact = projection.log.input.artifact
        const view = requested.command.for_participant
        const speaker = view && artifact.kind === 'content' ? artifact.story_refs?.participants[view] ?? view : view
        const settled = reason
          ? makeSettled(projection, { ...common, status: reason === 'cancelled' ? 'cancelled' : 'failed', reason })
          : makeSettled(projection, { ...common, status: 'success', assistant: {
            text, ...(speaker ? { speaker } : {}),
          } })
        await this.persist(handle, { type: 'roleplay/settled', data: settled })
        return settled
      } finally { await handle.close() }
    })
  }

  private unsupported(chunk: StreamChunk): boolean {
    if (chunk.type === 'tool-call-delta') return true
    if (chunk.type === 'block-start') return !['text', 'reasoning'].includes(chunk.blockType)
    return chunk.type === 'block-end' && !['text', 'reasoning'].includes(chunk.block.type)
  }
}
