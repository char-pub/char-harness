/** Named profile + real loopback app + JSONL + offline model. Registry HTTP is an explicit protocol fixture. */
import assert from 'node:assert/strict'
import { z } from 'zod'
import { RuntimePreviewInputSchema, HistoryMessageSchema, buildCreation, canonicalizeCreation, PRESET_REGIONS } from '@char-pub/core'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { initProfile, loadProfile, composeEntries, resolveProfileDir } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import { replayInput, SOURCE } from '../../charpub-roleplay/tests/fixtures.ts'
import type {} from './fixtures/provider.ts'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { commandId } from '../../charpub-roleplay/src/index.ts'
import { makeRequested, makeOpened, projectRoleplay } from '../src/projection.ts'
const rootURL = new URL('../../../../', import.meta.url)
const packageURL = new URL('../', import.meta.url)
const sha = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port; await new Promise<void>(resolve => server.close(() =>{  resolve() })); return port }

void test('named roleplay app reviews exact work, starts and generates once, exports explicit synthetic input, and never overwrites old sessions', async (context) => {
  const input = replayInput('narrator')
  assert.equal(input.artifact.kind, 'content')
  const artifact = input.artifact
  assert.ok('release' in artifact.root)
  const exactRoot = artifact.root
  const bytes = JSON.stringify(artifact)
  const home = await mkdtemp(join(tmpdir(), 'charpub-app-'))
  const port = await freePort()
  const appOrigin = `http://127.0.0.1:${port}`
  let registryOrigin = ''
  let sourceReads = 0
  let registryDenied = false
  let discoveryAvailable = false
  const registry = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const path = new URL(req.url ?? '/', registryOrigin).pathname
    if (!discoveryAvailable && path.startsWith('/.well-known/')) { res.statusCode = 503; res.end('{}'); return }
    if (registryDenied && path.startsWith('/v1/releases/')) { res.statusCode = 403; res.end('{}'); return }
    let value: unknown
    if (path.startsWith('/.well-known/')) value = { issuer: registryOrigin, authorization_endpoint: `${registryOrigin}/authorize`, token_endpoint: `${registryOrigin}/token`, revocation_endpoint: `${registryOrigin}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }
    else if (path === `/v1/releases/${exactRoot.release}`) value = { id: exactRoot.release, ref: artifact.root.ref, creation: 'cr_01j00000000000000000000000', label: '1.0.0', visibility: 'public', status: 'active', semantic_digest: artifact.root.semantic_digest, effective_rating: 'general', created_at: new Date().toISOString(), lock_digest: artifact.lock_digest, context_ir_digest: null, artifact_digest: sha(bytes), license_check: 'pass', availability: 'complete' }
    else if (path.endsWith('/artifact')) { res.end(bytes); return }
    else if (path.endsWith('/source-text') && artifact.kind === 'content') { sourceReads++; const source = artifact.catalog_index.sources[0]; assert.ok(source); value = { source: source.id, asset: source.asset, digest: sha(SOURCE), text: SOURCE } }
    else { res.statusCode = 404; value = {} }
    res.end(JSON.stringify(value))
  })
  registry.listen(0, '127.0.0.1'); await once(registry, 'listening')
  const address = registry.address(); assert.ok(address && typeof address !== 'string'); registryOrigin = `http://127.0.0.1:${address.port}`
  const ctx = new Context()
  context.after(async () => {
    await ctx.fiber.dispose(); registry.closeAllConnections()
    await new Promise<void>(resolve => registry.close(() => { resolve() }))
    await rm(home, { recursive: true, force: true })
  })
  const dir = resolveProfileDir('roleplay', home)
  initProfile(dir, ['@deepseek-ai/dsh-experimental-charpub-roleplay-runtime'])
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([
    { id: 'roleplay-storage', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'roleplay-runtime', config: { timeout_ms: 3000, max_event_bytes: 2_000_000, max_stream_bytes: 100_000 } },
    { insert: [
      { id: 'test-credentials', name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: home, watch: false } },
      { id: 'test-provider', name: new URL('tests/fixtures/provider.ts', packageURL).href },
      { id: 'roleplay-app', name: new URL('src/app.ts', packageURL).href, config: { host: '127.0.0.1', port, registry_origin: registryOrigin, issuer: registryOrigin, client_id: 'offline-protocol-client', timeout_ms: 3000, max_request_bytes: 100_000, max_response_bytes: 2_000_000, max_artifact_bytes: 2_000_000, profile: input.profile, model: { provider: 'roleplay-test', model: 'fixed', maxTokens: 256 }, credential_ref: 'CHARPUB_APP_TEST_API_KEY' } },
    ] },
  ]))
  const profile = loadProfile('test-dsh', 'roleplay', fileURLToPath(new URL('package.json', rootURL)), home)
  assert.deepEqual(profile.skippedBundles, [])
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]).map(entry => ({ ...entry, name: entry.name?.startsWith('@deepseek-ai/') ? import.meta.resolve(`${entry.name}/src/index.ts`) : entry.name }))
  const configuration = join(home, 'cordis.yml'); await writeFile(configuration, JSON.stringify(entries))
  ctx.baseUrl = pathToFileURL(home).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configuration).href } }); await ctx.loader.await()
  const page = await fetch(appOrigin); assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'private, no-store')
  const html = await page.text()
  const bootstrap = html.match(/<script id="charpub-bootstrap" type="application\/json">([^<]*)<\/script>/)?.[1]
  assert.ok(bootstrap)
  const { nonce } = z.object({ nonce: z.string() }).parse(JSON.parse(bootstrap))
  const post = async (path: string, value: unknown = {}, origin = appOrigin) => fetch(`${appOrigin}/api/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-roleplay-client': nonce }, body: JSON.stringify(value) })
  assert.equal((await post('status')).status, 400)
  const Credential = z.strictObject({ configured: z.boolean(), source: z.string().optional(), writable: z.boolean() })
  // Settings stay readable while Registry discovery fails; this profile mounts no settings service or configurable provider.
  const settingsWithoutRegistry = await post('settings/models'); assert.equal(settingsWithoutRegistry.status, 200, await settingsWithoutRegistry.clone().text())
  assert.deepEqual(await settingsWithoutRegistry.json(), { providers: [] })
  assert.equal((await post('settings/models/save', { ns: 'roleplay-model', ops: [] })).status, 400)
  // A provider outside the configurable directory reports the app's own credential_ref.
  const testKey = credentialRef('CHARPUB_APP_TEST_API_KEY')
  await ctx.credentials.set(testKey, 'sk-local-test')
  discoveryAvailable = true
  assert.deepEqual(z.object({ model: z.object({ credential: Credential }) }).parse(await (await post('status')).json()).model.credential, { configured: true, source: 'file', writable: true })
  await ctx.credentials.unset(testKey)
  assert.equal((await post('status')).status, 200)
  const launch = { format: 'char.pub/runtime-launch', version: 1, registry_origin: registryOrigin, source: artifact.root, lock_digest: artifact.lock_digest, locale: 'ja', view: { mode: 'narrator' } }
  assert.equal((await post('review', launch, 'https://untrusted.example')).status, 403)
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => { const req = request(appOrigin, { headers: { host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode) }); req.on('error', reject); req.end() })
  assert.equal(wrongHost, 403)
  assert.equal((await post('review', { ...launch, token: 'forbidden' })).status, 400)
  assert.equal((await post('review', { ...launch, lock_digest: `sha256:${'0'.repeat(64)}` })).status, 400)
  const response = await post('review', launch); assert.equal(response.status, 200, await response.clone().text()); const review = z.object({ review: z.string() }).parse(await response.json())
  assert.equal(ctx.roleplayTestProvider.calls.length, 0); assert.equal(sourceReads, 0)
  const playBindings = structuredClone(input.bindings)
  for (const binding of Object.values(playBindings)) binding.description = 'PRIVATE_BINDING_MUST_NOT_EXPORT'
  const syntheticBindings = structuredClone(input.bindings)
  for (const binding of Object.values(syntheticBindings)) { binding.display_name = 'Synthetic person'; delete binding.description; delete binding.outward_description }
  const started = await post('start', { review: review.review, bindings: playBindings, restart: false }); assert.equal(started.status, 200, await started.clone().text())
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
  const session = z.object({ session: z.string() }).parse(await started.json()).session
  const generated = await post('turn', { session, request_id: 'reply-1', text: 'PRIVATE_CHAT' }); assert.equal(generated.status, 200, await generated.clone().text())
  const result = z.object({ status: z.string(), snapshot: z.object({ session: z.string(), record: z.string(), history: z.array(HistoryMessageSchema) }) }).parse(await generated.json()); assert.equal(result.status, 'success'); assert.equal(result.snapshot.history.at(-1)?.text, 'The innkeeper nods.'); assert.equal(ctx.roleplayTestProvider.calls.length, 1)
  const replayed = await post('turn', { session, request_id: 'reply-1', text: 'PRIVATE_CHAT' }); assert.equal(replayed.status, 200)
  assert.equal(ctx.roleplayTestProvider.calls.length, 1)
  const conflict = await post('turn', { session, request_id: 'reply-1', text: 'different input' }); assert.equal(conflict.status, 400); assert.match(await conflict.text(), /command_conflict/)
  const recovered = await post('turn-status', { session, request_id: 'reply-1' }); assert.equal(recovered.status, 200)
  assert.equal(z.object({ status: z.string() }).parse(await recovered.json()).status, 'success')
  const absent = await post('turn-status', { session, request_id: 'not-dispatched' }); assert.equal(z.object({ status: z.string() }).parse(await absent.json()).status, 'not_found')
  const appStatus = await (await post('status')).json(); assert.deepEqual(z.object({ model: z.object({ credential: Credential, online_verified: z.boolean() }), current_session: z.string() }).parse(appStatus), { model: { credential: { configured: false, writable: true }, online_verified: false }, current_session: session })
  const fresh = await (await post('session', { session })).json(); assert.equal(z.object({ record: z.string() }).parse(fresh).record, result.snapshot.record)
  assert.ok(!('state' in (fresh as object)), 'player snapshot must not expose raw knowing/variables')
  const listed = z.object({ items: z.array(z.object({ record: z.string() })) }).parse(await (await post('sessions', { limit: 1 })).json()); assert.equal(listed.items.length, 1); assert.equal(listed.items[0]?.record, result.snapshot.record)
  const reviewExport = await post('prepare-export', { session, history: [{ role: 'user', text: 'A synthetic public summary' }], bindings: syntheticBindings }); assert.equal(reviewExport.status, 200, await reviewExport.clone().text()); const reviewed = z.object({ digest: z.string(), payload: RuntimePreviewInputSchema }).parse(await reviewExport.json())
  assert.ok(JSON.stringify(ctx.roleplayTestProvider.calls[0]?.messages).includes('PRIVATE_BINDING_MUST_NOT_EXPORT'))
  assert.ok(!JSON.stringify(reviewed).includes('PRIVATE_CHAT'))
  assert.ok(!JSON.stringify(reviewed).includes('PRIVATE_BINDING_MUST_NOT_EXPORT'))
  const exported = await post('export', { session, digest: reviewed.digest }); assert.equal(exported.status, 200); assert.equal(z.object({ payload: RuntimePreviewInputSchema }).parse(await exported.json()).payload.turn.history[0]?.text, 'A synthetic public summary')
  const files = await readdir(join(home, 'sessions'), { recursive: true }); const logs = files.filter(file => file.endsWith('.jsonl')); assert.equal(logs.length, 1)
  const oldBytes = await readFile(join(home, 'sessions', logs[0] ?? ''))
  const resumedSame = await post('resume', { record: result.snapshot.record, restart: false }); assert.equal(resumedSame.status, 200); assert.equal(z.object({ session: z.string() }).parse(await resumedSame.json()).session, session)
  assert.deepEqual(await readFile(join(home, 'sessions', logs[0] ?? '')), oldBytes)
  const newer = z.object({ review: z.string(), restart_required: z.boolean() }).parse(await (await post('review', launch)).json()); assert.equal(newer.restart_required, true)
  assert.equal((await post('start', { review: newer.review, bindings: input.bindings, restart: false })).status, 400)
  const second = await post('start', { review: newer.review, bindings: input.bindings, restart: true })
  assert.equal(second.status, 200)
  const secondSession = z.object({ session: z.string() }).parse(await second.json()).session
  assert.notEqual(secondSession, session)
  for (const [path, body] of [
    ['turn', { session, request_id: 'old-tab', text: 'OLD_TAB_MUST_NOT_COMMIT' }],
    ['prepare-export', { session, history: [], bindings: {} }],
    ['export', { session, digest: reviewed.digest }],
    ['cancel', { session }],
  ] as const) {
    const denied = await post(path, body)
    assert.equal(denied.status, 400)
    assert.match(await denied.text(), /stale_session/)
  }
  assert.deepEqual(await readFile(join(home, 'sessions', logs[0] ?? '')), oldBytes)
  ctx.roleplayTestProvider.mode = 'cancel'; const pending = post('turn', { session: secondSession, request_id: 'cancel-1', text: 'cancel this generation' })
  await new Promise<void>((resolve) => { ctx.roleplayTestProvider.onRequest = resolve })
  assert.equal(z.object({ status: z.string() }).parse(await (await post('turn-status', { session: secondSession, request_id: 'cancel-1' })).json()).status, 'sending')
  assert.equal((await post('cancel', { session: secondSession, request_id: 'stale-cancel' })).status, 400)
  assert.equal((await post('cancel', { session: secondSession, request_id: 'cancel-1' })).status, 200); assert.equal(z.object({ status: z.string() }).parse(await (await pending).json()).status, 'cancelled')
  assert.equal((await post('resume', { record: result.snapshot.record, restart: false })).status, 400)
  const resumed = await post('resume', { record: result.snapshot.record, restart: true }); assert.equal(resumed.status, 200)
  const restored = z.object({ session: z.string(), record: z.string(), history: z.array(HistoryMessageSchema) }).parse(await resumed.json())
  assert.equal(restored.record, result.snapshot.record)
  assert.deepEqual(restored.history, result.snapshot.history)
  assert.notEqual(restored.session, secondSession); assert.deepEqual(await readFile(join(home, 'sessions', logs[0] ?? '')), oldBytes)
  const firstPage = z.object({ items: z.array(z.object({ record: z.string() })), next_cursor: z.string() }).parse(await (await post('sessions', { limit: 1 })).json()); assert.equal(firstPage.items.length, 1)
  const secondPage = z.object({ items: z.array(z.object({ record: z.string() })) }).parse(await (await post('sessions', { limit: 1, cursor: firstPage.next_cursor })).json()); assert.equal(secondPage.items.length, 1); assert.notEqual(firstPage.items[0]?.record, secondPage.items[0]?.record)
  const pendingID = SessionId('pending-player-resume')
  const initialPending = await ctx.roleplayRuntime.create(pendingID, input)
  const intent = { id: commandId('app-input:interrupted-1'), operation: { kind: 'input' as const, text: 'not dispatched' } }
  const requested = makeRequested(initialPending, 'pending-request', intent, { provider: 'roleplay-test', model: 'fixed', maxTokens: 256 })
  const write = await ctx.sessionPersistence.open(pendingID, 'write')
  await write.append([{ seq: SessionSeq(1), time: Date.now(), type: 'roleplay/requested', data: requested }]); await write.flush(); await write.close()
  const beforePending = await ctx.roleplayRuntime.inspect(pendingID)
  const pendingFiles = await readdir(join(home, 'sessions'), { recursive: true }); const pendingPath = pendingFiles.find(file => file.includes('pending-player-resume') && file.endsWith('.jsonl')); assert.ok(pendingPath)
  const pendingBytes = await readFile(join(home, 'sessions', pendingPath))
  const pendingList = z.object({ items: z.array(z.object({ record: z.string(), state: z.string() })) }).parse(await (await post('sessions')).json())
  const interrupted = pendingList.items.find(item => item.state === 'interrupted'); assert.ok(interrupted)
  const callsBefore = ctx.roleplayTestProvider.calls.length
  const pendingResume = await post('resume', { record: interrupted.record, restart: true }); assert.equal(pendingResume.status, 200)
  const blocked = z.object({ session: z.string(), interrupted: z.boolean(), can_continue: z.boolean() }).parse(await pendingResume.json())
  assert.equal(blocked.interrupted, true)
  assert.equal(blocked.can_continue, false)
  assert.equal((await post('turn', { session: blocked.session, request_id: 'new-after-crash', text: 'must not resend' })).status, 400)
  assert.equal(ctx.roleplayTestProvider.calls.length, callsBefore)
  assert.equal((await ctx.roleplayRuntime.inspect(pendingID)).head, beforePending.head)
  assert.deepEqual(await readFile(join(home, 'sessions', pendingPath)), pendingBytes)
  assert.equal((await post('turn', { session: blocked.session, request_id: 'interrupted-1', text: 'not dispatched', recover_interrupted: true })).status, 400)
  ctx.roleplayTestProvider.mode = 'success'
  const continued = await post('turn', { session: blocked.session, request_id: 'confirmed-recovery', text: 'Continue with this new input.', recover_interrupted: true }); assert.equal(continued.status, 200, await continued.clone().text())
  assert.equal(z.object({ status: z.string() }).parse(await continued.json()).status, 'success')
  assert.equal(ctx.roleplayTestProvider.calls.length, callsBefore + 1)
  const reconciled = await ctx.roleplayRuntime.inspect(pendingID); assert.equal(reconciled.pending, null)
  assert.equal([...reconciled.settlements.values()].filter(settled => settled.status === 'failed' && settled.reason === 'interrupted').length, 1)
  const oldRetry = await post('turn', { session: blocked.session, request_id: 'interrupted-1', text: 'not dispatched' }); assert.equal(oldRetry.status, 200); assert.equal(z.object({ status: z.string() }).parse(await oldRetry.json()).status, 'failed')
  assert.equal(ctx.roleplayTestProvider.calls.length, callsBefore + 1)
  registryDenied = true
  assert.equal((await post('resume', { record: result.snapshot.record, restart: true })).status, 400)
  assert.equal(ctx.roleplayTestProvider.calls.length, callsBefore + 1)
  assert.equal(z.object({ current_session: z.string() }).parse(await (await post('status')).json()).current_session, blocked.session)
  await ctx.fiber.dispose(); await assert.rejects(fetch(appOrigin))
})

void test('launch review fails closed for altered identity, unknown openings, unsupported content and changed authorization', async () => {
  const { createAppController } = await import('../src/app-controller.ts')
  const { ReleaseDetailSchema } = await import('@char-pub/contracts')
  const input = replayInput('narrator')
  assert.ok('release' in input.artifact.root)
  const artifact = input.artifact
  const root = input.artifact.root
  const receipt = ReleaseDetailSchema.parse({ id: root.release, ref: root.ref, creation: 'cr_01j00000000000000000000000', label: '1.0.0', visibility: 'public', status: 'active', semantic_digest: root.semantic_digest, effective_rating: 'general', created_at: new Date().toISOString(), lock_digest: artifact.lock_digest, context_ir_digest: null, artifact_digest: sha(JSON.stringify(artifact)), license_check: 'pass', availability: 'complete' })
  let epoch = 0
  let read = async () => ({ artifact, receipt })
  let creates = 0
  const app = createAppController({ listRecords: async () => ({ records: [] }), registryOrigin: 'https://registry.example',
    registry: { authorizationStatus: () => 'required', authorizationVersion: () => epoch, release: () => read(), draftBuild: () => read(), sourceTexts: async () => ({}) },
    profile: input.profile, model: { provider: 'fixed', model: 'fixed', maxTokens: 256 }, timeout_ms: 1000,
    runtime: { create: async () => { creates++; throw new Error('unexpected create') }, submit: async () => { throw new Error('unexpected model') }, inspect: async () => { throw new Error('unexpected inspect') } } })
  const launch = { format: 'char.pub/runtime-launch', version: 1, registry_origin: 'https://registry.example', source: root, lock_digest: artifact.lock_digest, locale: 'ja', view: { mode: 'narrator' } }
  await assert.rejects(app.review({ ...launch, registry_origin: 'https://attacker.example' }), /registry_mismatch/)
  await assert.rejects(app.review({ ...launch, lock_digest: `sha256:${'0'.repeat(64)}` }), /source_mismatch/)
  await assert.rejects(app.review({ ...launch, start: 'nonexistent' }), /start_unknown/)
  await assert.rejects(app.review({ ...launch, view: { mode: 'per-agent', for_participant: 'alice' } }), /participant_unknown/)
  const noStory = structuredClone(artifact)
  if (noStory.kind === 'content') delete noStory.story
  read = async () => ({ artifact: noStory, receipt })
  await assert.rejects(app.review(launch), /story_required/)
  const future = structuredClone(artifact); future.capabilities.push({ id: 'future.required' }); future.capabilities.sort((a, b) => a.id < b.id ? -1 : 1)
  read = async () => ({ artifact: future, receipt })
  await assert.rejects(app.review(launch), /capability_unsupported/)
  read = async () => { epoch++; return { artifact, receipt } }
  await assert.rejects(app.review(launch), /authorization_changed/)
  read = async () => ({ artifact, receipt })
  const reviewed = await app.review(launch); epoch++
  await assert.rejects(app.start({ review: reviewed.review, bindings: input.bindings, restart: false }), /authorization_changed/)
  assert.equal(creates, 0)
  await app.dispose()
})

void test('cancelling a pending Registry read cannot create a Session or accept its late result', async () => {
  const { createAppController } = await import('../src/app-controller.ts')
  const { ReleaseDetailSchema } = await import('@char-pub/contracts')
  const input = replayInput('narrator'); assert.ok('release' in input.artifact.root)
  const artifact = input.artifact; const root = input.artifact.root
  const receipt = ReleaseDetailSchema.parse({ id: root.release, ref: root.ref, creation: 'cr_01j00000000000000000000000', label: '1.0.0', visibility: 'public', status: 'active', semantic_digest: root.semantic_digest, effective_rating: 'general', created_at: new Date().toISOString(), lock_digest: artifact.lock_digest, context_ir_digest: null, artifact_digest: sha(JSON.stringify(artifact)), license_check: 'pass', availability: 'complete' })
  const read = Promise.withResolvers<{ artifact: typeof artifact; receipt: typeof receipt }>()
  const app = createAppController({ listRecords: async () => ({ records: [] }), registryOrigin: 'https://registry.example',
    registry: { authorizationStatus: () => 'required', authorizationVersion: () => 0, release: () => read.promise, draftBuild: () => read.promise, sourceTexts: async () => ({}) },
    profile: input.profile, model: { provider: 'fixed', model: 'fixed', maxTokens: 256 }, timeout_ms: 1000,
    runtime: { create: async () => { throw new Error('unexpected create') }, submit: async () => { throw new Error('unexpected model') }, inspect: async () => { throw new Error('unexpected inspect') } } })
  const pending = app.review({ format: 'char.pub/runtime-launch', version: 1, registry_origin: 'https://registry.example', source: root, lock_digest: artifact.lock_digest, locale: 'ja', view: { mode: 'narrator' } })
  app.cancel({}); read.resolve({ artifact, receipt })
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(app.start({ review: 'stale', bindings: input.bindings, restart: false }), /review_required/)
  await app.dispose()
})

void test('player snapshots use actual role visibility and resume checks source and grant without rewriting state', async () => {
  const { createAppController } = await import('../src/app-controller.ts')
  const { ReleaseDetailSchema } = await import('@char-pub/contracts')
  const input = replayInput('per-agent')
  const policyRelease = 'rel_01j00000000000000000000001'
  const policy = canonicalizeCreation({ id: 'cr_01j00000000000000000000001', ref: '@fixture/policy', type: 'preset', display_name: 'Test policy',
    meta: { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' },
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } } })
  input.artifact = buildCreation({
    root: { release: 'rel_01j00000000000000000000000', visibility: 'public', creation: {
      id: 'cr_01j00000000000000000000000', ref: '@fixture/inn', type: 'scenario', display_name: 'Visible role test',
      meta: { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' },
      cast: [{ key: 'alice', who: { late: 'character' }, part: 'Host', goal: 'Welcome visitors' },
        { key: 'bob', who: { late: 'character' }, part: 'Visitor', goal: 'BOB_PRIVATE_GOAL' }],
      fragments: [{ id: 'setting', stable: true, kind: 'scenario', content: { type: 'text', text: 'An inn.' } }],
      story: { version: 1, scenes: [{ id: 'lobby', title: 'Lobby' }] },
    } }, dependencies: [{ release: policyRelease, visibility: 'public', creation: policy.creation }],
    default_policy: { ref: policy.creation.ref, release: policyRelease, semantic_digest: policy.semantic_digest },
  }).artifact
  input.source_texts = {}
  const artifact = input.artifact
  assert.equal(artifact.kind, 'content'); assert.ok('release' in artifact.root)
  const pin = artifact.root
  const receipt = ReleaseDetailSchema.parse({ id: pin.release, ref: pin.ref, creation: 'cr_01j00000000000000000000000', label: '1.0.0', visibility: 'public', status: 'active', semantic_digest: pin.semantic_digest, effective_rating: 'general', created_at: new Date().toISOString(), lock_digest: artifact.lock_digest, context_ir_digest: null, artifact_digest: sha(JSON.stringify(artifact)), license_check: 'pass', availability: 'complete' })
  const projection = projectRoleplay([{ seq: SessionSeq(0), time: 1, type: 'roleplay/opened', data: makeOpened(input) }])
  const before = JSON.stringify(projection.log)
  let epoch = 0; let deny = false; let inspectChange = false
  const read = async () => { if (deny) throw new Error('registry.http_403'); return { artifact, receipt } }
  const createApp = () => createAppController({ registryOrigin: 'https://registry.example',
    registry: { authorizationStatus: () => 'authorized', authorizationVersion: () => epoch, release: read, draftBuild: read, sourceTexts: async () => ({}) },
    listRecords: async () => ({ records: [{ id: SessionId('persisted-player'), createdAt: 1, projection }] }),
    runtime: { create: async () => { throw new Error('no create on resume') }, submit: async () => { throw new Error('no model on resume') }, inspect: async () => { if (inspectChange) epoch++; return projection } },
    profile: input.profile, model: { provider: 'fixed', model: 'fixed', maxTokens: 256 }, timeout_ms: 1000 })
  const app = createApp()
  const listing = await app.sessions({}); const record = listing.items[0]?.record; assert.ok(record)
  const selected = await app.resume({ record, restart: false })
  const bobKey = artifact.kind === 'content' ? artifact.story_refs?.participants.bob : undefined; assert.ok(bobKey)
  const bob = selected.participants.find(participant => participant.key === bobKey); assert.ok(bob); assert.equal(bob.role, 'Visitor'); assert.equal(bob.goal, undefined)
  assert.ok(!JSON.stringify(selected).includes('BOB_PRIVATE_GOAL'))
  assert.ok(!('state' in selected)); assert.ok(!JSON.stringify(selected).includes('PRIVATE_'))
  assert.deepEqual(selected.late_slots, artifact.kind === 'content' ? artifact.ir.late_slots : [])
  assert.equal((await app.resume({ record, restart: false })).session, selected.session)
  assert.equal((await app.session({ session: selected.session })).record, record)
  inspectChange = true
  await assert.rejects(app.resume({ record, restart: true }), /authorization_changed/)
  inspectChange = false; deny = true
  await assert.rejects(app.resume({ record, restart: true }), /http_403/)
  assert.equal(JSON.stringify(projection.log), before)
  await app.dispose()
  deny = false
  const reopenedApp = createApp()
  const reopenedList = await reopenedApp.sessions({}); assert.equal(reopenedList.items[0]?.record, record)
  const reopened = await reopenedApp.resume({ record, restart: false }); assert.notEqual(reopened.session, selected.session)
  assert.equal(JSON.stringify(projection.log), before)
  await reopenedApp.dispose()
})
