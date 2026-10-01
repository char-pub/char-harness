/** Explicit Laya SystemOne Noul transport; local limits do not prove checkpoint token coverage. */
import { CharError, digestExactJSON } from '@char-pub/core'
import { z } from 'zod'
import { createNoulDecisions, NoulConfigSchema, type NoulDecisions, type NoulRequest } from './noul.ts'

const Probability = z.number().min(0).max(1)
const Model = z.enum(['english', 'multilingual', 'typed-decisions'])
const ConfigSchema = NoulConfigSchema.safeExtend({
  model: z.enum(['auto', 'english', 'multilingual', 'typed-decisions']),
  max_questions: z.number().int().min(1).max(64),
  max_state_chars: z.number().int().min(1).max(50_000),
  max_request_bytes: z.number().int().min(1).max(2 * 1024 * 1024),
  max_response_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  max_len: z.number().int().min(1).max(8192),
  head_max_len: z.number().int().min(1).max(8192),
  min_confidence: Probability,
})
/** Explicit routing, per-request limits and shared probability policy; no calibrated defaults. */
export type LayaConfig = z.infer<typeof ConfigSchema>
/** Credentials are optional only for an explicitly configured unauthenticated deployment. */
export interface LayaTransport {
  baseURL: string
  apiKey: string | null
  allowLoopbackHTTP: boolean
  fetch?: typeof globalThis.fetch
}
/** The same Story/selection operations as Jev, with independent Laya provider identity and evidence. */
export type LayaDecisions = NoulDecisions
const ResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.object({
    type: z.literal('noul'), noul: Probability, confidence: Probability.optional(),
    answer_confidence: Probability.optional(), low_confidence: z.boolean().optional(),
    action: z.object({ act_probability: Probability }).optional(),
  })),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
  routing: z.object({
    model: Model, repo: z.string().min(1), reason: z.string(), workflow: z.string().nullable(),
    detection: z.object({
      script: z.string(), script_profile: z.record(z.string(), z.number()), language: z.string().nullable(),
      is_english: z.boolean(), language_undecided: z.boolean(), diacritic_rate: z.number(), non_latin_fraction: z.number(),
    }).nullable(),
  }),
})
// Pinned upstream HTTP/router/confidence semantics; this is a source revision, not a model-weight identity.
const PROTOCOL_REVISION = '6d942c92081fbc139e736bbd9ac0023223c29b7f'
class InvalidResponse extends Error {}
class Unavailable extends Error {}

async function readJSON(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => { /* Cleanup failure must not replace the HTTP failure. */ })
    throw new Unavailable('Laya HTTP request failed')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new InvalidResponse('Empty Laya response')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''; let size = 0
  const cancel = () => {
    void reader.cancel().catch(() => { /* An aborted/closed stream must not replace the original outcome. */ })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new InvalidResponse('Laya response exceeds its byte limit')
      try { text += decoder.decode(chunk.value, { stream: true }) }
      catch { throw new InvalidResponse('Invalid UTF-8 response') }
    }
    let tail: string
    try { tail = decoder.decode() } catch { throw new InvalidResponse('Invalid UTF-8 response') }
    return JSON.parse(text + tail)
  } finally { signal.removeEventListener('abort', cancel); cancel() }
}

/**
 * Create Laya decisions with explicit model routing and bounded HTTP, without loading model weights.
 * @param configuration - Checkpoint/auto choice, window controls, limits and probability thresholds.
 * @param transport - Endpoint and optional key; HTTP is allowed only for explicitly enabled loopback deployments.
 * @returns Projected judgments/selections with actual model/routing evidence; low-confidence answers abstain.
 */
export function createLayaDecisions(configuration: LayaConfig, transport: LayaTransport): LayaDecisions {
  const config = ConfigSchema.parse(configuration)
  const url = new URL(transport.baseURL)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(transport.allowLoopbackHTTP && loopback && url.protocol === 'http:')))
    throw new CharError({ code: 'laya.invalid_transport', subject: 'baseURL' })
  const key = transport.apiKey === null ? null : z.string().trim().min(1).parse(transport.apiKey)
  const endpoint = new URL(`${url.href.replace(/\/$/, '')}/v1/systemone`)
  const fetch = transport.fetch ?? globalThis.fetch
  async function send(request: NoulRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Laya operation aborted')) }
      signal.addEventListener('abort', abort, { once: true })
    })
    const operation = async () => {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', ...(key === null ? {} : { authorization: `Bearer ${key}` }) },
        body: JSON.stringify(request),
      })
      return readJSON(response, config.max_response_bytes, signal)
    }
    try { return await Promise.race([operation(), aborted]) }
    finally { if (abort) signal.removeEventListener('abort', abort) }
  }
  return createNoulDecisions(config, {
    provider: { name: 'laya/systemone', version: '1' }, errorPrefix: 'laya',
    recordedConfig: { ...config, protocol_revision: PROTOCOL_REVISION, transport_digest: digestExactJSON(endpoint.href) },
    encode: request => ({ ...request, model: config.model === 'auto' ? 'convaiinnovations/laya' : config.model,
      max_len: config.max_len, head_max_len: config.head_max_len, min_confidence: config.min_confidence }),
    admit(request) {
      if (Object.keys(request.questions).length > config.max_questions) return 'question-limit'
      if (Array.from(JSON.stringify(request.state)).length > config.max_state_chars) return 'state-limit'
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > config.max_request_bytes) return 'body-limit'
      return undefined
    },
    send,
    decode(response) {
      const parsed = ResponseSchema.safeParse(response)
      if (!parsed.success || (config.model !== 'auto' && parsed.data.routing.model !== config.model)) return undefined
      return { result: z.json().parse(parsed.data), probabilities: Object.fromEntries(
        Object.entries(parsed.data.answers).map(([id, answer]) => [id, answer.low_confidence ? undefined : answer.noul]),
      ) }
    },
    fault(error) {
      if (error instanceof InvalidResponse || error instanceof SyntaxError) return 'invalid-response'
      if (error instanceof Unavailable || error instanceof TypeError) return 'unavailable'
      return undefined
    },
  })
}
