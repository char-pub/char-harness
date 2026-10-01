/** Optional named-profile application entry; binds only a fixed loopback origin. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { RuntimeProfileSchema } from '@char-pub/core'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { createRegistryClient } from './registry/client.ts'
import { createAppController } from './app-controller.ts'
import { appRecordReader } from './app-records.ts'
import { appHTML } from './app-ui.ts'
import { loadAppAssets } from './app-assets.ts'
import { createAppSettings } from './app-settings.ts'
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
  /** Credential reference the configured model adapter resolves when its own settings name none. */
  credential_ref: z.string().refine(isCredentialRefName),
})
/** The local app is an explicit opt-in profile row, not a default runtime surface. */
export const name = 'charpub-roleplay-app'
/** Session requests remain owned by the existing durable runtime service. */
export const inject = ['roleplayRuntime', 'sessionPersistence', 'credentials', 'llm', 'loader']

/**
 * Mount the bounded local HTTP entry and release all listeners, reads and model requests on disposal.
 * @param ctx - Loader-owned plugin context with the roleplay runtime service.
 * @param raw - Fixed local Registry/OAuth, model and transport configuration.
 */
export async function apply(ctx: Context, raw: z.input<typeof Config>) {
  const config = Config.parse(raw)
  const settings = createAppSettings(ctx, {
    credentialRef: config.credential_ref, appEntryId: ctx.fiber.entry?.options.id ?? name, provider: config.model.provider,
  })
  const assets = await loadAppAssets()
  const origin = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`
  const nonce = randomBytes(24).toString('base64url')
  const lifecycle = new AbortController()
  const clients = new Set<Promise<void>>()
  type Connection = { registry: Awaited<ReturnType<typeof createRegistryClient>>; app: ReturnType<typeof createAppController> }
  let connection: Promise<Connection> | undefined
  const appFetch: typeof fetch = (input, init) => globalThis.fetch(input, {
    ...init, signal: AbortSignal.any([lifecycle.signal, ...(init?.signal ? [init.signal] : [])]),
  })
  function connect(): Promise<Connection> {
    if (lifecycle.signal.aborted) return Promise.reject(new Error('roleplay_app.closed'))
    if (!connection) {
      const next = createRegistryClient({
        registryURL: config.registry_origin, issuer: config.issuer, clientId: config.client_id,
        redirectURI: `${origin}/oauth/callback`, scopes: ['creations:read', 'offline_access'],
        transport: {
          fetch: appFetch, timeoutMs: config.timeout_ms, maxJSONBytes: config.max_response_bytes,
          maxArtifactBytes: config.max_artifact_bytes, allowLoopbackHTTP: config.registry_origin.startsWith('http:'),
        },
      }).then(async (client) => {
        if (lifecycle.signal.aborted) { await client.dispose(); throw new Error('roleplay_app.closed') }
        return { registry: client, app: createAppController({
          registry: client, registryOrigin: config.registry_origin,
          runtime: ctx.roleplayRuntime, listRecords: appRecordReader(ctx.sessionPersistence, ctx.roleplayRuntime),
          profile: config.profile, model: config.model, timeout_ms: config.timeout_ms,
        }) }
      })
      connection = next
      // Failed initial discovery owns no active Session; the next explicit request can try again.
      void next.catch(() => { if (connection === next) connection = undefined })
    }
    return connection
  }
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
      const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      return input
    } finally { clearTimeout(timer) }
  }
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('cache-control', 'private, no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    try {
      if (lifecycle.signal.aborted || req.headers.host !== new URL(origin).host) { respond(res, 403, { error: 'roleplay_app.host_forbidden' }); return }
      const url = new URL(req.url ?? '/', origin)
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(appHTML(assets.template, { nonce, registryOrigin: config.registry_origin })); return }
      const asset = req.method === 'GET' ? assets.files.get(url.pathname) : undefined
      if (asset) { res.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'public, max-age=31536000, immutable' }); res.end(asset.body); return }
      if (req.method === 'GET' && url.pathname === '/oauth/callback') { await (await connect()).registry.completeAuthorization(url.href); res.writeHead(303, { location: '/' }); res.end(); return }
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-roleplay-client'] !== nonce || req.headers['content-type']?.split(';')[0] !== 'application/json') { respond(res, 403, { error: 'roleplay_app.origin_forbidden' }); return }
      const input = await body(req)
      lifecycle.signal.throwIfAborted()
      // Settings stay usable while Registry discovery is unavailable.
      const local = url.pathname === '/api/settings/models' ? await settings.models()
        : url.pathname === '/api/settings/models/save' ? await settings.saveModel(input)
          : url.pathname === '/api/settings/models/clear-key' ? await settings.clearModelKey(input)
            : url.pathname === '/api/settings/plugins' ? await settings.plugins()
              : url.pathname === '/api/settings/plugin' ? settings.pluginConfig(input)
                : url.pathname === '/api/settings/plugin/save' ? await settings.savePluginConfig(input) : undefined
      if (local !== undefined) { respond(res, 200, local); return }
      const { registry, app } = await connect()
      const result = url.pathname === '/api/status' ? app.status(await settings.credential())
        : url.pathname === '/api/sessions' ? await app.sessions(input)
          : url.pathname === '/api/resume' ? await app.resume(input)
            : url.pathname === '/api/session' ? await app.session(input)
              : url.pathname === '/api/turn-status' ? await app.turnStatus(input)
                : url.pathname === '/api/authorize' ? await registry.beginAuthorization()
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
    const connecting = connection
    lifecycle.abort()
    const connected = await connecting?.catch(() => undefined)
    const closing = connected?.app.dispose()
    await connected?.registry.dispose()
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
