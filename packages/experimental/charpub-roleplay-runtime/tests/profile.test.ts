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
import Loader, { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot/src/index.ts'
import { composeEntries, initProfile, loadProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RuntimeProfileSchema } from '@char-pub/core'
import { z } from 'zod'
import { requestMessages, RoleplayPlayConfigSchema } from '../src/index.ts'
import { replayInput, command } from '../../charpub-roleplay/tests/fixtures.ts'
import { appendCommand, commandId, createReplay, replay } from '../../charpub-roleplay/src/index.ts'
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
  const previousModel = process.env.CHARPUB_MODEL
  const previousDecisionModel = process.env.CHARPUB_DECISION_MODEL
  process.env.DSH_HOME = home
  process.env.CHARPUB_MODEL = 'deepseek-flash'
  process.env.CHARPUB_DECISION_MODEL = 'deepseek-v4-pro'
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
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(body)
      const requestBody = z.looseObject({ system: z.string(), messages: z.array(z.object({
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      })) }).parse(body)
      let text = 'The innkeeper nods.'
      if (requestBody.system.includes('"actions":[')) text = JSON.stringify({
        actions: [{ target: 'beat/reward', confidence: 0.95 }], judgments: [],
      })
      else if (requestBody.system.startsWith('Score the relevance')) {
        const query = z.object({ questions: z.record(z.string(), z.unknown()) }).parse(JSON.parse(
          requestBody.messages.at(-1)?.content[0]?.text ?? '{}',
        ))
        text = JSON.stringify({ answers: Object.fromEntries(Object.keys(query.questions).map(key =>
          [key, { type: 'noul', noul: 0.1, confidence: 0.95 }])) })
      }
      response.setHeader('content-type', 'text/event-stream')
      response.end(events.map((event) => {
        const payload = event.type === 'content_block_delta' ? { ...event, delta: { type: 'text_delta', text } } : event
        return `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`
      }).join(''))
    })
  })
  context.after(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousModel === undefined) delete process.env.CHARPUB_MODEL
    else process.env.CHARPUB_MODEL = previousModel
    if (previousDecisionModel === undefined) delete process.env.CHARPUB_DECISION_MODEL
    else process.env.CHARPUB_DECISION_MODEL = previousDecisionModel
    await rm(home, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const overlay = loadOverlayPatches('test-dsh', fileURLToPath(new URL('../app.patch.yml', import.meta.url)))
  const app = composeEntries([overlay]).find(entry => entry.id === 'roleplay-app')
  const appConfig: unknown = interpolate(ctx, app?.config)
  delete process.env.CHARPUB_DECISION_MODEL
  const fallbackOverlay = loadOverlayPatches('test-dsh', fileURLToPath(new URL('../app.patch.yml', import.meta.url)))
  const fallbackApp = composeEntries([fallbackOverlay]).find(entry => entry.id === 'roleplay-app')
  assert.equal(z.object({ play: z.object({ decisions: z.object({ model: z.string() }) }) }).parse(interpolate(ctx, fallbackApp?.config)).play.decisions.model, 'deepseek-flash')
  process.env.CHARPUB_DECISION_MODEL = 'deepseek-v4-pro'
  const { profile: { capabilities } } = z.object({
    profile: z.object({ capabilities: RuntimeProfileSchema.shape.capabilities }),
  }).parse(appConfig)
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

  const appRoutes = z.object({
    model: z.object({ provider: z.literal('deepseek-official'), model: z.literal('deepseek-flash'), reasoningEffort: z.literal('off') }),
    play: z.object({
      decisions: z.object({ provider: z.literal('deepseek-official'), model: z.literal('deepseek-v4-pro'),
        reasoningEffort: z.literal('low'), maxTokens: z.literal(12288), temperature: z.literal(0) }),
      limits: RoleplayPlayConfigSchema.shape.limits,
    }) }).parse(appConfig)
  const settings = appRoutes.play
  const playConfig = RoleplayPlayConfigSchema.parse({ ...settings,
    generation: { ...appRoutes.model, model: 'deepseek-flash', maxTokens: 256 },
    decisions: settings.decisions,
  })
  assert.equal(playConfig.limits.max_decision_tokens, 64000)
  const played = await ctx.roleplayRuntime.play(id, {
    id: commandId('wire-play'), expected_revision: projection.revision, text: 'I claim the token.',
  }, playConfig)
  assert.equal(played.settlement.status, 'success')
  const finished = await ctx.roleplayRuntime.inspect(id)
  assert.equal(finished.current.state.vars.count, 1)
  const turnRecord = finished.turns.get(commandId('wire-play'))
  assert.ok(turnRecord)
  assert.equal(turnRecord.decisions.size, 2)
  assert.equal(requests.length, 4)
  const decisionWire = requests.slice(1, 3).map(value => z.looseObject({
    system: z.string(), model: z.literal('deepseek-v4-pro'), thinking: z.object({ type: z.literal('enabled') }),
    output_config: z.object({ effort: z.literal('low') }), max_tokens: z.literal(12288), temperature: z.literal(0),
    messages: z.array(z.object({ role: z.literal('user'), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })),
  }).parse(value))
  assert.deepEqual(decisionWire.map(value => value.system), [...turnRecord.decisions.values()].map(value =>
    value.requested.messages.find(message => message.role === 'system')?.content))
  assert.ok([...turnRecord.decisions.values()].every(value => value.settled?.status === 'success'))
  for (const { requested } of turnRecord.decisions.values()) {
    assert.equal(requested.proposed_config.temperature, 0)
    assert.equal(requested.config.temperature, 0)
    assert.equal(requested.proposed_config.reasoningEffort, 'low')
    assert.equal(requested.config.reasoningEffort, 'low')
    assert.equal(requested.config.model, 'deepseek-v4-pro')
  }
  const generationWire = z.object({ model: z.literal('deepseek-flash'), thinking: z.object({ type: z.literal('disabled') }), max_tokens: z.literal(256) }).parse(requests[3])
  context.assert.snapshot({ decisionWire, generationWire, resolution: played.resolution })
})
