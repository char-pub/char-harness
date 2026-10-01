import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoleplayApi, readBootstrap } from '../src/api.ts'

const bootstrap = { nonce: 'local-page', registryOrigin: 'http://localhost:5173' }
const work = { title: 'Snowbound inn', source: { ref: '@local/inn' }, source_label: 'Draft', locale: 'en' }
const late_slots = [{ key: 'user', accepts: ['persona'], required: true, used_by: [] }]
const snapshot = { session: 'active-handle', record: 'saved-record', work, history: [{ role: 'assistant', text: 'Welcome to the inn.' }], participants: [], late_slots, scene: { id: 'inn', title: 'The inn' }, stopped: false, interrupted: false, can_continue: true, limitations: [] }
const review = { review: 'exact-review', work, source: work.source, title: work.title, metadata: { rating: 'general', licenses: [], content_warnings: [] }, capabilities: [], support: { status: 'supported', missing: [], degraded: [] }, starts: [{ id: 'night', title: 'Nightfall' }], participants: [], late_slots, locale: 'en', view: { mode: 'narrator' }, restart_required: false }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }

afterEach(() => { document.body.replaceChildren() })
describe('profile-bound browser transport', () => {
  it('requires actual bootstrap instead of silently entering a demo', () => {
    expect(() => readBootstrap()).toThrow('bootstrap_missing')
    const script = document.createElement('script')
    script.id = 'charpub-bootstrap'
    script.type = 'application/json'
    script.textContent = JSON.stringify(bootstrap)
    document.body.append(script)
    expect(readBootstrap()).toEqual(bootstrap)
  })
  it('accepts the real late-slot array and sends the page nonce only to its local API', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(review))
    const api = createRoleplayApi(bootstrap, fetcher)
    expect(await api.review({ format: 'char.pub/runtime-launch' })).toEqual(review)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/review')
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ 'content-type': 'application/json', 'x-roleplay-client': bootstrap.nonce })
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin')
  })
  it('rejects an invalid review instead of letting malformed bindings reach the setup form', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...review, late_slots: {} }))
    await expect(createRoleplayApi(bootstrap, fetcher).review({})).rejects.toMatchObject({ code: 'roleplay_app.invalid_response', unknownOutcome: false })
  })
  it('keeps a lost send outcome distinct and queries the original request without resending', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection closed'))
      .mockResolvedValueOnce(json({ request_id: 'one-request', status: 'success', snapshot }))
    const api = createRoleplayApi(bootstrap, fetcher)
    const request = { session: snapshot.session, request_id: 'one-request', text: 'May I stay here?' }
    await expect(api.turn(request)).rejects.toMatchObject({ unknownOutcome: true, code: 'roleplay_app.connection_lost' })
    const result = await api.turnStatus(request.session, request.request_id)
    expect(result.status).toBe('success')
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/turn', '/api/turn-status'])
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ session: request.session, request_id: request.request_id }))
  })
  it('surfaces known rejections and treats an unreadable successful send as an unknown outcome', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: 'roleplay_app.source_expired' }, 400))
      .mockResolvedValueOnce(new Response('truncated'))
    const api = createRoleplayApi(bootstrap, fetcher)
    await expect(api.start({ review: 'review', bindings: {}, restart: false })).rejects.toMatchObject({ code: 'roleplay_app.source_expired', unknownOutcome: false })
    await expect(api.turn({ session: 'session', request_id: 'request', text: 'Hello' })).rejects.toMatchObject({ code: 'roleplay_app.invalid_response', unknownOutcome: true })
  })
  it.each([
    { metadata: {} },
    { metadata: { ...review.metadata, licenses: [{}] } },
    { metadata: { ...review.metadata, content_warnings: null } },
    { support: { status: 'supported' } },
    { support: { status: 'degraded', missing: [], degraded: [{ id: 'story.v1' }] } },
    { view: { mode: 'per-agent' } },
  ])('rejects incomplete setup metadata before rendering it: %j', async (patch) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...review, ...patch }))
    await expect(createRoleplayApi(bootstrap, fetcher).review({})).rejects.toMatchObject({ code: 'roleplay_app.invalid_response', unknownOutcome: false })
  })
  it('accepts the configured same-origin OAuth issuer path and preserves its PKCE parameters', async () => {
    const authorizationURL = bootstrap.registryOrigin + '/v1/auth/oauth2/authorize?state=one&code_challenge=challenge'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ authorizationURL }))
    expect(await createRoleplayApi(bootstrap, fetcher).authorize()).toEqual({ authorizationURL })
  })
  it('rejects an authorization redirect outside the configured Registry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ authorizationURL: 'https://unexpected.example/authorize' }))
    await expect(createRoleplayApi(bootstrap, fetcher).authorize()).rejects.toMatchObject({ code: 'roleplay_app.registry_mismatch' })
  })
})
