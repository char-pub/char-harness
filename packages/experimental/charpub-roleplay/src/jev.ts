/** Official TypeSafe transport and strict Jev response codec over the shared projected decision loop. */
import { CharError, digestExactJSON } from '@char-pub/core'
import { APIConnectionError, APIError, APITimeoutError, TypeSafeClient, VERSION, type Fetch } from '@typesafe-ai/sdk'
import { z } from 'zod'
import { createNoulDecisions, NoulConfigSchema, type NoulConfig, type NoulDecisions } from './noul.ts'
export type { JudgeTask } from './noul.ts'
/** Explicit Jev probability policy and operation limits. */
export type JevConfig = NoulConfig
/** Projected judge/selection operations that never commit Story state. */
export type JevDecisions = NoulDecisions
/** Transport secrets stay outside decision records. */
export interface JevTransport { apiKey: string; baseURL: string; fetch?: Fetch }
const PROVIDER = { name: 'typesafe/jev', version: '1' }
const Probability = z.number().min(0).max(1)
const ResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.strictObject({ type: z.literal('noul'), noul: Probability })),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
})


/**
 * Create explicit decisions through the official TypeSafe SDK without issuing a request.
 * @param configuration - Required model, thresholds and whole-operation limits.
 * @param transport - Explicit key, base URL and optional fetch; environment credentials are never read.
 * @returns Projected judgments/selections with evidence; caller cancellation rejects, provider faults abstain or skip.
 */
export function createJevDecisions(configuration: JevConfig, transport: JevTransport): JevDecisions {
  const config = NoulConfigSchema.parse(configuration)
  const url = new URL(transport.baseURL)
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol))
    throw new CharError({ code: 'jev.invalid_transport', subject: 'baseURL' })
  const apiKey = z.string().trim().min(1).parse(transport.apiKey)
  const client = new TypeSafeClient({
    apiKey, baseURL: url.href, defaultModel: config.model, timeout: config.timeout_ms,
    retry: { maxRetries: 0 }, logLevel: 'off', ...(transport.fetch ? { fetch: transport.fetch } : {}),
  })
  return createNoulDecisions(config, {
    provider: PROVIDER, errorPrefix: 'jev',
    recordedConfig: { ...config, sdk_version: VERSION, transport_digest: digestExactJSON(url.href) },
    send: (request, signal) => client.systemOne(request, { signal }),
    decode(response) {
      const parsed = ResponseSchema.safeParse(response)
      if (!parsed.success) return undefined
      return { result: z.json().parse(parsed.data),
        probabilities: Object.fromEntries(Object.entries(parsed.data.answers).map(([key, answer]) => [key, answer.noul])) }
    },
    fault(error) {
      if (error instanceof APITimeoutError) return 'timeout'
      if (error instanceof APIError || error instanceof APIConnectionError) return 'unavailable'
      if (error instanceof SyntaxError) return 'invalid-response'
      return undefined
    },
  })
}
