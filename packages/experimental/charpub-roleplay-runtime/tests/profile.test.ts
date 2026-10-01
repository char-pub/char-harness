/** Named profile loading and real Loader activation of the reusable roleplay bundle. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, initProfile, loadProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { requestMessages } from '../src/index.ts'
import { replayInput, command } from '../../charpub-roleplay/tests/fixtures.ts'
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
