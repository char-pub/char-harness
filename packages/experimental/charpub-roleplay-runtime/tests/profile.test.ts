/** Named profile loading and real Loader activation of the reusable roleplay bundle. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot/src/index.ts'
import { composeEntries, initProfile, loadProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RuntimeProfileSchema } from '@char-pub/core'
import { z } from 'zod'
import { requestMessages } from '../src/index.ts'
import { replayInput, command } from '../../charpub-roleplay/tests/fixtures.ts'
import { appendCommand, createReplay, replay } from '../../charpub-roleplay/src/index.ts'
import type {} from './fixtures/provider.ts'

const bundle = '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime'
const anchor = fileURLToPath(new URL('../../../../package.json', import.meta.url))
const limits = { timeout_ms: 5000, max_event_bytes: 1_000_000, max_stream_bytes: 100_000 }

void test('named roleplay profile composes its allowlisted bundle and mounts real services through Loader', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'charpub-roleplay-profile-'))
  const ctx = new Context()
  context.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const dir = resolveProfileDir('roleplay', home)
  initProfile(dir, [bundle])
  const profilePatch = [
    { id: 'roleplay-storage', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'roleplay-runtime', config: limits },
    { insert: [{ id: 'test-provider', name: new URL('./fixtures/provider.ts', import.meta.url).href }] },
  ]
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify(profilePatch))
  const profile = loadProfile('test-dsh', 'roleplay', anchor, home)
  assert.equal(profile.name, 'roleplay')
  assert.deepEqual(profile.skippedBundles, [])
  assert.deepEqual(profile.layers.map(layer => layer.packageName), [bundle])
  const base = composeEntries(profile.layers.map(layer => layer.patches))
  assert.deepEqual(base.map(entry => [entry.id, entry.name]), [
    ['roleplay-session', '@deepseek-ai/dsh-session'],
    ['roleplay-llm', '@deepseek-ai/dsh-llm'],
    ['roleplay-storage', '@deepseek-ai/dsh-session-persistence-jsonl'],
    ['roleplay-runtime', bundle],
  ])
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  assert.deepEqual(entries.find(entry => entry.id === 'roleplay-runtime')?.config, limits)
  // Source-plane tests use the packages' declared ./src exports; the bundle's actual names and configs stay authoritative.
  const sourceEntries = entries.map(entry => ({
    ...entry,
    name: entry.name?.startsWith('@deepseek-ai/') ? import.meta.resolve(`${entry.name}/src/index.ts`) : entry.name,
  }))
  const filename = join(dir, 'composed.yml')
  await writeFile(filename, JSON.stringify(sourceEntries))
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } })
  await ctx.loader.await()
  assert.ok(ctx.get('roleplayRuntime'))
  assert.equal(ctx.get('agentLoop'), undefined)
  assert.equal(ctx.get('systemPrompt'), undefined)
  assert.equal(ctx.get('tools'), undefined)
  const id = SessionId('profile-story')
  await ctx.roleplayRuntime.create(id, replayInput())
  const settled = await ctx.roleplayRuntime.submit(id, command('hello', { kind: 'input', text: 'Hello.' }), {
    provider: 'roleplay-test', model: 'fixed', maxTokens: 256,
  })
  assert.equal(settled.status, 'success')
  const projection = await ctx.roleplayRuntime.inspect(id)
  const requested = [...projection.requests.values()][0]
  assert.ok(requested)
  assert.deepEqual(ctx.roleplayTestProvider.calls[0]?.messages, requestMessages(requested))
  assert.equal(ctx.roleplayTestProvider.calls[0]?.tools, undefined)
  assert.equal(projection.current.turn.history.at(-1)?.text, 'The innkeeper nods.')
})

void test('shipped app capabilities preserve all SDK system regions on the DeepSeek Messages wire', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'charpub-deepseek-wire-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const requests: unknown[] = []
  const events = [
    { type: 'message_start', message: { id: 'wire-response', model: 'deepseek-flash', usage: { input_tokens: 50, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The innkeeper nods.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ]
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.setHeader('content-type', 'text/event-stream')
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
  })
  context.after(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const overlay = loadOverlayPatches('test-dsh', fileURLToPath(new URL('../app.patch.yml', import.meta.url)))
  const app = composeEntries([overlay]).find(entry => entry.id === 'roleplay-app')
  const { profile: { capabilities } } = z.object({
    profile: z.object({ capabilities: RuntimeProfileSchema.shape.capabilities }),
  }).parse(app?.config)
  const dir = resolveProfileDir('roleplay', home)
  initProfile(dir, [bundle])
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([
    { id: 'roleplay-storage', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'roleplay-runtime', config: limits },
    { insert: [
      { id: 'wire-credentials', name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: home, watch: false } },
      { id: 'roleplay-model', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: {
        baseURL: `http://127.0.0.1:${address.port}/anthropic`, apiKeyEnv: 'CHARPUB_ROLEPLAY_WIRE_TEST_KEY',
      } },
    ] },
  ]))
  const profile = loadProfile('test-dsh', 'roleplay', anchor, home)
  assert.deepEqual(profile.skippedBundles, [])
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]).map(entry => ({
    ...entry, name: entry.name?.startsWith('@deepseek-ai/') ? import.meta.resolve(`${entry.name}/src/index.ts`) : entry.name,
  }))
  const filename = join(dir, 'composed.yml')
  await writeFile(filename, JSON.stringify(entries))
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } })
  await ctx.loader.await()
  await ctx.credentials.set(credentialRef('CHARPUB_ROLEPLAY_WIRE_TEST_KEY'), 'sk-local-wire-test')

  const input = replayInput()
  input.profile.capabilities = capabilities
  for (const binding of Object.values(input.bindings)) binding.description = `${binding.display_name} is waiting at the rainy inn.`
  const turn = command('wire-input', { kind: 'input', text: 'Who is here, and what can Alice tell me?' })
  const separated = replay(appendCommand(createReplay({ ...input, profile: {
    ...input.profile, capabilities: { ...capabilities, multiple_system_messages: true },
  } }), turn)).current.assembly.messages
  const systems = separated.filter(message => message.role === 'system')
  assert.ok(systems.length > 1, 'the SDK fixture must exercise separate system regions')
  const id = SessionId('deepseek-wire-story')
  await ctx.roleplayRuntime.create(id, input)
  const settled = await ctx.roleplayRuntime.submit(id, turn, { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 256 })
  assert.equal(settled.status, 'success')
  assert.equal(requests.length, 1)
  const wire = z.looseObject({ system: z.string(), messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']), content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  })) }).parse(requests[0])
  assert.equal(wire.system, systems.map(message => message.content).join('\n\n'))
  assert.deepEqual(wire.messages, separated.filter(message => message.role !== 'system').map(message => ({
    role: message.role, content: [{ type: 'text', text: message.content }],
  })))
  const projection = await ctx.roleplayRuntime.inspect(id)
  const requested = [...projection.requests.values()][0]
  assert.ok(requested)
  assert.deepEqual(requested.messages.filter(message => message.role === 'system').map(message => message.content), [wire.system])
  context.assert.snapshot({ prepared: requested.messages, wire })
  const split = structuredClone(input)
  assert.equal(split.artifact.kind, 'content')
  assert.ok(split.artifact.default_policy)
  split.artifact.default_policy.policy.blocks.push({ id: 'after-dialogue', text: 'Late policy.', position: 'after-history' })
  await assert.rejects(ctx.roleplayRuntime.create(SessionId('split-system-story'), split), { code: 'assemble.preset_incompatible' })
  assert.equal(requests.length, 1)
})
