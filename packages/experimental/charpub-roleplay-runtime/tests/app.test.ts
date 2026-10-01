/** Named profile + real loopback app + JSONL + offline model. Registry HTTP is an explicit protocol fixture. */
import assert from 'node:assert/strict'
import { z } from 'zod'
import { RuntimePreviewInputSchema, HistoryMessageSchema } from '@char-pub/core'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { initProfile, loadProfile, composeEntries, resolveProfileDir } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import { replayInput, SOURCE } from '../../charpub-roleplay/tests/fixtures.ts'
import type {} from './fixtures/provider.ts'
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
  const registry = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const path = new URL(req.url ?? '/', registryOrigin).pathname
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
      { id: 'test-provider', name: new URL('tests/fixtures/provider.ts', packageURL).href },
      { id: 'roleplay-app', name: new URL('src/app.ts', packageURL).href, config: { host: '127.0.0.1', port, registry_origin: registryOrigin, issuer: registryOrigin, client_id: 'offline-protocol-client', timeout_ms: 3000, max_request_bytes: 100_000, max_response_bytes: 2_000_000, max_artifact_bytes: 2_000_000, profile: input.profile, model: { provider: 'roleplay-test', model: 'fixed', maxTokens: 256 } } },
    ] },
  ]))
  const profile = loadProfile('test-dsh', 'roleplay', fileURLToPath(new URL('package.json', rootURL)), home)
  assert.deepEqual(profile.skippedBundles, [])
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]).map(entry => ({ ...entry, name: entry.name?.startsWith('@deepseek-ai/') ? import.meta.resolve(`${entry.name}/src/index.ts`) : entry.name }))
  const configuration = join(home, 'cordis.yml'); await writeFile(configuration, JSON.stringify(entries))
  ctx.baseUrl = pathToFileURL(home).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configuration).href } }); await ctx.loader.await()
  const page = await fetch(appOrigin); assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'private, no-store')
  const html = await page.text(); const nonce = html.match(/script nonce="([^"]+)"/)?.[1]; assert.ok(nonce)
  const generatedScript = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1]
  assert.ok(generatedScript)
  assert.ok(html.includes(`id="registry-link" href="${registryOrigin}/"`))
  assert.match(html, /<details id="manual-launch"><summary>Advanced: paste launch JSON<\/summary>/)
  assert.doesNotThrow(() => new Script(generatedScript))
  const post = async (path: string, value: unknown, origin = appOrigin) => fetch(`${appOrigin}/api/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-roleplay-client': nonce }, body: JSON.stringify(value) })
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
  const generated = await post('turn', { session, text: 'PRIVATE_CHAT' }); assert.equal(generated.status, 200, await generated.clone().text())
  const result = z.object({ status: z.string(), history: z.array(HistoryMessageSchema) }).parse(await generated.json()); assert.equal(result.status, 'success'); assert.equal(result.history.at(-1)?.text, 'The innkeeper nods.'); assert.equal(ctx.roleplayTestProvider.calls.length, 1)
  const reviewExport = await post('prepare-export', { session, history: [{ role: 'user', text: 'A synthetic public summary' }], bindings: syntheticBindings }); assert.equal(reviewExport.status, 200, await reviewExport.clone().text()); const reviewed = z.object({ digest: z.string(), payload: RuntimePreviewInputSchema }).parse(await reviewExport.json())
  assert.ok(JSON.stringify(ctx.roleplayTestProvider.calls[0]?.messages).includes('PRIVATE_BINDING_MUST_NOT_EXPORT'))
  assert.ok(!JSON.stringify(reviewed).includes('PRIVATE_CHAT'))
  assert.ok(!JSON.stringify(reviewed).includes('PRIVATE_BINDING_MUST_NOT_EXPORT'))
  const exported = await post('export', { session, digest: reviewed.digest }); assert.equal(exported.status, 200); assert.equal(z.object({ payload: RuntimePreviewInputSchema }).parse(await exported.json()).payload.turn.history[0]?.text, 'A synthetic public summary')
  const files = await readdir(join(home, 'sessions'), { recursive: true }); const logs = files.filter(file => file.endsWith('.jsonl')); assert.equal(logs.length, 1)
  const oldBytes = await readFile(join(home, 'sessions', logs[0] ?? ''))
  const newer = z.object({ review: z.string(), restart_required: z.boolean() }).parse(await (await post('review', launch)).json()); assert.equal(newer.restart_required, true)
  assert.equal((await post('start', { review: newer.review, bindings: input.bindings, restart: false })).status, 400)
  const second = await post('start', { review: newer.review, bindings: input.bindings, restart: true })
  assert.equal(second.status, 200)
  const secondSession = z.object({ session: z.string() }).parse(await second.json()).session
  assert.notEqual(secondSession, session)
  for (const [path, body] of [
    ['turn', { session, text: 'OLD_TAB_MUST_NOT_COMMIT' }],
    ['prepare-export', { session, history: [], bindings: {} }],
    ['export', { session, digest: reviewed.digest }],
    ['cancel', { session }],
  ] as const) {
    const denied = await post(path, body)
    assert.equal(denied.status, 400)
    assert.match(await denied.text(), /stale_session/)
  }
  assert.deepEqual(await readFile(join(home, 'sessions', logs[0] ?? '')), oldBytes)
  ctx.roleplayTestProvider.mode = 'cancel'; const pending = post('turn', { session: secondSession, text: 'cancel this generation' })
  await new Promise<void>((resolve) => { ctx.roleplayTestProvider.onRequest = resolve })
  assert.equal((await post('cancel', { session: secondSession })).status, 200); assert.equal(z.object({ status: z.string() }).parse(await (await pending).json()).status, 'cancelled')
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
  const app = createAppController({ registryOrigin: 'https://registry.example',
    registry: { authorizationVersion: () => epoch, release: () => read(), draftBuild: () => read(), sourceTexts: async () => ({}) },
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
  const app = createAppController({ registryOrigin: 'https://registry.example',
    registry: { authorizationVersion: () => 0, release: () => read.promise, draftBuild: () => read.promise, sourceTexts: async () => ({}) },
    profile: input.profile, model: { provider: 'fixed', model: 'fixed', maxTokens: 256 }, timeout_ms: 1000,
    runtime: { create: async () => { throw new Error('unexpected create') }, submit: async () => { throw new Error('unexpected model') }, inspect: async () => { throw new Error('unexpected inspect') } } })
  const pending = app.review({ format: 'char.pub/runtime-launch', version: 1, registry_origin: 'https://registry.example', source: root, lock_digest: artifact.lock_digest, locale: 'ja', view: { mode: 'narrator' } })
  app.cancel({}); read.resolve({ artifact, receipt })
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(app.start({ review: 'stale', bindings: input.bindings, restart: false }), /review_required/)
  await app.dispose()
})
