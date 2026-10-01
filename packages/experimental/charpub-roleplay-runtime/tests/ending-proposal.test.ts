/** Local proposal tests use public packed Core and committed Session projections; no model or network calls. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCreation, canonicalizeCreation, lateSlotKey, PRESET_REGIONS, sha256Hex } from '@char-pub/core'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ReplayInput } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { createEndingProposals } from '../src/ending-proposal.ts'
import { makeOpened, makeRequested, projectRoleplay } from '../src/projection.ts'
import type { RegistryClient } from '../src/registry/client.ts'
import { command } from '../../charpub-roleplay/tests/fixtures.ts'
import { historyLoader } from './fixtures/history-loader.ts'

const rights = { inbound_equals_outbound: true as const }
const session = SessionId('proposal-story')
const PRIVATE_SOURCE = 'PRIVATE_SOURCE_NOT_FOR_PUBLICATION'
function fixture(withSource = false) {
  const source = canonicalizeCreation({
    id: 'cr_01j00000000000000000000000', ref: '@author/story', type: 'scenario', display_name: 'Story',
    meta: { default_locale: 'en', rating: 'teen', content_warnings: ['fear'], license: 'CC0-1.0', rights: 'original' },
    cast: [{ key: 'host', who: { late: 'character' } }],
    ...(withSource ? {
      sources: [{ id: 'report', title: 'Private report', description: 'Local reference', asset: 'report', format: 'text' }],
      assets: [{ slot: 'report', role: 'context', variants: [{ id: 'default', media_type: 'text/plain',
        blob: { digest: `sha256:${sha256Hex(PRIVATE_SOURCE)}`, size: new TextEncoder().encode(PRIVATE_SOURCE).byteLength,
          availability: 'mirrored' } }] }],
    } : {}),
    story: { version: 1, scenes: [{ id: 'lobby', title: 'Lobby', ...(withSource ? { lore: ['#source/report'] } : {}) }],
      vars: { trust: { type: 'int', init: 0, min: 0, max: 1, description: 'Trust' } },
      endings: [{ id: 'original', title: 'Original', description: 'Original ending', after: 'continue' }],
    },
  })
  const policy = canonicalizeCreation({ id: 'cr_01j00000000000000000000001', ref: '@author/policy', type: 'preset', display_name: 'Policy',
    meta: { default_locale: 'en', rating: 'general', license: 'CC0-1.0', rights: 'original' },
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const release = 'rel_01j00000000000000000000000'
  const policyRelease = 'rel_01j00000000000000000000001'
  const { artifact } = buildCreation({ root: { creation: source.creation, release, visibility: 'private' },
    dependencies: [{ creation: policy.creation, release: policyRelease, visibility: 'public' }],
    default_policy: { ref: policy.creation.ref, release: policyRelease, semantic_digest: policy.semantic_digest },
  })
  const input: ReplayInput = { artifact, profile: { runtime: { name: 'proposal-test', version: '1' }, tokenizer: 'estimate',
    mode: 'narrator', context_window: 4096, reserve_for_output: 512, capabilities: { system_role: true, multiple_system_messages: true } },
  bindings: { user: { kind: 'persona', display_name: 'Guest' }, [lateSlotKey('root', 'host')]: { kind: 'character', display_name: 'Host' } },
  support: { supported: artifact.capabilities.map(c => c.id) }, source_texts: artifact.kind === 'content' && withSource
    ? Object.fromEntries(artifact.catalog_index.sources.map(source => [source.asset, PRIVATE_SOURCE])) : {} }
  let current = projectRoleplay([{ type: 'roleplay/opened', seq: SessionSeq(0), time: 0, data: makeOpened(input) }])
  let version = 2
  const posts: { target: string; body: Parameters<RegistryClient['contribute']>[1] }[] = []
  const registry: Pick<RegistryClient, 'releaseSource' | 'contribute' | 'authorizationVersion'> = {
    authorizationVersion: () => version,
    async releaseSource(exact) {
      assert.deepEqual(exact, artifact.root)
      return { release: { artifact, receipt: { id: release, ref: '@renamed/story', creation: source.creation.id, label: 'old', visibility: 'private',
        status: 'active', semantic_digest: source.semantic_digest, effective_rating: 'teen', created_at: '2026-10-01T00:00:00Z',
        lock_digest: artifact.lock_digest, context_ir_digest: null, license_check: null, availability: null } },
      source: { revision: 'rev_01j00000000000000000000000', semantic_digest: source.semantic_digest, creation: source.creation } }
    },
    async contribute(target, body, confirmation) {
      assert.equal(confirmation.expectedAuthorizationVersion, version)
      posts.push({ target, body: structuredClone(body) })
      return { id: 'ctr_fixture', number: 1, status: 'open', agent: true, sensitive_keys: [] }
    },
  }
  const inspect = async () => current
  const proposals = createEndingProposals({ registry, inspect })
  const intent = { session, title: 'New ending from play', ending: { id: 'escape', title: 'Escape', description: 'The guests leave safely.', when: { in: 'scene/lobby' }, after: 'stop' }, rights_ack: rights }
  return { input, source, registry, proposals, posts, intent, current: () => current,
    replace: (value: typeof current) => { current = value },
    changeAuthorization: () => { version++ } }
}

void test('prepares only an Ending and its order against the exact original baseline, then sends only reviewed fields', async () => {
  const h = fixture()
  const candidate = await h.proposals.prepare(h.intent)
  assert.equal(candidate.target.ref, '@renamed/story')
  assert.equal(candidate.target.source.ref, '@author/story')
  assert.equal(candidate.target.label, 'old')
  assert.deepEqual(candidate.metadata, { source_rating: 'teen', source_license: 'CC0-1.0', source_content_warnings: ['fear'] })
  assert.equal(candidate.request.agent, true)
  assert.equal(candidate.request.changes.length, 2)
  const order = candidate.request.changes[1]
  assert.ok(order && typeof order === 'object')
  assert.deepEqual(Reflect.get(order, 'after'), ['original', 'escape'])
  assert.match(String(Reflect.get(order, 'base_digest')), /^sha256:[0-9a-f]{64}$/)
  assert.equal(h.posts.length, 0)
  const result = await h.proposals.submit(candidate, { candidate_digest: candidate.digest, rights_ack: rights })
  assert.equal(result.number, 1)
  assert.deepEqual(Object.keys(h.posts[0]?.body ?? {}).sort(), ['agent', 'base_revision', 'changes', 'changes_version', 'rights_ack', 'title'])
  assert.equal(h.posts[0]?.target, '@renamed/story')
  await assert.rejects(h.proposals.submit(candidate, { candidate_digest: candidate.digest, rights_ack: rights }), /already_submitted/)
  assert.equal(h.posts.length, 1)
})

void test('refuses duplicate or invalid Ending objects and pending or nonpublished sessions without posting', async () => {
  const h = fixture()
  await assert.rejects(h.proposals.prepare({ ...h.intent, ending: { ...h.intent.ending, id: 'original' } }), /ending_exists/)
  await assert.rejects(h.proposals.prepare({ ...h.intent, ending: { ...h.intent.ending, when: { in: 'scene/missing' } } }), /invalid_ending/)
  await assert.rejects(h.proposals.prepare({ ...h.intent, ending: { ...h.intent.ending, history: ['private'] } }))
  const current = h.current()
  h.replace({ ...current, pending: makeRequested(current, 'pending', command('pending', { kind: 'prepare' }), { provider: 'fixed', model: 'fixed' }) })
  await assert.rejects(h.proposals.prepare(h.intent), /request_pending/)
  h.replace({ ...current, log: { ...current.log, input: { ...current.log.input, artifact: {
    ...h.input.artifact, root: { ref: '@author/story', semantic_digest: h.input.artifact.root.semantic_digest,
      origin: { kind: 'local-build', input_digest: `sha256:${'a'.repeat(64)}` } },
  } } } })
  await assert.rejects(h.proposals.prepare(h.intent), /published_story_required/)
  assert.equal(h.posts.length, 0)
})

void test('rejects forged or mutated reviews, wrong rights and stale committed state', async () => {
  const h = fixture(); const candidate = await h.proposals.prepare(h.intent)
  const confirmation = { candidate_digest: candidate.digest, rights_ack: rights }
  await assert.rejects(h.proposals.submit(structuredClone(candidate), confirmation), /unknown_review/)
  await assert.rejects(h.proposals.submit(candidate, { ...confirmation, candidate_digest: 'wrong' }), /confirmation_mismatch/)
  await assert.rejects(h.proposals.submit(candidate, { ...confirmation, rights_ack: { explicit_grant: true } }), /confirmation_mismatch/)
  candidate.request.title += ' changed'
  await assert.rejects(h.proposals.submit(candidate, confirmation), /review_changed/)
  candidate.request.title = 'New ending from play'
  h.replace({ ...h.current(), head: `sha256:${'a'.repeat(64)}` })
  await assert.rejects(h.proposals.submit(candidate, confirmation), /session_changed/)
  assert.equal(h.posts.length, 0)
})

void test('cancelled review submission makes no POST, while unknown dispatched outcomes consume the ticket', async () => {
  const h = fixture(); const candidate = await h.proposals.prepare(h.intent)
  const confirmation = { candidate_digest: candidate.digest, rights_ack: rights }
  const abort = new AbortController(); abort.abort()
  await assert.rejects(h.proposals.submit(candidate, confirmation, abort.signal), /cancelled/)
  assert.equal(h.posts.length, 0)
  h.registry.contribute = async () => { h.posts.push({ target: candidate.target.ref, body: candidate.request }); throw new Error('network outcome unknown') }
  await assert.rejects(h.proposals.submit(candidate, confirmation), /outcome_unknown/)
  await assert.rejects(h.proposals.submit(candidate, confirmation), /already_submitted/)
  assert.equal(h.posts.length, 1)
})

void test('authorization changes invalidate prepared reviews, including changes during preparation', async () => {
  const h = fixture(); const candidate = await h.proposals.prepare(h.intent)
  h.changeAuthorization()
  await assert.rejects(h.proposals.submit(candidate, { candidate_digest: candidate.digest, rights_ack: rights }), /authorization_changed/)
  const load = h.registry.releaseSource
  h.registry.releaseSource = async (...args) => { const value = await load(...args); h.changeAuthorization(); return value }
  await assert.rejects(h.proposals.prepare(h.intent), /authorization_changed/)
  assert.equal(h.posts.length, 0)
})

void test('real persisted Session remains unchanged and no chat, stream or loaded Source enters the contribution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ending-proposal-'))
  const ctx = await historyLoader(root)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const h = fixture(true)
  await ctx.roleplayRuntime.create(session, h.input)
  await ctx.roleplayRuntime.submit(session, command('private-turn', { kind: 'input', text: 'PRIVATE_CHAT_NOT_FOR_PUBLICATION' }),
    { provider: 'roleplay-test', model: 'fixed', maxTokens: 128 })
  assert.ok(JSON.stringify(ctx.roleplayTestProvider.calls[0]?.messages).includes(PRIVATE_SOURCE))
  const files = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'))
  assert.ok(files.length > 0)
  const before = await Promise.all(files.map(path => readFile(join(root, 'sessions', path))))
  const proposals = createEndingProposals({ registry: h.registry, inspect: id => ctx.roleplayRuntime.inspect(id) })
  const candidate = await proposals.prepare(h.intent)
  assert.equal(JSON.stringify(candidate).includes('PRIVATE_CHAT_NOT_FOR_PUBLICATION'), false)
  assert.equal(JSON.stringify(candidate).includes(PRIVATE_SOURCE), false)
  await proposals.submit(candidate, { candidate_digest: candidate.digest, rights_ack: rights })
  const body = JSON.stringify(h.posts[0]?.body)
  for (const excluded of ['PRIVATE_CHAT_NOT_FOR_PUBLICATION', PRIVATE_SOURCE, 'history', 'stream', 'source_texts', 'bindings', 'state_digest', 'authorization_version'])
    assert.equal(body.includes(excluded), false)
  assert.deepEqual(await Promise.all(files.map(path => readFile(join(root, 'sessions', path)))), before)
})

void test('double submission while inspecting cannot dispatch twice and a changed grant is rechecked after inspect', async () => {
  const h = fixture()
  const arrived = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  let paused = false
  const proposals = createEndingProposals({ registry: h.registry, inspect: async () => {
    if (paused) { arrived.resolve(undefined); await resume.promise }
    return h.current()
  } })
  const candidate = await proposals.prepare(h.intent)
  paused = true
  const confirmation = { candidate_digest: candidate.digest, rights_ack: rights }
  const first = proposals.submit(candidate, confirmation)
  const rejected = assert.rejects(first, /authorization_changed/)
  await arrived.promise
  await assert.rejects(proposals.submit(candidate, confirmation), /already_submitted/)
  h.changeAuthorization()
  resume.resolve(undefined)
  await rejected
  assert.equal(h.posts.length, 0)
})

void test('dispatch failures distinguish explicit HTTP rejection from unknown response or cancellation outcomes', async () => {
  for (const [failure, expected] of [
    ['registry.http_403', 'registry.http_403'],
    ['response validation failed', 'roleplay_proposal.outcome_unknown'],
    ['registry.request_aborted', 'roleplay_proposal.outcome_unknown'],
  ]) {
    const h = fixture()
    const candidate = await h.proposals.prepare(h.intent)
    let attempts = 0
    h.registry.contribute = async () => { attempts++; throw new Error(failure) }
    const confirmation = { candidate_digest: candidate.digest, rights_ack: rights }
    await assert.rejects(h.proposals.submit(candidate, confirmation), { message: expected })
    await assert.rejects(h.proposals.submit(candidate, confirmation), /already_submitted/)
    assert.equal(attempts, 1)
  }
})

void test('replacing the caller service container cannot retarget a reviewed proposal to another client', async () => {
  const first = fixture(); const second = fixture()
  const services = { registry: first.registry, inspect: async () => first.current() }
  const proposals = createEndingProposals(services)
  const candidate = await proposals.prepare(first.intent)
  services.registry = second.registry
  services.inspect = async () => second.current()
  await proposals.submit(candidate, { candidate_digest: candidate.digest, rights_ack: rights })
  assert.equal(first.posts.length, 1)
  assert.equal(second.posts.length, 0)
})
