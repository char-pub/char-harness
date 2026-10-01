/** Registry protocol and byte validation using the maintained OAuth client and real packed SDK artifacts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { buildCreation, canonicalizeCreation, PRESET_REGIONS } from '@char-pub/core'
import { createPreparationCatalog, fixedSelection, prepareContext, startSession } from '@char-pub/assembler'
import type { TransportOptions } from '../src/registry/transport.ts'
import { createRegistryClient } from '../src/registry/client.ts'
import { replayInput, SOURCE } from '../../charpub-roleplay/tests/fixtures.ts'

const server = 'https://registry.example'
const callback = 'http://127.0.0.1:7777/callback'
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const json = (body: unknown, status = 200) => Response.json(body, { status })
function harness() {
  const input = replayInput('narrator', { catalog: true })
  const artifact = input.artifact
  assert.ok(artifact.kind === 'content' && 'release' in artifact.root)
  const pin = artifact.root
  let body = JSON.stringify(artifact)
  let access = 'access-1'
  let refresh = 'refresh-1'
  let exchanges = 0
  let rotations = 0
  let sourceReads = 0
  let revoked = false
  let corruptSource = false
  let sourceStatus = 200
  let challenge = ''
  const seen: { url: string; auth: string | null; method: string }[] = []
  const transport: typeof fetch = async (value, init) => {
    const url = new URL(typeof value === 'string' ? value : value instanceof URL ? value.href : value.url)
    const headers = new Headers(init?.headers)
    seen.push({ url: url.href, auth: headers.get('authorization'), method: init?.method ?? 'GET' })
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: server, authorization_endpoint: `${server}/authorize`, token_endpoint: `${server}/token`, revocation_endpoint: `${server}/revoke`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
    if (url.pathname === '/token') {
      const params = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : '')
      assert.equal(params.get('client_id'), 'client')
      assert.equal(headers.get('authorization'), null)
      if (params.get('grant_type') === 'authorization_code') {
        exchanges++
        assert.equal(params.get('redirect_uri'), callback)
        assert.equal(createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url'), challenge)
      } else {
        rotations++
        if (params.get('refresh_token') !== refresh || revoked) return json({ error: 'invalid_grant' }, 400)
        access = `access-${rotations + 1}`
        refresh = `refresh-${rotations + 1}`
      }
      return json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'profile creations:read offline_access drafts:write contributions:write' })
    }
    if (url.pathname === '/revoke') { revoked = true; return new Response(null, { status: 200 }) }
    if (url.hostname === 'objects.example') { assert.equal(headers.get('authorization'), null); return new Response(body) }
    if (headers.get('authorization') !== `Bearer ${access}` || revoked) return json({ code: 'unauthorized' }, 401)
    if (url.pathname === '/v1/profile') return json({ id: 'usr_example', namespace: 'fixture' })
    if (url.pathname.endsWith('/source-text')) {
      sourceReads++
      const source = artifact.catalog_index.sources[0]
      assert.ok(source)
      return json({ source: source.id, asset: source.asset, digest: sha(SOURCE), text: corruptSource ? `${SOURCE}tampered` : SOURCE }, sourceStatus)
    }
    if (url.pathname.endsWith('/artifact')) return new Response(null, { status: 302, headers: { location: 'https://objects.example/artifact' } })
    if (url.pathname === `/v1/releases/${pin.release}`) return json({ id: pin.release, ref: '@renamed/current', creation: 'cr_01j00000000000000000000000', label: '1.0.0', visibility: 'private', status: 'active', semantic_digest: pin.semantic_digest, effective_rating: 'general', created_at: new Date().toISOString(), lock_digest: artifact.lock_digest, context_ir_digest: null, artifact_digest: sha(JSON.stringify(artifact)), license_check: 'pass', availability: 'complete' })
    if (url.pathname.endsWith('/creations')) return json({ id: 'cr_01j00000000000000000000005', ref: '@fixture/new', type: 'character' }, 201)
    throw new Error(`unexpected request ${url.pathname}`)
  }
  async function client(overrides: Partial<TransportOptions> = {}) {
    return createRegistryClient({ registryURL: server, issuer: server, clientId: 'client', redirectURI: callback, scopes: ['profile', 'creations:read', 'offline_access', 'drafts:write', 'contributions:write'], transport: { fetch: transport, timeoutMs: 2000, maxJSONBytes: 1024 * 1024, maxArtifactBytes: 1024 * 1024, allowLoopbackHTTP: true, ...overrides } })
  }
  async function authorize(c: Awaited<ReturnType<typeof client>>, existingURL?: string) {
    const authorizationURL = existingURL ?? (await c.beginAuthorization()).authorizationURL
    const url = new URL(authorizationURL)
    challenge = url.searchParams.get('code_challenge') ?? ''
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    const response = new URL(callback)
    response.search = new URLSearchParams({ code: 'test-code', state: url.searchParams.get('state') ?? '' }).toString()
    await c.completeAuthorization(response.href)
    return response.href
  }
  return { input, artifact, pin, transport, client, authorize, seen, counters: () => ({ exchanges, rotations, sourceReads }), tamper: () => { body += ' ' }, corruptSource: () => { corruptSource = true }, denySource: () => { sourceStatus = 403 } }
}

void test('PKCE binds client, exact redirect and one-time state before exchange', async () => {
  const h = harness()
  const c = await h.client()
  assert.equal(c.authorizationStatus(), 'required')
  await c.beginAuthorization()
  assert.equal(c.authorizationStatus(), 'required')
  await assert.rejects(c.completeAuthorization(`${callback}?state=wrong&code=test`), /authorization_failed/)
  assert.equal(h.counters().exchanges, 0)
  await c.beginAuthorization()
  await assert.rejects(c.completeAuthorization('http://127.0.0.1:7778/callback?state=x&code=y'), /redirect_mismatch/)
  const used = await h.authorize(c)
  assert.equal(c.authorizationStatus(), 'authorized')
  await assert.rejects(c.completeAuthorization(used), /authorization_expired/)
  assert.deepEqual(await c.profile(), { id: 'usr_example', namespace: 'fixture' })
  assert.equal(h.counters().exchanges, 1)
})

void test('refresh is single-flight, rotates and revocation clears authorization without retry', async () => {
  const h = harness(); const c = await h.client(); await h.authorize(c)
  await Promise.all([c.refreshAuthorization(), c.refreshAuthorization(), c.refreshAuthorization()])
  assert.equal(h.counters().rotations, 1)
  await c.profile()
  assert.equal(h.seen.at(-1)?.auth, 'Bearer access-2')
  await c.revoke()
  assert.equal(c.authorizationStatus(), 'required')
  await assert.rejects(c.profile(), /http_401/)
  await assert.rejects(c.refreshAuthorization(), /authorization_required/)
  assert.equal(h.counters().rotations, 1)
  await c.dispose()
  await assert.rejects(c.profile(), /disposed/)
})

void test('exact release identity survives rename; CAS never receives Bearer and changed bytes fail', async () => {
  const h = harness(); const c = await h.client(); await h.authorize(c)
  const value = await c.release(h.pin)
  assert.deepEqual(value.artifact, h.artifact)
  assert.ok(h.seen.some(call => call.url.includes('/artifact') && call.auth === 'Bearer access-1'))
  assert.ok(h.seen.some(call => call.url.includes('objects.example') && call.auth === null))
  h.tamper()
  await assert.rejects(c.release(h.pin), /artifact_digest_mismatch/)
})

void test('loads only validated Plan source bytes and feeds actual prepared messages', async () => {
  const h = harness(); const c = await h.client(); await h.authorize(c)
  const loaded = await c.release(h.pin)
  const { turn } = startSession({
    artifact: loaded.artifact, bindings: h.input.bindings,
    ...(h.input.profile.locale ? { locale: h.input.profile.locale } : {}),
  })
  const input = { artifact: loaded.artifact, profile: h.input.profile, turn }
  assert.deepEqual(await c.sourceTexts(loaded, input), {})
  assert.equal(h.counters().sourceReads, 0)
  assert.equal(loaded.artifact.kind, 'content')
  if (loaded.artifact.kind !== 'content') throw new Error('content required')
  const source = loaded.artifact.catalog_index.sources[0]
  assert.ok(source)
  const plan = fixedSelection(createPreparationCatalog(input), [{ source: source.id }])
  const selected = { ...input, plan }
  const source_texts = await c.sourceTexts(loaded, selected)
  assert.ok(prepareContext({ ...selected, source_texts }).messages.some(message => message.content.includes(SOURCE)))
  h.corruptSource()
  await assert.rejects(c.sourceTexts(loaded, selected), /source_mismatch/)
  h.denySource()
  await assert.rejects(c.sourceTexts(loaded, selected), /http_403/)
  assert.equal(h.counters().sourceReads, 3)
})

void test('write requires explicit confirmation and sends only one mutation', async () => {
  const h = harness(); const c = await h.client(); await h.authorize(c)
  const draft = { name: 'new', type: 'character' as const, display_name: 'New' }
  // Deliberate caller JSON, beyond the static trusted invocation type.
  await assert.rejects(c.createWorkingDraft('fixture', draft, { confirmed: false }), /confirmation_required/)
  assert.equal(h.seen.filter(call => call.url.endsWith('/creations')).length, 0)
  assert.equal((await c.createWorkingDraft('fixture', draft, { confirmed: true })).ref, '@fixture/new')
  assert.equal(h.seen.filter(call => call.url.endsWith('/creations')).length, 1)
})


void test('rejects substituted artifact identity, unsafe CAS URLs and byte-limit violations', async () => {
  const h = harness()
  const wrong = await h.client()
  await h.authorize(wrong)
  await assert.rejects(wrong.release({ ...h.pin, semantic_digest: `sha256:${'a'.repeat(64)}` }), /release_mismatch/)
  const limited = await h.client({ maxArtifactBytes: 64 })
  await h.authorize(limited)
  await assert.rejects(limited.release(h.pin), /response_too_large/)
  const unsafe = await h.client({ fetch: async (url, init) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/artifact')) return new Response(null, { status: 302, headers: { location: 'http://attacker.example/private' } })
    return h.transport(url, init)
  } })
  await h.authorize(unsafe)
  await assert.rejects(unsafe.release(h.pin), /url_forbidden/)
})

void test('ambiguous refresh outcome clears credentials and is never automatically retried', async () => {
  const h = harness()
  let failed = 0
  const c = await h.client({ fetch: async (url, init) => {
    if (init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token') { failed++; throw new Error('network unknown outcome') }
    return h.transport(url, init)
  } })
  await h.authorize(c)
  await assert.rejects(c.refreshAuthorization(), /refresh_failed/)
  await assert.rejects(c.refreshAuthorization(), /authorization_required/)
  await assert.rejects(c.profile(), /http_401/)
  assert.equal(failed, 1)
})

void test('draft receipts bind the full origin and expire before any Source body read', async () => {
  const h = harness()
  const input = replayInput('narrator', { origin: 'draft' })
  const artifact = input.artifact
  assert.ok('origin' in artifact.root && artifact.root.origin.kind === 'draft-build')
  const origin = artifact.root.origin
  let expire = false
  const body = JSON.stringify(artifact)
  const c = await h.client({ fetch: async (url, init) => {
    const path = new URL((url instanceof Request ? url.url : url.toString())).pathname
    if (path === `/v1/draft-builds/${origin.build_id}`) return json({ origin: { ...origin, ...(expire ? { expires_at: '2020-01-01T00:00:00Z' } : {}) }, state: 'ready', draft_version: 1, semantic_digest: artifact.root.semantic_digest, lock_digest: artifact.lock_digest, artifact_digest: sha(body) })
    if (path === `/v1/draft-builds/${origin.build_id}/artifact`) return new Response(body)
    return h.transport(url, init)
  } })
  await h.authorize(c)
  assert.deepEqual((await c.draftBuild(origin.build_id)).artifact.root, artifact.root)
  expire = true
  await assert.rejects(c.draftBuild(origin.build_id), /draft_expired/)
})

void test('refresh then revoke cannot resurrect credentials from an in-flight rotated response', async () => {
  const h = harness(); const c = await h.client(); await h.authorize(c)
  await Promise.all([c.refreshAuthorization(), c.revoke()])
  await assert.rejects(c.profile(), /http_401/)
  assert.equal(h.counters().rotations, 1)
  assert.equal(h.seen.at(-1)?.auth, null)
})

void test('response body deadlines include a stalled stream after headers', async () => {
  const h = harness()
  let cancelled = false
  const c = await h.client({ timeoutMs: 20, fetch: async (url, init) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/v1/profile')) return new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise<void>(() => {}) } }))
    return h.transport(url, init)
  } })
  await h.authorize(c)
  // Retain the Node event loop while AbortSignal.timeout's unref timer expires.
  const timer = setTimeout(() => {}, 1000)
  try { await assert.rejects(c.profile(), /request_aborted/); assert.equal(cancelled, true) }
  finally { clearTimeout(timer) }
})

void test('a late refresh response cannot undo a concurrent unauthorized response', async () => {
  const h = harness()
  const rotated = Promise.withResolvers<undefined>()
  const priorRead = Promise.withResolvers<Response>()
  let waitRead = true
  const c = await h.client({ fetch: async (url, init) => {
    if (init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token') await rotated.promise
    if ((url instanceof Request ? url.url : url.toString()).endsWith('/v1/profile') && waitRead) {
      waitRead = false
      return priorRead.promise
    }
    return h.transport(url, init)
  } })
  await h.authorize(c)
  const old = c.profile()
  // Let the request capture the old access token before refresh starts.
  await Promise.resolve()
  const rotation = c.refreshAuthorization()
  priorRead.resolve(json({ error: 'invalid_token' }, 401))
  await assert.rejects(old, /http_401/)
  rotated.resolve(undefined)
  await assert.rejects(rotation, /refresh_failed/)
  await assert.rejects(c.profile(), /http_401/)
  assert.equal(h.seen.at(-1)?.auth, null)
})

void test('disposal aborts and settles an in-flight refresh without accepting late credentials', async () => {
  const h = harness()
  const began = Promise.withResolvers<undefined>()
  const c = await h.client({ fetch: async (url, init) => {
    if (init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token') {
      began.resolve(undefined)
      return new Promise<Response>(() => {})
    }
    return h.transport(url, init)
  } })
  await h.authorize(c)
  const rotation = c.refreshAuthorization()
  const rejected = assert.rejects(rotation, /refresh_failed/)
  await began.promise
  await c.dispose()
  await rejected
  await assert.rejects(c.profile(), /disposed/)
})

void test('relative CAS redirects stay on the previous object origin with no credentials', async () => {
  const h = harness()
  const c = await h.client({ fetch: async (url, init) => {
    const current = new URL(url instanceof Request ? url.url : url.toString())
    if (current.pathname.endsWith('/artifact')) return new Response(null, { status: 302, headers: { location: 'https://objects.example/dir/object' } })
    if (current.pathname === '/dir/object') return new Response(null, { status: 302, headers: { location: './next' } })
    return h.transport(url, init)
  } })
  await h.authorize(c)
  await c.release(h.pin)
  assert.ok(h.seen.some(call => call.url === 'https://objects.example/dir/next' && call.auth === null))
})


void test('an older callback does not consume a newer authorization request and a new attempt clears the old actor', async () => {
  const h = harness(); const c = await h.client(); await h.authorize(c)
  const old = await c.beginAuthorization()
  await assert.rejects(c.profile(), /http_401/)
  const latest = await c.beginAuthorization()
  const oldURL = new URL(callback)
  oldURL.search = new URLSearchParams({ code: 'old-code', state: new URL(old.authorizationURL).searchParams.get('state') ?? '' }).toString()
  await assert.rejects(c.completeAuthorization(oldURL.href), /authorization_failed/)
  await h.authorize(c, latest.authorizationURL)
  assert.equal((await c.profile()).namespace, 'fixture')
})


function baselineHarness() {
  const h = harness()
  const canonical = canonicalizeCreation({
    id: 'cr_01j00000000000000000000005', ref: '@original/character', type: 'character', display_name: 'Original',
    meta: { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' },
    fragments: [{ id: 'description', stable: true, kind: 'character', content: { type: 'text', text: 'Published author definition' } }],
  })
  const policy = canonicalizeCreation({
    id: 'cr_01j00000000000000000000006', ref: '@original/policy', type: 'preset', display_name: 'Policy',
    meta: { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' },
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const policyRelease = 'rel_01j00000000000000000000006'
  const { artifact } = buildCreation({
    root: { creation: canonical.creation, release: h.pin.release, visibility: 'private' },
    dependencies: [{ release: policyRelease, visibility: 'public', creation: policy.creation }],
    default_policy: { ref: policy.creation.ref, release: policyRelease, semantic_digest: policy.semantic_digest },
  })
  assert.ok('release' in artifact.root)
  const pin = artifact.root
  const source = { revision: 'rev_01j00000000000000000000005', semantic_digest: canonical.semantic_digest, creation: canonical.creation }
  const sourcePath = '/v1/creations/@renamed/current/releases/old-label/source'
  const calls: { path: string; method: string }[] = []
  let sourceBody: unknown = source
  let sourceStatus = 200
  let pauseAt: string | undefined
  const arrived = Promise.withResolvers<undefined>()
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const path = url.pathname
    calls.push({ path, method: init?.method ?? 'GET' })
    if (pauseAt === path) { arrived.resolve(undefined); return new Promise<Response>(() => {}) }
    if (path === `/v1/releases/${pin.release}`) return json({
      id: pin.release, ref: '@renamed/current', creation: canonical.creation.id, label: 'old-label',
      visibility: 'private', status: 'active', semantic_digest: pin.semantic_digest, effective_rating: 'general',
      created_at: '2026-10-01T00:00:00Z', artifact_digest: sha(JSON.stringify(artifact)), lock_digest: artifact.lock_digest,
      context_ir_digest: null, license_check: 'pass', availability: 'complete',
    })
    if (path === `/v1/releases/${pin.release}/artifact`) return new Response(null, { status: 302, headers: { location: 'https://objects.example/baseline-object' } })
    if (url.hostname === 'objects.example' && path === '/baseline-object') {
      assert.equal(new Headers(init?.headers).get('authorization'), null)
      return new Response(JSON.stringify(artifact))
    }
    if (path === sourcePath) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer access-1')
      return json(sourceBody, sourceStatus)
    }
    return h.transport(input, init)
  }
  return { h, pin, source, sourcePath, calls, arrived,
    client: () => h.client({ fetch: transport }),
    sourceBody: (value: unknown) => { sourceBody = value },
    deny: () => { sourceStatus = 403 },
    pause: (path: string) => { pauseAt = path },
  }
}

void test('release source uses the current address with the exact label and retains the original author definition', async () => {
  const h = baselineHarness(); const c = await h.client(); await h.h.authorize(c)
  h.calls.length = 0
  const result = await c.releaseSource(h.pin)
  assert.deepEqual(result.source, h.source)
  assert.equal(result.source.creation.ref, '@original/character')
  assert.equal('ref' in result.release.receipt ? result.release.receipt.ref : undefined, '@renamed/current')
  assert.deepEqual(h.calls, [
    { path: `/v1/releases/${h.pin.release}`, method: 'GET' },
    { path: `/v1/releases/${h.pin.release}/artifact`, method: 'GET' },
    { path: '/baseline-object', method: 'GET' },
    { path: h.sourcePath, method: 'GET' },
  ])
  assert.equal(JSON.stringify(result).includes('access-1'), false)
  await c.dispose()
})

void test('release source rejects malformed data, altered bodies, mismatched digests, refs and Revision identifiers', async () => {
  const h = baselineHarness(); const c = await h.client(); await h.h.authorize(c)
  for (const source of [
    {},
    { ...h.source, creation: { ...h.source.creation, type: 'not-a-creation' } },
    { ...h.source, semantic_digest: `sha256:${'f'.repeat(64)}` },
    { ...h.source, creation: { ...h.source.creation, display_name: 'Replaced body' } },
    { ...h.source, creation: { ...h.source.creation, ref: '@renamed/current' } },
    { ...h.source, revision: 'not-a-revision' },
  ]) {
    h.sourceBody(source)
    await assert.rejects(c.releaseSource(h.pin))
  }
  assert.equal(h.calls.some(call => call.path.includes('latest')), false)
  await c.dispose()
})

void test('release source does not substitute IR or a newer source when access is denied', async () => {
  const h = baselineHarness(); const c = await h.client(); await h.h.authorize(c)
  h.calls.length = 0
  h.deny()
  await assert.rejects(c.releaseSource(h.pin), /http_403/)
  assert.equal(h.calls.filter(call => call.path.endsWith('/source')).length, 1)
  assert.equal(h.calls.every(call => call.method === 'GET'), true)
  assert.equal(h.calls.some(call => call.path.includes('latest')), false)
  await c.dispose()
})

void test('an already cancelled source read issues no requests or writes', async () => {
  const h = baselineHarness(); const c = await h.client(); await h.h.authorize(c)
  h.calls.length = 0
  const abort = new AbortController(); abort.abort()
  await assert.rejects(c.releaseSource(h.pin, abort.signal), /request_aborted/)
  assert.deepEqual(h.calls, [])
  await c.dispose()
})

for (const stage of ['metadata', 'object', 'source']) {
  void test(`cancelling a ${stage} read returns no partial source and never writes or falls back`, async () => {
    const h = baselineHarness(); const c = await h.client(); await h.h.authorize(c)
    h.calls.length = 0
    h.pause(stage === 'metadata' ? `/v1/releases/${h.pin.release}` : stage === 'object' ? '/baseline-object' : h.sourcePath)
    const abort = new AbortController()
    const pending = c.releaseSource(h.pin, abort.signal)
    const rejected = assert.rejects(pending, /request_aborted/)
    await h.arrived.promise
    abort.abort()
    await rejected
    assert.equal(h.calls.every(call => call.method === 'GET'), true)
    assert.equal(h.calls.some(call => call.path.includes('latest')), false)
    if (stage !== 'source') assert.equal(h.calls.some(call => call.path === h.sourcePath), false)
    await c.dispose()
  })
}

void test('review-bound contribution writes require an authorized grant and reject a newer login without posting', async () => {
  const h = harness(); const c = await h.client()
  const input = { title: 'Proposal', base_revision: 'rev_01j00000000000000000000000',
    changes: [{ on: 'story', kind: 'ending', id: 'escape', op: 'add', after: { id: 'escape', title: 'Escape', description: 'Leave' } }],
    agent: true, rights_ack: { inbound_equals_outbound: true as const } }
  const anonymous = c.authorizationVersion()
  await assert.rejects(c.contribute('@fixture/inn', input, { confirmed: true, expectedAuthorizationVersion: anonymous }), /authorization_changed/)
  await h.authorize(c)
  const original = c.authorizationVersion()
  assert.notEqual(original, anonymous)
  const pending = await c.beginAuthorization()
  const intermediate = c.authorizationVersion()
  await h.authorize(c, pending.authorizationURL)
  assert.notEqual(c.authorizationVersion(), intermediate)
  await assert.rejects(c.contribute('@fixture/inn', input, { confirmed: true, expectedAuthorizationVersion: original }), /authorization_changed/)
  assert.equal(h.seen.some(call => call.url.includes('/contributions')), false)
  await c.dispose()
})

void test('same-grant refresh preserves a review epoch while an authorization loss during access prevents POST', async () => {
  const h = harness()
  const arrived = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  let hold = false
  const c = await h.client({ fetch: async (url, init) => {
    if (hold && init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token') {
      arrived.resolve(undefined); await resume.promise
    }
    return h.transport(url, init)
  } })
  await h.authorize(c)
  const version = c.authorizationVersion()
  await c.refreshAuthorization()
  assert.equal(c.authorizationVersion(), version)
  // Disposal invalidates the epoch synchronously and aborts refresh: queued writes must not escape afterward.
  hold = true
  const rotation = c.refreshAuthorization()
  const rejectedRotation = assert.rejects(rotation, /refresh_failed/)
  await arrived.promise
  const input = { title: 'Proposal', base_revision: 'rev_01j00000000000000000000000', changes: [{ on: 'meta' }],
    rights_ack: { inbound_equals_outbound: true as const }, agent: true }
  const write = c.contribute('@fixture/inn', input, { confirmed: true, expectedAuthorizationVersion: version })
  const rejectedWrite = assert.rejects(write, /refresh_failed|authorization_changed|disposed/)
  const disposed = c.dispose()
  resume.resolve(undefined)
  await Promise.all([rejectedRotation, rejectedWrite, disposed])
  assert.notEqual(c.authorizationVersion(), version)
  assert.equal(h.seen.some(call => call.url.includes('/contributions')), false)
})

void test('optional read cancellation reaches artifact transport and pre-cancelled reads make no request', async () => {
  const fixture = harness()
  const controller = new AbortController()
  const reached = Promise.withResolvers<null>()
  let transportCancelled = false
  const client = await fixture.client({ fetch: async (url, init) => {
    if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/artifact')) {
      reached.resolve(null)
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        assert.ok(signal)
        const cancel = () => { transportCancelled = true; reject(new DOMException('Aborted', 'AbortError')) }
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
      })
    }
    return fixture.transport(url, init)
  } })
  try {
    await fixture.authorize(client)
    const pending = client.release(fixture.pin, controller.signal)
    await reached.promise
    controller.abort()
    await assert.rejects(pending, /request_aborted/)
    assert.equal(transportCancelled, true)
    const count = fixture.seen.length
    await assert.rejects(client.release(fixture.pin, controller.signal), /request_aborted/)
    await assert.rejects(client.draftBuild('dbld_01j00000000000000000000000', controller.signal), /request_aborted/)
    await assert.rejects(client.receipt('dbld_01j00000000000000000000000', controller.signal), /request_aborted/)
    assert.equal(fixture.seen.length, count)
  } finally { await client.dispose() }
})
