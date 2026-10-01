/** New sequel review tests consume packed SDK contracts and preserve committed Session records. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCreation, canonicalizeCreation, lateSlotKey, PRESET_REGIONS, sha256Hex } from '@char-pub/core'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ReplayInput } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { createStoryContinuations } from '../src/story-continuation.ts'
import { makeOpened, makeRequested, projectRoleplay } from '../src/projection.ts'
import type { RegistryClient } from '../src/registry/client.ts'
import { command } from '../../charpub-roleplay/tests/fixtures.ts'
import { historyLoader } from './fixtures/history-loader.ts'

const rights = { inbound_equals_outbound: true as const }
const session = SessionId('continuation-story')
const PRIVATE_SOURCE = 'PRIVATE_SOURCE_NOT_A_NEW_STORY_OPENING'
function fixture() {
  const source = canonicalizeCreation({
    id: 'cr_01j00000000000000000000000', ref: '@author/story', type: 'scenario', display_name: 'Story',
    meta: { default_locale: 'en', rating: 'teen', content_warnings: ['fear'], license: 'CC0-1.0', rights: 'original' },
    cast: [{ key: 'host', who: { late: 'character' } }],
    fragments: [{ id: 'fact', stable: true, kind: 'knowledge', content: { type: 'text', text: 'A guarded fact' } }],
    sources: [{ id: 'report', title: 'Report', description: 'Reference', asset: 'report', format: 'text' }],
    assets: [{ slot: 'report', role: 'context', variants: [{ id: 'default', media_type: 'text/plain',
      blob: { digest: `sha256:${sha256Hex(PRIVATE_SOURCE)}`, size: Buffer.byteLength(PRIVATE_SOURCE), availability: 'mirrored' } }] }],
    story: { version: 1, scenes: [{ id: 'lobby', title: 'Lobby', lore: ['#source/report'] }],
      vars: { trust: { type: 'int', init: 0, min: 0, max: 10, description: 'Trust' } },
      knowing: { '#fact': { start: { knows: [] }, enter: { lobby: { knows: ['host'] } } } },
      starts: [{ id: 'arrival', scene: 'lobby', set: [{ add: ['var/trust', 2] }], greeting: 'PRIVATE_OLD_GREETING' }],
      endings: [{ id: 'stop', title: 'Stop', description: 'Stop', effects: [{ add: ['var/trust', 3] }] }],
    },
  })
  const policy = canonicalizeCreation({ id: 'cr_01j00000000000000000000001', ref: '@author/policy', type: 'preset', display_name: 'Policy',
    meta: { default_locale: 'en', rating: 'mature', content_warnings: ['policy-warning'], license: 'CC0-1.0', rights: 'original' },
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const release = 'rel_01j00000000000000000000000'
  const policyRelease = 'rel_01j00000000000000000000001'
  const { artifact } = buildCreation({ root: { creation: source.creation, release, visibility: 'private' },
    dependencies: [{ creation: policy.creation, release: policyRelease, visibility: 'public' }],
    default_policy: { ref: policy.creation.ref, release: policyRelease, semantic_digest: policy.semantic_digest },
  })
  assert.equal(artifact.kind, 'content')
  if (artifact.kind !== 'content') throw new Error('content required')
  const input: ReplayInput = { artifact, profile: { runtime: { name: 'continuation-test', version: '1' }, tokenizer: 'estimate',
    mode: 'narrator', context_window: 8192, reserve_for_output: 512, capabilities: { system_role: true, multiple_system_messages: true } },
  bindings: { user: { kind: 'persona', display_name: 'PRIVATE_PLAYER' },
    [lateSlotKey('root', 'host')]: { kind: 'character', display_name: 'PRIVATE_HOST' } },
  support: { supported: artifact.capabilities.map(c => c.id) },
  source_texts: Object.fromEntries(artifact.catalog_index.sources.map(source => [source.asset, PRIVATE_SOURCE])) }
  let current = projectRoleplay([{ type: 'roleplay/opened', seq: SessionSeq(0), time: 0, data: makeOpened(input) }])
  let version = 2
  const posts: { namespace: string; body: Parameters<RegistryClient['derive']>[1] }[] = []
  const registry: Pick<RegistryClient, 'releaseSource' | 'derive' | 'authorizationVersion'> = {
    authorizationVersion: () => version,
    async releaseSource(exact) {
      assert.deepEqual(exact, artifact.root)
      return { release: { artifact, receipt: { id: release, ref: '@renamed/story', creation: source.creation.id, label: 'old', visibility: 'private',
        status: 'active', semantic_digest: source.semantic_digest, effective_rating: 'mature', created_at: '2026-10-01T00:00:00Z',
        lock_digest: artifact.lock_digest, context_ir_digest: null, license_check: null, availability: null } },
      source: { revision: 'rev_01j00000000000000000000000', semantic_digest: source.semantic_digest, creation: source.creation } }
    },
    async derive(namespace, body, confirmation) {
      assert.equal(confirmation.expectedAuthorizationVersion, version)
      posts.push({ namespace, body: structuredClone(body) })
      return { id: 'cr_01j00000000000000000000003', ref: `@${namespace}/${body.name}`, type: 'scenario' }
    },
  }
  const services = { registry, inspect: async () => current }
  const continuations = createStoryContinuations(services)
  const intent = { session, namespace: 'player', name: 'next-story', display_name: 'Next story',
    opening: { en: 'REVIEWED SUMMARY e\u0301\r\n  ', ja: '次の物語' }, agent: false, rights_ack: rights }
  return { input, source, registry, services, continuations, posts, intent, current: () => current,
    replace: (value: typeof current) => { current = value }, changeAuthorization: () => { version++ } }
}

void test('reviews an exact published baseline and sends only a new sequel request after confirmation', async () => {
  const h = fixture(); const review = await h.continuations.prepare(h.intent)
  assert.equal(review.source.exact.ref, '@author/story')
  assert.equal(review.source.label, 'old')
  assert.deepEqual(review.target, { namespace: 'player', name: 'next-story', display_name: 'Next story' })
  assert.equal(review.metadata.source_rating, 'teen')
  assert.equal(review.metadata.effective_rating, 'mature')
  assert.ok(review.metadata.effective_content_warnings.includes('policy-warning'))
  assert.deepEqual(review.request.from_play, { scene: 'lobby', present: ['host'], vars: { trust: 2 },
    knowing: { '#fact': ['host'] }, opening: h.intent.opening })
  assert.deepEqual(review.reset, { visited: 'opening-scene-only', reached: [], ended: [], happened: [], stopped: false })
  assert.equal(review.request.agent, false)
  assert.equal(h.posts.length, 0)
  const result = await h.continuations.submit(review, { candidate_digest: review.digest, rights_ack: rights })
  assert.equal(result.ref, '@player/next-story')
  assert.deepEqual(Object.keys(h.posts[0]?.body ?? {}).sort(), ['agent', 'display_name', 'from_play', 'kind', 'name', 'rights_ack', 'source'])
  assert.equal(h.posts[0]?.namespace, 'player')
  await assert.rejects(h.continuations.submit(review, { candidate_digest: review.digest, rights_ack: rights }), /already_submitted/)
  assert.equal(h.posts.length, 1)
})

void test('rejects pending, nonpublished and invalid committed state without creating a work', async () => {
  const h = fixture(); const current = h.current()
  h.replace({ ...current, pending: makeRequested(current, 'pending', command('pending', { kind: 'prepare' }), { provider: 'fixed', model: 'fixed' }) })
  await assert.rejects(h.continuations.prepare(h.intent), /request_pending/)
  h.replace({ ...current, log: { ...current.log, input: { ...current.log.input, artifact: {
    ...h.input.artifact, root: { ref: '@author/story', semantic_digest: h.input.artifact.root.semantic_digest,
      origin: { kind: 'local-build', input_digest: `sha256:${'a'.repeat(64)}` } },
  } } } })
  await assert.rejects(h.continuations.prepare(h.intent), /published_story_required/)
  h.replace({ ...current, current: { ...current.current, state: { ...current.current.state, vars: { trust: 999 } } } })
  await assert.rejects(h.continuations.prepare(h.intent), /story.invalid_state/)
  h.replace(current)
  await assert.rejects(h.continuations.prepare({ ...h.intent, namespace: 'invalid/path' }))
  assert.equal(h.posts.length, 0)
})

void test('requires the original unmodified review, exact confirmation and unchanged committed snapshot', async () => {
  const h = fixture(); const review = await h.continuations.prepare(h.intent)
  const confirmation = { candidate_digest: review.digest, rights_ack: rights }
  await assert.rejects(h.continuations.submit(structuredClone(review), confirmation), /unknown_review/)
  await assert.rejects(h.continuations.submit(review, { ...confirmation, candidate_digest: 'wrong' }), /confirmation_mismatch/)
  review.target.name = 'other'
  await assert.rejects(h.continuations.submit(review, confirmation), /review_changed/)
  review.target.name = h.intent.name
  const fromPlay = review.request.from_play
  assert.ok(fromPlay)
  fromPlay.opening = 'Different opening'
  await assert.rejects(h.continuations.submit(review, confirmation), /review_changed/)
  fromPlay.opening = h.intent.opening
  h.replace({ ...h.current(), head: `sha256:${'a'.repeat(64)}` })
  await assert.rejects(h.continuations.submit(review, confirmation), /session_changed/)
  assert.equal(h.posts.length, 0)
})

void test('cancellation before dispatch is zero write, but uncertain outcomes and explicit rejection consume attempts', async () => {
  const h = fixture(); const abort = new AbortController(); abort.abort()
  await assert.rejects(h.continuations.prepare(h.intent, abort.signal), /cancelled/)
  const review = await h.continuations.prepare(h.intent)
  const confirmation = { candidate_digest: review.digest, rights_ack: rights }
  await assert.rejects(h.continuations.submit(review, confirmation, abort.signal), /cancelled/)
  assert.equal(h.posts.length, 0)
  h.registry.derive = async (_namespace, _body, _confirmation, signal) => { assert.equal(signal?.aborted, false); throw new Error('unparseable response') }
  const live = new AbortController()
  await assert.rejects(h.continuations.submit(review, confirmation, live.signal), /roleplay_continuation.outcome_unknown/)
  await assert.rejects(h.continuations.submit(review, confirmation), /already_submitted/)
  const next = await h.continuations.prepare(h.intent)
  h.registry.derive = async () => { throw new Error('registry.http_403') }
  await assert.rejects(h.continuations.submit(next, { candidate_digest: next.digest, rights_ack: rights }), /^Error: registry.http_403$/)
  await assert.rejects(h.continuations.submit(next, { candidate_digest: next.digest, rights_ack: rights }), /already_submitted/)
})

void test('authorization changes during preparation and after review cannot redirect a reviewed request to another account', async () => {
  const h = fixture(); const review = await h.continuations.prepare(h.intent)
  h.changeAuthorization()
  await assert.rejects(h.continuations.submit(review, { candidate_digest: review.digest, rights_ack: rights }), /authorization_changed/)
  const load = h.registry.releaseSource
  h.registry.releaseSource = async (...args) => { const baseline = await load(...args); h.changeAuthorization(); return baseline }
  await assert.rejects(h.continuations.prepare(h.intent), /authorization_changed/)
  assert.equal(h.posts.length, 0)
})

void test('double click and asynchronous review mutation are rejected before any dispatch', async () => {
  const h = fixture()
  const arrived = Promise.withResolvers<undefined>(); const resume = Promise.withResolvers<undefined>()
  let pause = false
  const continuations = createStoryContinuations({ registry: h.registry, inspect: async () => {
    if (pause) { arrived.resolve(undefined); await resume.promise }
    return h.current()
  } })
  const review = await continuations.prepare(h.intent)
  const confirmation = { candidate_digest: review.digest, rights_ack: rights }
  pause = true
  const submit = continuations.submit(review, confirmation)
  await arrived.promise
  await assert.rejects(continuations.submit(review, confirmation), /already_submitted/)
  review.request.agent = true
  resume.resolve(undefined)
  await assert.rejects(submit, /review_changed/)
  assert.equal(h.posts.length, 0)
})

void test('captures the original service instances and rechecks authorization after asynchronous inspection', async () => {
  const h = fixture(); const other = fixture()
  const review = await h.continuations.prepare(h.intent)
  h.services.registry = other.registry
  h.services.inspect = async () => other.current()
  await h.continuations.submit(review, { candidate_digest: review.digest, rights_ack: rights })
  assert.equal(h.posts.length, 1)
  assert.equal(other.posts.length, 0)
  let change = false
  const factory = createStoryContinuations({ registry: h.registry, inspect: async () => {
    if (change) h.changeAuthorization()
    return h.current()
  } })
  const next = await factory.prepare(h.intent)
  change = true
  await assert.rejects(factory.submit(next, { candidate_digest: next.digest, rights_ack: rights }), /authorization_changed/)
  assert.equal(h.posts.length, 1)
})

void test('a real stopped Session supplies current values but its chat, sources and JSONL never enter or change with the request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'story-continuation-'))
  const ctx = await historyLoader(root)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const h = fixture()
  await ctx.roleplayRuntime.create(session, h.input)
  await ctx.roleplayRuntime.submit(session, command('private-turn', { kind: 'input', text: 'PRIVATE_CHAT_NOT_FOR_SEQUEL' }),
    { provider: 'roleplay-test', model: 'fixed', maxTokens: 128 })
  await ctx.roleplayRuntime.submit(session, command('stop', { kind: 'confirm', target: 'ending/stop' }),
    { provider: 'roleplay-test', model: 'fixed', maxTokens: 128 })
  assert.ok(JSON.stringify(ctx.roleplayTestProvider.calls[0]?.messages).includes(PRIVATE_SOURCE))
  const current = await ctx.roleplayRuntime.inspect(session)
  assert.equal(current.current.state.stopped, true)
  assert.equal(current.current.state.vars.trust, 5)
  const files = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'))
  assert.ok(files.length > 0)
  const before = await Promise.all(files.map(path => readFile(join(root, 'sessions', path))))
  const factory = createStoryContinuations({ registry: h.registry, inspect: id => ctx.roleplayRuntime.inspect(id) })
  const review = await factory.prepare({ ...h.intent, agent: true })
  assert.deepEqual(review.request.from_play?.vars, { trust: 5 })
  assert.equal(review.reset.stopped, false)
  assert.equal(review.request.agent, true)
  await factory.submit(review, { candidate_digest: review.digest, rights_ack: rights })
  for (const excluded of [PRIVATE_SOURCE, 'PRIVATE_CHAT_NOT_FOR_SEQUEL', 'PRIVATE_PLAYER', 'PRIVATE_HOST', 'PRIVATE_OLD_GREETING',
    'history', 'stream', 'source_texts', 'bindings', 'state_digest', 'authorization_version', 'reached', 'stopped'])
    assert.equal(JSON.stringify(h.posts[0]?.body).includes(excluded), false, excluded)
  assert.deepEqual(await Promise.all(files.map(path => readFile(join(root, 'sessions', path)))), before)
  assert.equal((await ctx.roleplayRuntime.inspect(session)).head, current.head)
})

void test('inspection-boundary state changes or cancellation cannot dispatch; concurrent unchanged confirmation dispatches once', async () => {
  for (const scenario of ['state', 'cancel', 'success']) {
    const h = fixture()
    const arrived = Promise.withResolvers<undefined>(); const resume = Promise.withResolvers<undefined>()
    const abort = new AbortController()
    let paused = false
    const factory = createStoryContinuations({ registry: h.registry, inspect: async () => {
      if (paused) { arrived.resolve(undefined); await resume.promise }
      return h.current()
    } })
    const review = await factory.prepare(h.intent)
    const confirmation = { candidate_digest: review.digest, rights_ack: rights }
    paused = true
    const pending = factory.submit(review, confirmation, abort.signal)
    await arrived.promise
    await assert.rejects(factory.submit(review, confirmation), /already_submitted/)
    if (scenario === 'state') h.replace({ ...h.current(), current: { ...h.current().current,
      state: { ...h.current().current.state, vars: { trust: 3 } } } })
    if (scenario === 'cancel') abort.abort()
    resume.resolve(undefined)
    if (scenario === 'success') {
      await pending
      assert.equal(h.posts.length, 1)
      await assert.rejects(factory.submit(review, confirmation), /already_submitted/)
    } else {
      await assert.rejects(pending, scenario === 'state' ? /session_changed/ : /cancelled/)
      assert.equal(h.posts.length, 0)
    }
  }
})
