/** Test-only model adapter for the real dsh app. It does not mount the application or replace Registry calls. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

class FixedAdapter extends LlmAdapter {
  async *stream() {
    yield { type: 'text-delta', index: 0, text: 'The guide opens the lantern gate.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'charpub-app-fullstack-model'
export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter(['charpub-app-fullstack'], new FixedAdapter())
}
