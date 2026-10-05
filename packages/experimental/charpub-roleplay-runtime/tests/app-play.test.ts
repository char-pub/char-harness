/** Real profile Loader, Registry HTTP, player API and JSONL turn/rewind recovery without a model key. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildCreation, canonicalizeCreation, HistoryMessageSchema, lateSlotKey, PRESET_REGIONS, resolveStoryPlayer } from '@char-pub/core'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, initProfile, loadProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import { z } from 'zod'
import { commandId } from '../../charpub-roleplay/src/index.ts'
import { replayInput } from '../../charpub-roleplay/tests/fixtures.ts'
import { requestMessages } from '../src/index.ts'
import type {} from './fixtures/provider.ts'

const rootURL = new URL('../../../../', import.meta.url)
const packageURL = new URL('../', import.meta.url)
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const Scene = z.object({
  id: z.string(), title: z.string(), description: z.string().optional(), time: z.string().optional(), where: z.string().optional(),
}).strict()
const Player = z.object({
  key: z.string(), cast_key: z.string().optional(), name: z.string(), present: z.boolean().nullable(), part: z.string().optional(),
}).strict()
const Snapshot = z.object({
  session: z.string(), record: z.string(), history: z.array(HistoryMessageSchema),
  participants: z.array(z.object({
    key: z.string(), name: z.string(), present: z.boolean(), role: z.string().optional(), portrait: z.string().optional(),
  }).strict()),
  scene: Scene.nullable(),
  experience: z.object({ revision: z.string(), player: Player,
    known: z.array(z.object({ id: z.string(), title: z.string(), text: z.string() }).strict()),
    choices: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
    milestones: z.array(z.object({ kind: z.enum(['beat', 'ending']), id: z.string(), title: z.string() }).strict()),
    pending_ending: z.object({ id: z.string(), title: z.string().optional(), description: z.string().optional(),
      triggering_input: z.string() }).strict().optional(),
    can_undo: z.boolean(),
  }).strict(),
  stopped: z.boolean(), interrupted: z.boolean(), can_continue: z.boolean(), limitations: z.array(z.string()),
}).loose()
const Result = z.object({ request_id: z.string(), status: z.enum(['success', 'cancelled', 'failed']), superseded: z.literal(true).optional(),
  story_progress_unavailable: z.literal(true).optional(), snapshot: Snapshot })
type PlayerSnapshot = z.infer<typeof Snapshot>

function visible(snapshot: PlayerSnapshot) {
  const { revision: _revision, ...experience } = snapshot.experience
  if (experience.pending_ending) experience.pending_ending = { ...experience.pending_ending, id: '<pending-ending>' }
  return { history: snapshot.history, participants: snapshot.participants, scene: snapshot.scene, experience,
    stopped: snapshot.stopped, interrupted: snapshot.interrupted, can_continue: snapshot.can_continue, limitations: snapshot.limitations }
}
function publicOnly(snapshot: PlayerSnapshot) {
  assert.ok(!('state' in snapshot), 'raw state must stay in the durable runtime')
  assert.ok(!('judgments' in snapshot), 'judge evidence must stay in the durable runtime')
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|BOB_PRIVATE_LEDGER|FUTURE_SCENE_CLUE/)
}
function fixture(options: { ending?: boolean } = {}) {
  const input = replayInput('narrator')
  const meta = { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' } as const
  const policy = canonicalizeCreation({
    id: 'cr_01j00000000000000000000011', ref: '@fixture/player-policy', type: 'preset', display_name: 'Player policy', meta,
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const release = 'rel_01j00000000000000000000011'
  const { artifact } = buildCreation({
    root: { release: 'rel_01j00000000000000000000010', visibility: 'public', creation: {
      id: 'cr_01j00000000000000000000010', ref: '@fixture/player-app', type: 'scenario', display_name: 'Player Inn', meta,
      cast: [
        { key: 'alice', who: { late: 'character' }, role: 'user', part: 'Guest' },
        { key: 'bob', who: { late: 'character' }, role: 'support', part: 'Innkeeper', goal: 'PRIVATE_BOB_GOAL' },
        { key: 'future', who: { late: 'character' }, role: 'support', part: 'PRIVATE_FUTURE_ROLE' },
      ],
      fragments: [
        { id: 'invitation', kind: 'knowledge', stable: true, description: 'Your invitation', content: { type: 'text', text: 'You were invited to the inn.' } },
        { id: 'garden-key', kind: 'knowledge', stable: true, description: 'The garden gate', content: { type: 'text', text: 'The garden gate opens with a brass token.' } },
        { id: 'ledger', kind: 'knowledge', stable: true, description: 'PRIVATE_LEDGER_TITLE', content: { type: 'text', text: 'BOB_PRIVATE_LEDGER' } },
        { id: 'future-clue', kind: 'knowledge', stable: true, description: 'PRIVATE_FUTURE_TITLE', content: { type: 'text', text: 'FUTURE_SCENE_CLUE' }, visibility: { scope: 'story-scene', scene: 'closed' } },
      ],
      story: {
        version: 1, player: 'alice',
        vars: { count: { type: 'int', min: 0, max: 3, init: 0, description: 'PRIVATE_REWARD_COUNTER' } },
        scenes: [
          { id: 'lobby', title: 'Lobby', cast: ['alice', 'bob'], choices: ['claim'], goals: { bob: 'PRIVATE_SCENE_GOAL' } },
          { id: 'garden', title: 'Garden', description: 'The garden is quiet.', cast: ['alice'], choices: ['wait'], when: { reached: 'beat/refusal' } },
          { id: 'closed', title: 'PRIVATE_FUTURE_SCENE', cast: ['future'] },
        ],
        choices: [{ id: 'claim', label: 'Claim a token', intent: 'I claim the token.' }, { id: 'wait', label: 'Wait in the garden', intent: 'I wait in the garden.' }],
        starts: [{ id: 'arrival', scene: 'lobby', greeting: 'Bob greets {{cast:alice}}.' }],
        beats: [
          { id: 'reward', title: 'Received a token', description: 'Gain one token', reveal: 'on-reach', effects: [{ add: ['var/count', 1] }] },
          { id: 'refusal', title: 'PRIVATE_HIDDEN_BEAT', description: 'The guest refuses the offer', when: { not: { judge: 'Did the guest accept the offer?' } }, effects: [{ add: ['var/count', 1] }, { learn: { who: 'alice', info: '#garden-key' } }] },
        ],
        ...(options.ending ? { endings: [{ id: 'private-stage', title: 'PRIVATE_ENDING_TITLE', description: 'PRIVATE_ENDING_DESCRIPTION',
          reveal: 'hidden' as const, when: { judge: 'PRIVATE_ENDING_EVIDENCE' },
          effects: [{ add: ['var/count', 1] as [string, number] }, { learn: { who: 'alice', info: '#garden-key' } }], after: 'stop' as const,
        }] } : {}),
        knowing: {
          '#invitation': { start: { knows: ['alice'] } }, '#garden-key': { start: { knows: ['bob'] } },
          '#ledger': { start: { knows: ['bob'] } }, '#future-clue': { start: { knows: ['alice'] } },
        },
      },
    } },
    dependencies: [{ release, visibility: 'public', creation: policy.creation, semantic_digest: policy.semantic_digest }],
    default_policy: { ref: policy.creation.ref, release, semantic_digest: policy.semantic_digest },
  })
  assert.equal(artifact.kind, 'content')
  assert.ok('release' in artifact.root)
  return { ...input, artifact, source_texts: {}, locale: 'en', profile: { ...input.profile, locale: 'en' },
    support: { supported: artifact.capabilities.map(capability => capability.id) },
    bindings: {
      user: { kind: 'persona' as const, display_name: 'Human' },
      [lateSlotKey('root', 'alice')]: { kind: 'character' as const, display_name: 'Alice', description: 'PRIVATE_ALICE_DESCRIPTION' },
      [lateSlotKey('root', 'bob')]: { kind: 'character' as const, display_name: 'Bob', description: 'PRIVATE_BOB_DESCRIPTION', outward_description: 'Bob wears a wool coat.' },
      [lateSlotKey('root', 'future')]: { kind: 'character' as const, display_name: 'PRIVATE_FUTURE_PERSON', description: 'PRIVATE_FUTURE_DESCRIPTION' },
    },
  }
}

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  return address.port
}
async function json(response: Response) {
  assert.equal(response.status, 200, await response.clone().text())
  const value: unknown = await response.json()
  return value
}
async function rejected(response: Response, code: string) {
  assert.equal(response.status, 400)
  assert.equal(z.object({ error: z.string() }).parse(await response.json()).error, code)
}

async function appFixture(t: TestContext, input = fixture()) {
  const artifact = input.artifact; const exactRoot = artifact.root
  assert.ok('release' in exactRoot)
  const bytes = JSON.stringify(artifact)
  const home = await mkdtemp(join(tmpdir(), 'charpub-app-play-'))
  const contexts: Context[] = []
  let registryOrigin = ''
  let registryReads = 0
  const registry = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const path = new URL(req.url ?? '/', registryOrigin).pathname
    let value: unknown
    if (path.startsWith('/.well-known/')) value = { issuer: registryOrigin, authorization_endpoint: `${registryOrigin}/authorize`, token_endpoint: `${registryOrigin}/token`, revocation_endpoint: `${registryOrigin}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }
    else if (path === `/v1/releases/${exactRoot.release}`) { registryReads++; value = { id: exactRoot.release, ref: exactRoot.ref, creation: 'cr_01j00000000000000000000010', label: '1.0.0', visibility: 'public', status: 'active', semantic_digest: exactRoot.semantic_digest, effective_rating: 'general', created_at: '2026-10-05T00:00:00Z', lock_digest: artifact.lock_digest, context_ir_digest: null, artifact_digest: sha(bytes), license_check: 'pass', availability: 'complete' } }
    else if (path === `/v1/releases/${exactRoot.release}/artifact`) { res.end(bytes); return }
    else { res.statusCode = 404; value = {} }
    res.end(JSON.stringify(value))
  })
  t.after(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    registry.closeAllConnections(); await new Promise<void>(resolve => registry.close(() => { resolve() }))
    await rm(home, { recursive: true, force: true })
  })
  registry.listen(0, '127.0.0.1'); await once(registry, 'listening')
  const address = registry.address(); assert.ok(address && typeof address !== 'string')
  registryOrigin = `http://127.0.0.1:${address.port}`
  const dir = resolveProfileDir('roleplay', home)
  initProfile(dir, ['@deepseek-ai/dsh-experimental-charpub-roleplay-runtime'])
  async function boot() {
    const port = await freePort(); const origin = `http://127.0.0.1:${port}`
    await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([
      { id: 'roleplay-storage', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'roleplay-runtime', config: { timeout_ms: 5000, max_event_bytes: 2_000_000, max_stream_bytes: 100_000 } },
      { insert: [
        { id: 'test-credentials', name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: home, watch: false } },
        { id: 'test-provider', name: new URL('tests/fixtures/provider.ts', packageURL).href },
        { id: 'roleplay-app', name: new URL('src/app.ts', packageURL).href, config: {
          host: '127.0.0.1', port, registry_origin: registryOrigin, issuer: registryOrigin, client_id: 'offline-player-client',
          timeout_ms: 5000, max_request_bytes: 100_000, max_response_bytes: 2_000_000, max_artifact_bytes: 2_000_000,
          profile: input.profile, model: { provider: 'roleplay-test', model: 'fixed', maxTokens: 512 },
          play: { decisions: { provider: 'roleplay-test', model: 'fixed', maxTokens: 512 }, limits: { min_confidence: 0.8, max_actions: 4, max_decision_calls: 1, max_decision_tokens: 8192 } },
          credential_ref: 'CHARPUB_APP_PLAY_TEST_KEY',
        } },
      ] },
    ]))
    const profile = loadProfile('test-dsh', 'roleplay', fileURLToPath(new URL('package.json', rootURL)), home)
    assert.deepEqual(profile.skippedBundles, [])
    const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]).map(entry => ({ ...entry, name: entry.name?.startsWith('@deepseek-ai/') ? import.meta.resolve(`${entry.name}/src/index.ts`) : entry.name }))
    const configuration = join(home, 'cordis.yml'); await writeFile(configuration, JSON.stringify(entries))
    const ctx = new Context(); contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(home).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configuration).href } }); await ctx.loader.await()
    const response = await fetch(origin); assert.equal(response.status, 200)
    const bootstrap = (await response.text()).match(/<script id="charpub-bootstrap" type="application\/json">([^<]*)<\/script>/)?.[1]
    assert.ok(bootstrap)
    const { nonce } = z.object({ nonce: z.string() }).parse(JSON.parse(bootstrap))
    const post = (path: string, value: unknown = {}) => fetch(`${origin}/api/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-roleplay-client': nonce }, body: JSON.stringify(value) })
    return { ctx, post, origin }
  }
  const launch = { format: 'char.pub/runtime-launch', version: 1, registry_origin: registryOrigin, source: exactRoot, lock_digest: artifact.lock_digest, locale: 'en', view: { mode: 'narrator' } }
  return { input, artifact, home, boot, launch, registryReads: () => registryReads }
}

void test('player HTTP turns commit visible progress once; rewind fences old handles and IDs across JSONL reopening', async (t) => {
  const { input, artifact, home, boot, launch, registryReads } = await appFixture(t)
  const { ctx, post, origin } = await boot()
  const review = z.object({ review: z.string() }).parse(await json(await post('review', launch)))
  const opening = Snapshot.parse(await json(await post('start', { review: review.review, bindings: input.bindings, restart: false })))
  publicOnly(opening)
  assert.equal(opening.experience.player.cast_key, 'alice')
  assert.deepEqual(opening.participants.map(person => person.name), ['Bob'])
  assert.equal(opening.participants[0]?.portrait, 'Bob wears a wool coat.')
  assert.deepEqual(opening.experience.known.map(clue => clue.text), ['You were invited to the inn.'])
  assert.deepEqual(opening.experience.choices.map(choice => choice.id), ['claim'])
  assert.equal(opening.experience.can_undo, false)
  const stored = await ctx.sessionPersistence.list(); assert.equal(stored.length, 1)
  const id = stored[0]?.header.id; assert.ok(id)
  const logs = (await readdir(join(home, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'))
  assert.equal(logs.length, 1); const file = join(home, 'sessions', logs[0] ?? '')
  const openedBytes = await readFile(file)
  const request = { session: opening.session, request_id: 'claim-and-enter', text: 'I take the token, refuse the offer, and enter the garden.', expected_revision: opening.experience.revision }
  const { expected_revision: _expected, ...missingRevision } = request
  await rejected(await post('turn', missingRevision), 'roleplay_app.revision_required')
  await rejected(await post('turn', { ...request, expected_revision: `sha256:${'0'.repeat(64)}` }), 'roleplay_runtime.stale_revision')
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
  assert.deepEqual(await readFile(file), openedBytes)
  ctx.roleplayTestProvider.replies = [{ text: JSON.stringify({
    actions: ['beat/reward', 'beat/refusal', 'scene/garden'].map(target => ({ target, confidence: 0.95 })),
    judgments: [{ target: 'beat/refusal', path: '/when/not', result: 'false', confidence: 0.95 }],
  }) }, { text: 'Bob hands over the brass token. The garden is quiet.' }]
  const [firstResponse, duplicateResponse] = await Promise.all([post('turn', request), post('turn', request)])
  const settled = Result.parse(await json(firstResponse))
  assert.deepEqual(Result.parse(await json(duplicateResponse)), settled)
  assert.equal(settled.status, 'success'); publicOnly(settled.snapshot)
  assert.equal(settled.story_progress_unavailable, undefined)
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
  assert.equal(settled.snapshot.scene?.id, 'garden')
  assert.deepEqual(settled.snapshot.participants, [])
  assert.deepEqual(settled.snapshot.experience.known.map(clue => clue.text), ['You were invited to the inn.', 'The garden gate opens with a brass token.'])
  assert.deepEqual(settled.snapshot.experience.choices.map(choice => choice.id), ['wait'])
  assert.deepEqual(settled.snapshot.experience.milestones, [{ kind: 'beat', id: 'reward', title: 'Received a token' }])
  assert.equal(settled.snapshot.experience.can_undo, true)
  assert.equal(settled.snapshot.history.at(-2)?.speaker, resolveStoryPlayer(artifact)?.participant)
  const committed = await ctx.roleplayRuntime.inspect(id)
  assert.equal(committed.current.state.scene, 'garden'); assert.equal(committed.current.state.vars.count, 2)
  assert.deepEqual(committed.current.state.knowing['#garden-key'], ['bob', 'alice'])
  const planned = committed.turns.get(commandId('app-input:claim-and-enter'))?.decisions.get(0)?.requested
  const narration = [...committed.requests.values()][0]
  assert.ok(planned && narration)
  assert.deepEqual(ctx.roleplayTestProvider.calls[0]?.messages, requestMessages({ ...planned, id: planned.request_digest }))
  assert.deepEqual(ctx.roleplayTestProvider.calls[1]?.messages, requestMessages(narration))
  assert.match(planned.messages.at(-1)?.content ?? '', /I take the token, refuse the offer, and enter the garden/)
  const committedBytes = await readFile(file)
  assert.deepEqual(Result.parse(await json(await post('turn', request))), settled)
  await rejected(await post('turn', { ...request, text: 'I accept the offer instead.' }), 'roleplay_runtime.command_conflict')
  await rejected(await post('turn', { ...request, request_id: 'stale-tab' }), 'roleplay_runtime.stale_revision')
  assert.deepEqual(Result.parse(await json(await post('turn-status', { session: opening.session, request_id: request.request_id }))), settled)
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
  assert.deepEqual(await readFile(file), committedBytes)
  await rejected(await post('rewind', { session: opening.session, request_id: 'stale-rewind', expected_revision: opening.experience.revision }), 'roleplay_runtime.stale_revision')
  const rewind = { session: opening.session, request_id: 'undo-one', expected_revision: settled.snapshot.experience.revision }
  const restored = Snapshot.parse(await json(await post('rewind', rewind)))
  publicOnly(restored)
  assert.notEqual(restored.session, opening.session); assert.equal(restored.record, opening.record)
  assert.notEqual(restored.experience.revision, opening.experience.revision)
  assert.deepEqual(visible(restored), visible(opening))
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
  const rewoundBytes = await readFile(file)
  assert.ok(rewoundBytes.subarray(0, committedBytes.length).equals(committedBytes), 'rewind appends history instead of rewriting it')
  for (const endpoint of ['session', 'turn-status', 'turn', 'rewind'])
    await rejected(await post(endpoint, endpoint === 'session' ? { session: opening.session } : endpoint === 'turn-status' ? { session: opening.session, request_id: request.request_id } : endpoint === 'turn' ? request : rewind), 'roleplay_app.stale_session')
  const superseded = Result.parse(await json(await post('turn', { ...request, session: restored.session })))
  assert.equal(superseded.superseded, true)
  assert.deepEqual(superseded.snapshot, restored)
  assert.equal(Result.parse(await json(await post('turn-status', { session: restored.session, request_id: request.request_id }))).superseded, true)
  assert.deepEqual(await readFile(file), rewoundBytes)
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
  await ctx.fiber.dispose(); await assert.rejects(fetch(origin))
  const reopened = await boot()
  await rejected(await reopened.post('session', { session: restored.session }), 'roleplay_app.session_required')
  const listed = z.object({ items: z.array(z.object({ record: z.string(), state: z.string() })) }).parse(await json(await reopened.post('sessions')))
  assert.deepEqual(listed.items, [{ record: opening.record, state: 'ready' }])
  const reads = registryReads()
  const resumed = Snapshot.parse(await json(await reopened.post('resume', { record: opening.record, restart: false })))
  assert.ok(registryReads() > reads, 'resume verifies the exact Registry source again')
  assert.notEqual(resumed.session, restored.session); assert.equal(resumed.record, opening.record)
  assert.equal(resumed.experience.revision, restored.experience.revision)
  assert.deepEqual(visible(resumed), visible(restored)); publicOnly(resumed)
  assert.equal(reopened.ctx.roleplayTestProvider.calls.length, 0)
  assert.equal(Result.parse(await json(await reopened.post('turn', { ...request, session: resumed.session }))).superseded, true)
  assert.deepEqual(await readFile(file), rewoundBytes)
  const recovered = await reopened.ctx.roleplayRuntime.inspect(id)
  assert.equal(recovered.current.state.vars.count, 0)
  assert.deepEqual(recovered.current.state.knowing['#garden-key'], ['bob'])
  assert.equal(reopened.ctx.roleplayTestProvider.calls.length, 0)
  t.assert.snapshot({ opening: visible(opening), director: planned.messages, narration: narration.messages,
    settled: visible(settled.snapshot), rewound: visible(restored), resumed: visible(resumed) })

  reopened.ctx.roleplayTestProvider.replies = [
    { text: '{"actions":[{"target":"PRIVATE_DIRECTOR_TARGET","confidence":' },
    { text: 'Bob watches as you reach towards the token.' },
  ]
  const unavailableRequest = { session: resumed.session, request_id: 'director-unavailable',
    text: 'I reach for the brass token.', expected_revision: resumed.experience.revision }
  const unavailable = Result.parse(await json(await reopened.post('turn', unavailableRequest)))
  assert.equal(unavailable.status, 'success')
  assert.equal(unavailable.story_progress_unavailable, true)
  publicOnly(unavailable.snapshot)
  assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE_DIRECTOR_TARGET|invalid_decision_response/)
  assert.equal(unavailable.snapshot.history.at(-1)?.text, 'Bob watches as you reach towards the token.')
  assert.equal(unavailable.snapshot.history.at(-2)?.text, unavailableRequest.text)
  assert.equal(unavailable.snapshot.experience.can_undo, true)
  assert.deepEqual(unavailable.snapshot.scene, resumed.scene)
  assert.deepEqual(unavailable.snapshot.experience.known, resumed.experience.known)
  assert.deepEqual(unavailable.snapshot.experience.choices, resumed.experience.choices)
  assert.deepEqual(unavailable.snapshot.experience.milestones, resumed.experience.milestones)
  const withReply = await reopened.ctx.roleplayRuntime.inspect(id)
  assert.deepEqual(withReply.current.state, recovered.current.state)
  const unavailableTurn = withReply.turns.get(commandId('app-input:director-unavailable'))
  const unavailablePlan = unavailableTurn?.decisions.get(0)?.requested
  const unavailableNarration = [...withReply.requests.values()].at(-1)
  assert.ok(unavailableTurn?.resolution && unavailablePlan && unavailableNarration)
  assert.deepEqual(unavailableTurn.resolution.actions, [{ target: 'turn', status: 'skipped', reason: 'invalid_decision_response' }])
  assert.equal(reopened.ctx.roleplayTestProvider.calls.length, 2)
  assert.deepEqual(reopened.ctx.roleplayTestProvider.calls[0]?.messages,
    requestMessages({ ...unavailablePlan, id: unavailablePlan.request_digest }))
  assert.deepEqual(reopened.ctx.roleplayTestProvider.calls[1]?.messages, requestMessages(unavailableNarration))
  assert.deepEqual(Result.parse(await json(await reopened.post('turn-status', { session: resumed.session, request_id: unavailableRequest.request_id }))), unavailable)
  assert.deepEqual(Result.parse(await json(await reopened.post('turn', unavailableRequest))), unavailable)
  assert.equal(reopened.ctx.roleplayTestProvider.calls.length, 2)
  const unavailableBytes = await readFile(file)
  await reopened.ctx.fiber.dispose(); await assert.rejects(fetch(reopened.origin))
  const finalBoot = await boot()
  await json(await finalBoot.post('sessions'))
  const finalResume = Snapshot.parse(await json(await finalBoot.post('resume', { record: resumed.record, restart: false })))
  assert.notEqual(finalResume.session, resumed.session)
  assert.equal(finalResume.experience.revision, unavailable.snapshot.experience.revision)
  assert.deepEqual(visible(finalResume), visible(unavailable.snapshot))
  const finalResult = Result.parse(await json(await finalBoot.post('turn-status', { session: finalResume.session, request_id: unavailableRequest.request_id })))
  assert.deepEqual(finalResult, { ...unavailable, snapshot: { ...unavailable.snapshot, session: finalResume.session } })
  assert.deepEqual(Result.parse(await json(await finalBoot.post('turn', { ...unavailableRequest, session: finalResume.session }))), finalResult)
  assert.equal(finalBoot.ctx.roleplayTestProvider.calls.length, 0)
  assert.deepEqual(await readFile(file), unavailableBytes)
  assert.deepEqual((await finalBoot.ctx.roleplayRuntime.inspect(id)).current.state, recovered.current.state)
  t.assert.snapshot({ status: finalResult.status, story_progress_unavailable: finalResult.story_progress_unavailable,
    director: unavailablePlan.messages, narration: unavailableNarration.messages,
    saved: visible(unavailable.snapshot), restored: visible(finalResume) })
})

void test('a private ending survives restart as a proposal and commits only one explicit successful confirmation', async (t) => {
  const { input, home, boot, launch } = await appFixture(t, fixture({ ending: true }))
  const first = await boot()
  const review = z.object({ review: z.string() }).parse(await json(await first.post('review', launch)))
  const opening = Snapshot.parse(await json(await first.post('start', { review: review.review, bindings: input.bindings, restart: false })))
  const id = (await first.ctx.sessionPersistence.list())[0]?.header.id; assert.ok(id)
  const initial = await first.ctx.roleplayRuntime.inspect(id)
  const logs = (await readdir(join(home, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'))
  assert.equal(logs.length, 1); const file = join(home, 'sessions', logs[0] ?? '')
  const text = 'I want to stay tonight. Let me review that arrangement before it is recorded.'
  first.ctx.roleplayTestProvider.replies = [{ text: JSON.stringify({
    actions: [{ target: 'ending/private-stage', confidence: 0.95 }],
    judgments: [{ target: 'ending/private-stage', path: '/when', result: 'true', confidence: 0.95 }],
  }) }, { text: 'The arrangement is ready for you to review. Nothing has been agreed yet.' }]
  const offered = Result.parse(await json(await first.post('turn', { session: opening.session, request_id: 'propose-stage', text,
    expected_revision: opening.experience.revision })))
  assert.equal(offered.status, 'success'); publicOnly(offered.snapshot)
  assert.equal(first.ctx.roleplayTestProvider.calls.length, 2)
  const proposal = offered.snapshot.experience.pending_ending
  assert.ok(proposal)
  assert.deepEqual(proposal, { id: proposal.id, triggering_input: text })
  assert.doesNotMatch(JSON.stringify(offered.snapshot), /private-stage|judgments|parent_revision|state_digest|source_turn_id/)
  assert.equal(offered.snapshot.stopped, false); assert.equal(offered.snapshot.can_continue, true)
  assert.deepEqual(offered.snapshot.experience.milestones, [])
  assert.deepEqual(offered.snapshot.experience.known, opening.experience.known)
  const pending = await first.ctx.roleplayRuntime.inspect(id)
  assert.deepEqual(pending.current.state, initial.current.state)
  assert.equal(pending.pending_ending?.id, proposal.id)
  assert.equal(pending.pending_ending?.target, 'ending/private-stage')
  assert.ok(pending.pending_ending?.judgments.length)
  const proposedNarration = [...pending.requests.values()].at(-1); assert.ok(proposedNarration)
  assert.deepEqual(first.ctx.roleplayTestProvider.calls[1]?.messages, requestMessages(proposedNarration))
  const pendingBytes = await readFile(file)
  await first.ctx.fiber.dispose(); await assert.rejects(fetch(first.origin))
  const second = await boot()
  await json(await second.post('sessions'))
  const resumed = Snapshot.parse(await json(await second.post('resume', { record: offered.snapshot.record, restart: false })))
  assert.notEqual(resumed.session, offered.snapshot.session)
  assert.equal(resumed.experience.revision, offered.snapshot.experience.revision)
  assert.deepEqual(visible(resumed), visible(offered.snapshot))
  assert.deepEqual(resumed.experience.pending_ending, proposal)
  assert.deepEqual((await second.ctx.roleplayRuntime.inspect(id)).pending_ending, pending.pending_ending)
  assert.deepEqual(await readFile(file), pendingBytes)
  assert.equal(second.ctx.roleplayTestProvider.calls.length, 0)
  const confirmation = { session: resumed.session, request_id: 'confirm-stage', text: 'I confirm the proposed stage result.',
    expected_revision: resumed.experience.revision, confirm_ending: { proposal_id: proposal.id } }
  await rejected(await second.post('turn', { ...confirmation, confirm_ending: { proposal_id: `sha256:${'0'.repeat(64)}` } }), 'roleplay_runtime.ending_proposal_mismatch')
  await rejected(await second.post('turn', { ...confirmation, expected_revision: opening.experience.revision }), 'roleplay_runtime.stale_revision')
  await rejected(await second.post('turn', { ...confirmation, choice_id: 'claim' }), 'roleplay_app.invalid_input')
  assert.equal(second.ctx.roleplayTestProvider.calls.length, 0)
  assert.deepEqual(await readFile(file), pendingBytes)

  second.ctx.roleplayTestProvider.replies = [{ mode: 'failure' }]
  const failedRequest = { ...confirmation, request_id: 'failed-confirmation' }
  const failed = Result.parse(await json(await second.post('turn', failedRequest)))
  assert.equal(failed.status, 'failed')
  assert.equal(second.ctx.roleplayTestProvider.calls.length, 1)
  assert.deepEqual(failed.snapshot.experience.pending_ending, proposal)
  assert.deepEqual(failed.snapshot.history, resumed.history)
  assert.deepEqual((await second.ctx.roleplayRuntime.inspect(id)).current.state, initial.current.state)
  assert.deepEqual(Result.parse(await json(await second.post('turn', failedRequest))), failed)
  assert.equal(second.ctx.roleplayTestProvider.calls.length, 1)
  const acceptedRequest = { ...confirmation, expected_revision: failed.snapshot.experience.revision }
  second.ctx.roleplayTestProvider.replies = [{ text: 'The arrangement is now confirmed. Bob gives you the garden token.' }]
  const accepted = Result.parse(await json(await second.post('turn', acceptedRequest)))
  assert.equal(accepted.status, 'success'); publicOnly(accepted.snapshot)
  assert.equal(accepted.snapshot.stopped, true); assert.equal(accepted.snapshot.can_continue, false)
  assert.equal(accepted.snapshot.experience.pending_ending, undefined)
  assert.equal(second.ctx.roleplayTestProvider.calls.length, 2, 'each confirmation invokes narration once and no director or selector')
  const committed = await second.ctx.roleplayRuntime.inspect(id)
  assert.equal(committed.pending_ending, null)
  assert.equal(committed.current.state.vars.count, 1)
  assert.deepEqual(committed.current.state.ended, ['private-stage'])
  assert.deepEqual(committed.current.state.knowing['#garden-key'], ['bob', 'alice'])
  const confirmedTurn = committed.turns.get(commandId('app-input:confirm-stage')); assert.ok(confirmedTurn)
  assert.equal(confirmedTurn.decisions.size, 0)
  const confirmedNarration = [...committed.requests.values()].at(-1); assert.ok(confirmedNarration)
  assert.deepEqual(second.ctx.roleplayTestProvider.calls[1]?.messages, requestMessages(confirmedNarration))
  assert.deepEqual(Result.parse(await json(await second.post('turn', acceptedRequest))), accepted)
  assert.deepEqual(Result.parse(await json(await second.post('turn-status', { session: resumed.session, request_id: acceptedRequest.request_id }))), accepted)
  const committedBytes = await readFile(file)
  await rejected(await second.post('turn', { ...acceptedRequest, text: 'Different confirmation text' }), 'roleplay_runtime.command_conflict')
  assert.deepEqual(await readFile(file), committedBytes)
  assert.equal(second.ctx.roleplayTestProvider.calls.length, 2)

  const undone = Snapshot.parse(await json(await second.post('rewind', { session: resumed.session, request_id: 'undo-confirmation',
    expected_revision: accepted.snapshot.experience.revision })))
  assert.notEqual(undone.session, resumed.session)
  assert.deepEqual(undone.experience.pending_ending, proposal)
  assert.deepEqual(undone.history, offered.snapshot.history)
  assert.equal(undone.stopped, false)
  const rewound = await second.ctx.roleplayRuntime.inspect(id)
  assert.deepEqual(rewound.current.state, initial.current.state)
  assert.deepEqual(rewound.pending_ending, pending.pending_ending)
  const superseded = Result.parse(await json(await second.post('turn', { ...acceptedRequest, session: undone.session })))
  assert.equal(superseded.superseded, true)
  assert.deepEqual(superseded.snapshot, undone)
  assert.equal(second.ctx.roleplayTestProvider.calls.length, 2)
  const rewoundBytes = await readFile(file)
  assert.ok(rewoundBytes.subarray(0, committedBytes.length).equals(committedBytes))
  await second.ctx.fiber.dispose(); await assert.rejects(fetch(second.origin))
  const third = await boot()
  await json(await third.post('sessions'))
  const restored = Snapshot.parse(await json(await third.post('resume', { record: undone.record, restart: false })))
  assert.deepEqual(restored.experience.pending_ending, proposal)
  assert.deepEqual(visible(restored), visible(undone))
  assert.equal(restored.experience.revision, undone.experience.revision)
  assert.deepEqual(await readFile(file), rewoundBytes)
  assert.equal(third.ctx.roleplayTestProvider.calls.length, 0)
  third.ctx.roleplayTestProvider.replies = [{ text: JSON.stringify({ actions: [], judgments: [] }) }, { text: 'We can keep discussing it.' }]
  const discussed = Result.parse(await json(await third.post('turn', { session: restored.session, request_id: 'keep-discussing',
    text: 'I would like to reconsider the arrangement.', expected_revision: restored.experience.revision })))
  assert.equal(discussed.status, 'success')
  assert.equal(discussed.snapshot.experience.pending_ending, undefined)
  assert.deepEqual((await third.ctx.roleplayRuntime.inspect(id)).current.state, initial.current.state)
  assert.equal(third.ctx.roleplayTestProvider.calls.length, 2)
  t.assert.snapshot({ proposed: visible(offered.snapshot), proposalNarration: proposedNarration.messages,
    confirmed: visible(accepted.snapshot), confirmationNarration: confirmedNarration.messages, undone: visible(undone),
    restored: visible(restored), discussing: visible(discussed.snapshot) })
})
