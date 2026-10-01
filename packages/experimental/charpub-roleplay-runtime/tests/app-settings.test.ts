/** Settings routes of the named roleplay app over the real profile boot, config editor, settings, credentials and LLM directory. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import yaml from 'js-yaml'
import { boot, initProfile, loadOverlayPatches, PluginPackages, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { readPluginMeta } from '@deepseek-ai/dsh-app-boot/src/package-meta.ts'
import { replayInput } from '../../charpub-roleplay/tests/fixtures.ts'

const packageURL = new URL('../', import.meta.url)
const anchor = fileURLToPath(new URL('../../../../package.json', import.meta.url))
const source = (name: string) => import.meta.resolve(`${name}/src/index.ts`)
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => server.close(() => { resolve() })); return address.port
}
const Credential = z.strictObject({ configured: z.boolean(), source: z.string().optional(), writable: z.boolean() })
const Form = z.object({ value: z.record(z.string(), z.unknown()), user: z.unknown(), revision: z.number(), writable: z.boolean() })
const Models = z.object({ providers: z.array(z.object({
  provider: z.string(), ns: z.string(), credential_ref: z.string(), credential: Credential,
  settings_writable: z.boolean(), form: Form.optional(),
})) })
const Plugins = z.object({ entries: z.array(z.object({
  ns: z.string(), configurable: z.string(), phase: z.string().nullable(), meta: z.object({ icon: z.string().optional() }).optional(),
})) })

const appModule = '@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app'
/** Workspace packages load from source; the app subpath maps to its source module. */
function sourced(row: EntryOptions): EntryOptions {
  if (row.name === appModule) return { ...row, name: new URL('src/app.ts', packageURL).href }
  return row.name?.startsWith('@deepseek-ai/') ? { ...row, name: source(row.name) } : row
}
/** Boot one profile the way the dsh launcher composes it, then open the app's same-origin API. */
async function launch(profile: ProfileContext, port: number) {
  const patches: PatchOptions[] = readProfilePatches('test-dsh', profile)
    .map(patch => (patch.insert === undefined ? patch : { ...patch, insert: patch.insert.map(sourced) }))
  await writeFile(join(profile.dir, 'cordis.yml'), '[]\n')
  const ctx = await boot('test-dsh', join(profile.dir, 'cordis.yml'), patches, async (host) => {
    host.provide('profileContext', profile)
    // The launcher's package lookup supplies plugin display metadata.
    await host.plugin(PluginPackages, {})
  }, pathToFileURL(anchor).href)
  const origin = `http://127.0.0.1:${String(port)}`
  const html = await (await fetch(origin)).text()
  const bootstrap = html.match(/<script id="charpub-bootstrap" type="application\/json">([^<]*)<\/script>/)?.[1] ?? '{}'
  const nonce = z.object({ nonce: z.string() }).parse(JSON.parse(bootstrap)).nonce
  const post = async (path: string, value: unknown = {}) => fetch(`${origin}/api/${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-roleplay-client': nonce }, body: JSON.stringify(value),
  })
  return { ctx, post }
}
function profileOf(home: string, overlays: PatchOptions[]): ProfileContext {
  const dir = join(home, 'profiles', 'roleplay')
  initProfile(dir, ['@deepseek-ai/dsh-experimental-charpub-roleplay-runtime'])
  return {
    name: 'roleplay', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    startedBundles: ['@deepseek-ai/dsh-experimental-charpub-roleplay-runtime'], overlays, telemetryDisabledEnv: '1',
  }
}

async function start(options: { overlayModel?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'charpub-app-settings-'))
  const port = await freePort()
  const input = replayInput('narrator')
  const app = {
    id: 'roleplay-app', name: new URL('src/app.ts', packageURL).href,
    config: {
      host: '127.0.0.1', port, registry_origin: 'http://127.0.0.1:9', issuer: 'http://127.0.0.1:9', client_id: 'offline',
      timeout_ms: 3000, max_request_bytes: 100_000, max_response_bytes: 2_000_000, max_artifact_bytes: 2_000_000,
      profile: input.profile, model: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 256 }, credential_ref: 'CHARPUB_SETTINGS_TEST_KEY',
    },
  }
  const model = {
    id: 'roleplay-model', name: source('@deepseek-ai/dsh-llm-deepseek-api-key'),
    ...(options.overlayModel ? { config: { apiKeyEnv: 'CHARPUB_SETTINGS_TEST_KEY' } } : {}),
  }
  const profile = profileOf(home, options.overlayModel ? [{ insert: [model] }] : [])
  const rows = [
    { id: 'roleplay-config-editor', name: source('@deepseek-ai/dsh-config-editor') },
    { id: 'roleplay-settings', name: source('@deepseek-ai/dsh-settings') },
    { id: 'roleplay-credentials', name: source('@deepseek-ai/dsh-credentials-local'), config: { dshHome: home, watch: false } },
    model, app,
  ]
  // Profile rows mirror app.patch.yml; the overlay case moves the model row into a command-line overlay.
  await writeFile(profile.patchPath, yaml.dump([
    { id: 'roleplay-storage', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'roleplay-runtime', config: { timeout_ms: 3000, max_event_bytes: 2_000_000, max_stream_bytes: 100_000 } },
    { insert: rows.filter(row => !options.overlayModel || row !== model) },
  ]))
  const { ctx, post } = await launch(profile, port)
  return {
    home, dir: profile.dir, post,
    close: async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) },
  }
}

void test('Models settings write live provider fields to the profile patch and keys to the credential store', async (context) => {
  const app = await start()
  context.after(app.close)
  const models = Models.parse(await (await app.post('settings/models')).json())
  const deepseek = models.providers.find(row => row.provider === 'deepseek-official')
  assert.ok(deepseek?.form)
  assert.equal(deepseek.ns, 'roleplay-model')
  assert.equal(deepseek.credential_ref, 'DEEPSEEK_API_KEY')
  assert.deepEqual(deepseek.credential, { configured: false, writable: true })
  assert.equal(deepseek.settings_writable, true)

  const saved = await app.post('settings/models/save', {
    ns: 'roleplay-model', revision: deepseek.form.revision, api_key: ' sk-settings-test ',
    ops: [{ op: 'set', path: ['baseURL'], value: 'https://gateway.example/anthropic' }],
  })
  assert.equal(saved.status, 200, await saved.clone().text())
  const after = Models.parse(await saved.json()).providers.find(row => row.ns === 'roleplay-model')
  assert.equal(after?.form?.value.baseURL, 'https://gateway.example/anthropic')
  assert.deepEqual(after?.credential, { configured: true, source: 'file', writable: true })
  assert.match(await readFile(join(app.dir, 'cordis.patch.yml'), 'utf8'), /baseURL: https:\/\/gateway\.example\/anthropic/)
  assert.match(await readFile(join(app.home, '.credentials.yaml'), 'utf8'), /DEEPSEEK_API_KEY: sk-settings-test\n/)

  // A stale revision is refused instead of overwriting the newer section.
  const stale = await app.post('settings/models/save', { ns: 'roleplay-model', revision: deepseek.form.revision, ops: [{ op: 'unset', path: ['baseURL'] }] })
  assert.equal(stale.status, 400)
  assert.match(await stale.text(), /settings_conflict/)
  assert.equal((await app.post('settings/models/save', { ns: 'roleplay-runtime', ops: [] })).status, 400)
  assert.equal((await app.post('settings/models/save', { ns: 'roleplay-model', ops: [], api_key: '   ' })).status, 400)

  const cleared = Models.parse(await (await app.post('settings/models/clear-key', { ns: 'roleplay-model' })).json())
  assert.deepEqual(cleared.providers.find(row => row.ns === 'roleplay-model')?.credential, { configured: false, writable: true })
  const reset = await app.post('settings/models/save', {
    ns: 'roleplay-model', revision: after?.form?.revision, ops: [{ op: 'unset', path: ['baseURL'] }],
  })
  assert.equal(reset.status, 200, await reset.clone().text())
  assert.doesNotMatch(await readFile(join(app.dir, 'cordis.patch.yml'), 'utf8'), /gateway\.example/)
})

void test('plugin list reports Loader entries; forms exclude the app and the Models namespace', async (context) => {
  const app = await start()
  context.after(app.close)
  const plugins = Plugins.parse(await (await app.post('settings/plugins')).json())
  const byNs = new Map(plugins.entries.map(entry => [entry.ns, entry]))
  for (const ns of ['roleplay-runtime', 'roleplay-settings', 'roleplay-credentials', 'roleplay-app']) assert.equal(byNs.get(ns)?.phase, 'active', ns)
  assert.equal(byNs.get('roleplay-model')?.configurable, 'models')
  assert.equal(byNs.get('roleplay-app')?.configurable, 'none')
  for (const ns of ['roleplay-app', 'roleplay-model', 'missing']) {
    assert.equal((await app.post('settings/plugin/save', { ns, ops: [] })).status, 400, ns)
  }
  // The runtime's limits are ordinary fields: writing them would restart the driver under active Sessions.
  const ordinary = await app.post('settings/plugin/save', { ns: 'roleplay-runtime', ops: [{ op: 'set', path: ['timeout_ms'], value: 5 }] })
  assert.equal(ordinary.status, 400)
  assert.match(await ordinary.text(), /settings_not_live/)
  assert.doesNotMatch(await readFile(join(app.dir, 'cordis.patch.yml'), 'utf8'), /timeout_ms: 5\b/)
  assert.equal((await app.post('settings/plugin', { ns: 'roleplay-app' })).status, 400)
})

void test('a command-line overlay row is reported read-only and its settings write is refused', async (context) => {
  const app = await start({ overlayModel: true })
  context.after(app.close)
  const models = Models.parse(await (await app.post('settings/models')).json())
  const row = models.providers.find(entry => entry.ns === 'roleplay-model')
  assert.equal(row?.settings_writable, false)
  assert.equal(row?.form?.writable, false)
  const refused = await app.post('settings/models/save', { ns: 'roleplay-model', revision: row?.form?.revision, ops: [{ op: 'set', path: ['baseURL'], value: 'https://x.example' }] })
  assert.equal(refused.status, 400)
  assert.match(await refused.text(), /settings_overridden/)
  // The key still has its own writable store.
  const keyed = await app.post('settings/models/save', { ns: 'roleplay-model', ops: [], api_key: 'sk-overlay' })
  assert.equal(keyed.status, 200, await keyed.clone().text())
  assert.match(await readFile(join(app.home, '.credentials.yaml'), 'utf8'), /CHARPUB_SETTINGS_TEST_KEY: sk-overlay\n/)
})

void test('the runtime package publishes localized plugin display metadata and the char.pub icon', () => {
  const meta = readPluginMeta('@deepseek-ai/dsh-experimental-charpub-roleplay-runtime', pathToFileURL(anchor).href)
  assert.deepEqual(meta?.title, { en: 'char.pub roleplay', zh: 'char.pub 角色扮演' })
  assert.equal(typeof meta?.description === 'object' && meta.description.zh, '在本地持久会话中游玩 char.pub 故事的精确版本。')
  assert.match(meta?.icon ?? '', /^data:image\/svg\+xml;base64,/)
  assert.equal(meta?.error, undefined)
})

void test('the shipped app.patch.yml overlay composes the Settings rows; overlay-owned fields are read-only while keys stay writable', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'charpub-app-overlay-'))
  const port = await freePort()
  const env = {
    CHARPUB_SESSION_ROOT: join(home, 'sessions'), CHARPUB_REQUEST_TIMEOUT_MS: '3000', CHARPUB_MAX_EVENT_BYTES: '2000000',
    CHARPUB_MAX_STREAM_BYTES: '100000', CHARPUB_APP_PORT: String(port), CHARPUB_REGISTRY_ORIGIN: 'http://127.0.0.1:9',
    CHARPUB_OAUTH_ISSUER: 'http://127.0.0.1:9', CHARPUB_OAUTH_CLIENT_ID: 'offline', CHARPUB_APP_REQUEST_BYTES: '100000',
    CHARPUB_APP_RESPONSE_BYTES: '2000000', CHARPUB_APP_ARTIFACT_BYTES: '2000000', CHARPUB_CONTEXT_WINDOW: '64000',
    CHARPUB_OUTPUT_TOKENS: '256', CHARPUB_MODEL: 'deepseek-flash',
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  // The overlay's credential provider reads $DSH_HOME; keep it inside this test's home.
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restore = () => {
    for (const [key, value] of Object.entries({ ...previous, DSH_HOME: previousHome })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
  const profile = profileOf(home, loadOverlayPatches('test-dsh', fileURLToPath(new URL('app.patch.yml', packageURL))))
  const { ctx, post } = await launch(profile, port)
  context.after(async () => { await ctx.fiber.dispose(); restore(); await rm(home, { recursive: true, force: true }) })
  const row = Models.parse(await (await post('settings/models')).json()).providers.find(entry => entry.ns === 'roleplay-model')
  assert.equal(row?.credential_ref, 'DEEPSEEK_API_KEY')
  assert.equal(row.settings_writable, false)
  assert.equal(row.form?.writable, false)
  assert.equal(row.credential.writable, true)
  const keyed = await post('settings/models/save', { ns: 'roleplay-model', ops: [], api_key: 'sk-overlay-default' })
  assert.equal(keyed.status, 200, await keyed.clone().text())
  assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /DEEPSEEK_API_KEY: sk-overlay-default\n/)
  const plugins = Plugins.parse(await (await post('settings/plugins')).json())
  for (const ns of ['roleplay-config-editor', 'roleplay-settings', 'roleplay-credentials', 'roleplay-model', 'roleplay-app']) {
    assert.equal(plugins.entries.find(entry => entry.ns === ns)?.phase, 'active', ns)
  }
})
