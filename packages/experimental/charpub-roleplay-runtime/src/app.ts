/** Optional named-profile application entry; binds only a fixed loopback origin. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { RuntimeProfileSchema } from '@char-pub/core'
import { createRegistryClient } from './registry/client.ts'
import { createAppController } from './app-controller.ts'
import { appHTML } from './app-ui.ts'
import type {} from './index.ts'

/** Explicit local deployment; launch files cannot override these endpoints or limits. */
export const Config = z.strictObject({
  host: z.enum(['127.0.0.1', '::1']), port: z.number().int().min(1).max(65535),
  registry_origin: z.url(), issuer: z.url(), client_id: z.string().min(1),
  timeout_ms: z.number().int().positive().max(2_147_483_647),
  max_request_bytes: z.number().int().positive(), max_response_bytes: z.number().int().positive(),
  max_artifact_bytes: z.number().int().positive(),
  profile: RuntimeProfileSchema,
  model: z.strictObject({ provider: z.string().min(1), model: z.string().min(1), maxTokens: z.number().int().positive() }),
})
/** The local app is an explicit opt-in profile row, not a default runtime surface. */
export const name = 'charpub-roleplay-app'
/** Session requests remain owned by the existing durable runtime service. */
export const inject = ['roleplayRuntime']

/**
 * Mount the bounded local HTTP entry and release all listeners, reads and model requests on disposal.
 * @param ctx - Loader-owned plugin context with the roleplay runtime service.
 * @param raw - Fixed local Registry/OAuth, model and transport configuration.
 */
export async function apply(ctx: Context, raw: z.input<typeof Config>) {
  const config = Config.parse(raw)
  const origin = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`
  const nonce = randomBytes(24).toString('base64url')
  const lifecycle = new AbortController()
  const clients = new Set<Promise<void>>()
  const registry = createRegistryClient({ registryURL: config.registry_origin, issuer: config.issuer, clientId: config.client_id,
    redirectURI: `${origin}/oauth/callback`, scopes: ['creations:read', 'offline_access'],
    transport: { timeoutMs: config.timeout_ms, maxJSONBytes: config.max_response_bytes, maxArtifactBytes: config.max_artifact_bytes, allowLoopbackHTTP: config.registry_origin.startsWith('http:') } })
  const controller = registry.then(client => createAppController({ registry: client, registryOrigin: config.registry_origin,
    runtime: ctx.roleplayRuntime, profile: config.profile, model: config.model, timeout_ms: config.timeout_ms }))
  // Consume initialization rejection; requests report a bounded generic error instead of an unhandled rejection.
  void controller.catch(() => undefined)
  const respond = (res: ServerResponse, status: number, value: unknown) => {
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json) > config.max_response_bytes) { res.writeHead(413); res.end('{"error":"roleplay_app.response_too_large"}'); return }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(json)
  }
  async function body(req: IncomingMessage) {
    const chunks: Buffer[] = []
    let bytes = 0
    const timer = setTimeout(() => req.destroy(new Error('roleplay_app.body_timeout')), config.timeout_ms)
    try {
      for await (const raw of req) {
        const chunk: unknown = raw
        if (!(chunk instanceof Uint8Array)) throw new Error('roleplay_app.invalid_body')
        const value = Buffer.from(chunk)
        bytes += value.length
        if (bytes > config.max_request_bytes) throw new Error('roleplay_app.request_too_large')
        chunks.push(value)
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
    } finally { clearTimeout(timer) }
  }
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('cache-control', 'private, no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`)
    try {
      if (lifecycle.signal.aborted || req.headers.host !== new URL(origin).host) { respond(res, 403, { error: 'roleplay_app.host_forbidden' }); return }
      const url = new URL(req.url ?? '/', origin)
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(appHTML(nonce)); return }
      if (req.method === 'GET' && url.pathname === '/oauth/callback') { await (await registry).completeAuthorization(url.href); res.writeHead(303, { location: '/' }); res.end(); return }
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-roleplay-client'] !== nonce || req.headers['content-type']?.split(';')[0] !== 'application/json') { respond(res, 403, { error: 'roleplay_app.origin_forbidden' }); return }
      const input = await body(req)
      lifecycle.signal.throwIfAborted()
      const app = await controller
      const result = url.pathname === '/api/authorize' ? await (await registry).beginAuthorization()
        : url.pathname === '/api/review' ? await app.review(input)
          : url.pathname === '/api/start' ? await app.start(input)
            : url.pathname === '/api/turn' ? await app.turn(input)
              : url.pathname === '/api/cancel' ? (app.cancel(input), {})
                : url.pathname === '/api/prepare-export' ? await app.prepareExport(input)
                  : url.pathname === '/api/export' ? await app.export(input) : undefined
      if (result === undefined) respond(res, 404, { error: 'roleplay_app.not_found' }); else respond(res, 200, result)
    } catch (error) {
      const machine = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
        : error instanceof Error ? error.message : ''
      const safeCode =
        /^(roleplay_app|registry|roleplay_preview|roleplay|roleplay_runtime|story|catalog|session|source|capability)\.[a-z_0-9]+$/
      const code = safeCode.test(machine)
        ? machine : error instanceof z.ZodError ? 'roleplay_app.invalid_input' : 'roleplay_app.operation_failed'
      if (!res.destroyed) respond(res, 400, { error: code })
    }
  }
  const server = createServer((req, res) => {
    const promise = handle(req, res).finally(() => clients.delete(promise))
    clients.add(promise)
  })
  server.requestTimeout = config.timeout_ms
  server.headersTimeout = Math.min(config.timeout_ms, 60_000)
  server.keepAliveTimeout = 1000
  server.maxConnections = 16
  ctx.effect(() => async () => {
    lifecycle.abort()
    const app = await controller.catch(() => undefined)
    const closing = app?.dispose()
    await (await registry.catch(() => undefined))?.dispose()
    await closing
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
    await Promise.allSettled(clients)
  }, 'charpub-roleplay-app.http()')
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
  })
  // A listening server remains owned by this plugin; socket errors terminate its active request only.
  server.on('error', () => { lifecycle.abort(new Error('roleplay_app.listener_failed')); server.closeAllConnections() })
}
