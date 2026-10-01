/** Bounded Registry and signed-object HTTP; credential forwarding is explicit per request. */
/** Deployment limits for complete JSON and artifact responses. */
export interface TransportOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs: number
  maxJSONBytes: number
  maxArtifactBytes: number
  allowLoopbackHTTP?: boolean
}

/**
 * Reject credentials, fragments and insecure non-loopback targets.
 * @param value - Endpoint supplied by configuration or Registry.
 * @param allowLoopback - Explicit local development HTTP allowance.
 * @returns The validated absolute URL.
 */
export function allowedURL(value: string | URL, allowLoopback: boolean): URL {
  const url = new URL(value)
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error('registry.url_forbidden')
  return url
}

interface BoundedTransport {
  (url: URL, init?: RequestInit, limit?: number): Promise<Response>
  dispose(): Promise<void>
}

/**
 * Create bounded HTTP reads with manual redirects and omitted ambient credentials.
 * @param options - Positive byte/time limits and optional fetch implementation.
 * @returns A request function that buffers only within the declared response limit.
 */
export function makeTransport(options: TransportOptions): BoundedTransport {
  for (const value of [options.timeoutMs, options.maxJSONBytes, options.maxArtifactBytes]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('registry.invalid_limits')
  const fetcher = options.fetch ?? globalThis.fetch
  const lifecycle = new AbortController()
  const pending = new Set<Promise<Response>>()
  const run = async (url: URL, init: RequestInit = {}, limit = options.maxJSONBytes): Promise<Response> => {
    lifecycle.signal.throwIfAborted()
    allowedURL(url, options.allowLoopbackHTTP === true)
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = AbortSignal.any([timeout, lifecycle.signal, ...(init.signal ? [init.signal] : [])])
    async function wait<T>(pending: Promise<T>): Promise<T> {
      signal.throwIfAborted()
      let stop = () => {}
      const aborted = new Promise<never>((_, reject) => {
        stop = () =>{  reject(new Error('registry.request_aborted')) }
        signal.addEventListener('abort', stop, { once: true })
      })
      try { return await Promise.race([pending, aborted]) }
      finally { signal.removeEventListener('abort', stop) }
    }
    try {
      const response = await wait(fetcher(url, { ...init, signal, redirect: 'manual', credentials: 'omit' }))
      if (response.type === 'opaqueredirect' || response.redirected) throw new Error('registry.redirect_uninspectable')
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (reader) {
          const chunk = await wait(reader.read())
          signal.throwIfAborted()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > limit) throw new Error('registry.response_too_large')
          chunks.push(chunk.value)
        }
      } finally {
        // Cancellation may itself stall; it cannot extend the request deadline or replace its failure.
        const cancellation = reader?.cancel().catch(() => undefined)
        if (cancellation && !signal.aborted) await wait(cancellation).catch(() => undefined)
      }
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('registry.')) throw error
      throw new Error('registry.transport_failed')
    }
  }
  const request = (url: URL, init?: RequestInit, limit?: number) => {
    const result = run(url, init, limit)
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    return result
  }
  return Object.assign(request, { async dispose() {
    lifecycle.abort(new Error('registry.disposed'))
    await Promise.allSettled([...pending])
  } })

}
