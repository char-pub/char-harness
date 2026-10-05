/** Loader-mounted generation stand-in. It captures actual upstream LLM dispatches without network access. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'roleplay-test-provider'
export const inject = ['llm']

declare module '@deepseek-ai/cordis' {
  interface Context { roleplayTestProvider: Probe }
}
export class Probe extends Service {
  calls: GenerateOptions[] = []
  mode: 'success' | 'cancel' | 'failure' | 'tool' = 'success'
  onRequest: (() => void) | undefined
  replies: { text?: string; mode?: 'success' | 'cancel' | 'failure' | 'tool' }[] = []
  constructor(ctx: Context) { super(ctx, 'roleplayTestProvider') }
}
class Adapter extends LlmAdapter {
  constructor(private readonly probe: Probe) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.probe.calls.push(options)
    this.probe.onRequest?.()
    const reply = this.probe.replies.shift()
    const mode = reply?.mode ?? this.probe.mode
    if (mode === 'cancel') {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('cancelled')); return }
        options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      throw new Error('cancelled during generation')
    }
    if (mode === 'failure') throw new Error('synthetic failure')
    if (mode === 'tool') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      return
    }
    if (reply?.text !== undefined) yield { type: 'text-delta', index: 0, text: reply.text }
    else {
      yield { type: 'text-delta', index: 0, text: 'The innkeeper ' }
      yield { type: 'text-delta', index: 0, text: 'nods.' }
    }
    yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 8, totalTokens: 208 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export function apply(ctx: Context) {
  const probe = new Probe(ctx)
  ctx.llm.registerAdapter(['roleplay-test'], new Adapter(probe))
}
