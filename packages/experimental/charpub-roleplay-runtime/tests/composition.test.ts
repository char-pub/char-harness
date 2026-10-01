/** Real Loader composition with actual Session/JSONL/LLM services and a network-free provider. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SessionId } from '@deepseek-ai/dsh-session'
import { digestOf } from '@char-pub/core'
import { requestMessages, makeRequested } from '../src/index.ts'
import { command, replayInput } from '../../charpub-roleplay/tests/fixtures.ts'
import type {} from './fixtures/provider.ts'

const packageURL = new URL('../', import.meta.url)
const rootURL = new URL('../../../../', import.meta.url)
const config = { timeout_ms: 5000, max_event_bytes: 1_000_000, max_stream_bytes: 100_000 }
const call = { provider: 'roleplay-test', model: 'fixed', maxTokens: 512 }

async function load(root: string, limits = config) {
  const filename = join(root, 'cordis.yml')
  const entries = [
    { name: new URL('packages/core/session/src/index.ts', rootURL).href },
    { name: new URL('packages/llm/llm/src/index.ts', rootURL).href },
    { name: new URL('packages/session/session-persistence-jsonl/src/index.ts', rootURL).href, config: { root: join(root, 'sessions'), compression: 'none' } },
    { name: new URL('tests/fixtures/provider.ts', packageURL).href },
    { name: new URL('src/index.ts', packageURL).href, config: limits },
  ]
  // JSON is a YAML subset; Loader still owns loading and configuring every product service.
  await writeFile(filename, JSON.stringify(entries))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } })
  await ctx.loader.await()
  assert.ok(ctx.get('roleplayRuntime'), 'roleplay runtime must activate through Loader')
  return ctx
}

void test('real Session projection is the sole generation input and survives close/reopen', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-roleplay-'))
  let ctx = await load(root)
  context.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId('durable-story')
  await ctx.roleplayRuntime.create(id, replayInput('per-agent'))
  const first = command('reward', { kind: 'confirm', target: 'beat/reward' }, { for_participant: 'alice' })
  const result = await ctx.roleplayRuntime.submit(id, first, call)
  assert.equal(result.status, 'success')
  const saved = await ctx.roleplayRuntime.inspect(id)
  assert.equal(saved.current.state.vars.count, 1)
  assert.equal(saved.current.turn.history.at(-1)?.text, 'The innkeeper nods.')
  assert.equal(ctx.roleplayTestProvider.calls.length, 1)
  const request = [...saved.requests.values()][0]
  assert.ok(request)
  assert.deepEqual(ctx.roleplayTestProvider.calls[0]?.messages, requestMessages(request))
  assert.equal(ctx.roleplayTestProvider.calls[0]?.system, undefined)
  assert.equal(ctx.roleplayTestProvider.calls[0]?.tools, undefined)
  assert.ok(!ctx.get('agentLoop'))
  assert.ok(!ctx.get('systemPrompt'))
  assert.ok(!ctx.get('shell'))
  assert.deepEqual(await ctx.roleplayRuntime.submit(id, first, call), result)
  assert.equal(ctx.roleplayTestProvider.calls.length, 1)
  await assert.rejects(ctx.roleplayRuntime.submit(id, first, { ...call, model: 'another' }), { code: 'roleplay_runtime.command_conflict' })
  await assert.rejects(ctx.roleplayRuntime.submit(id, { ...first, operation: { kind: 'prepare' } }, call), { code: 'roleplay_runtime.command_conflict' })
  const bob = command('bob', { kind: 'enter-scene', scene: 'garden' }, { for_participant: 'bob' })
  await ctx.roleplayRuntime.submit(id, bob, call)
  const last = ctx.roleplayTestProvider.calls.at(-1)
  assert.ok(last)
  assert.ok(!JSON.stringify(last.messages).includes('ALICE_ONLY_SECRET'))
  assert.equal(last.messages.filter(message => message.role === 'assistant').length, 2)
  context.assert.snapshot(ctx.roleplayTestProvider.calls.map(request => ({
    provider: request.provider, model: request.model,
    messages: request.messages.map(message => ({ role: message.role, content: message.content })),
  })))
  const beforeClose = await ctx.roleplayRuntime.inspect(id)
  await ctx.fiber.dispose()
  ctx = await load(root)
  const reopened = await ctx.roleplayRuntime.inspect(id)
  assert.equal(digestOf(reopened.log), digestOf(beforeClose.log))
  assert.deepEqual([...reopened.requests.values()].map(requestMessages), [...beforeClose.requests.values()].map(requestMessages))
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
  assert.deepEqual(await ctx.roleplayRuntime.submit(id, first, call), result)
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
})

void test('cancellation and failed generation keep prospective facts uncommitted', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-roleplay-cancel-'))
  const ctx = await load(root)
  context.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId('cancelled-story')
  await ctx.roleplayRuntime.create(id, replayInput())
  const controller = new AbortController()
  ctx.roleplayTestProvider.mode = 'cancel'
  ctx.roleplayTestProvider.onRequest = () => { controller.abort(new Error('cancel test')) }
  const result = await ctx.roleplayRuntime.submit(id, command('cancel', { kind: 'confirm', target: 'beat/reward' }), call, controller.signal)
  assert.equal(result.status, 'cancelled')
  assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, 0)
  ctx.roleplayTestProvider.onRequest = undefined
  for (const mode of ['failure', 'tool'] as const) {
    ctx.roleplayTestProvider.mode = mode
    const failed = await ctx.roleplayRuntime.submit(id, command(mode, { kind: 'confirm', target: 'beat/reward' }), call)
    assert.equal(failed.status, 'failed')
    assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, 0)
  }
})

void test('restoring an unanswered persisted request records interruption without resending it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-roleplay-pending-'))
  const ctx = await load(root)
  context.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId('pending-story')
  const initial = await ctx.roleplayRuntime.create(id, replayInput())
  const cmd = command('pending', { kind: 'confirm', target: 'beat/reward' })
  const handle = await ctx.sessionPersistence.open(id, 'write')
  try {
    const stored = await handle.read()
    const session = ctx.sessions.prepare(id, { seed: [...stored.events], meta: handle.header })
    session.append('roleplay/requested', makeRequested(initial, cmd.id, cmd, call))
    await handle.append(session.snapshotEvents().slice(stored.events.length))
    await handle.flush()
  } finally { await handle.close() }
  assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, 0)
  const result = await ctx.roleplayRuntime.submit(id, cmd, call)
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'interrupted')
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
  assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, 0)
})


void test('same-session concurrent work is rejected and unload joins cancelled generation', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-roleplay-dispose-'))
  let ctx = await load(root)
  context.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId('dispose-story')
  await ctx.roleplayRuntime.create(id, replayInput())
  const entered = Promise.withResolvers<undefined>()
  ctx.roleplayTestProvider.mode = 'cancel'
  ctx.roleplayTestProvider.onRequest = () => { entered.resolve(undefined) }
  const task = ctx.roleplayRuntime.submit(id, command('wait', { kind: 'confirm', target: 'beat/reward' }), call)
  // Observe rejection immediately; persistence teardown may leave an interrupted request for recovery.
  const outcome = task.then(value => value, (error: unknown) => error)
  await entered.promise
  await assert.rejects(ctx.roleplayRuntime.submit(id, command('parallel', { kind: 'prepare' }), call), { code: 'roleplay_runtime.busy' })
  await ctx.fiber.dispose()
  await outcome
  assert.equal(ctx.get('roleplayRuntime'), undefined)
  ctx = await load(root)
  assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, 0)
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
})

void test('storage barrier failure is reconciled from the log without a second model request', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-roleplay-storage-'))
  const ctx = await load(root)
  context.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  for (const failBarrier of [1, 2]) {
    const id = SessionId(`barrier-${failBarrier}`)
    await ctx.roleplayRuntime.create(id, replayInput())
    const original = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    let flushes = 0
    const mocked = context.mock.method(ctx.sessionPersistence, 'open', async (...args: Parameters<typeof original>) => {
      const handle = await original(...args)
      if (args[1] !== 'write') return handle
      return {
        id: handle.id, header: handle.header, inheritedEventCount: handle.inheritedEventCount, access: handle.access,
        read: handle.read.bind(handle), append: handle.append.bind(handle),
        async flush() { if (++flushes === failBarrier) throw new Error('injected durability failure'); await handle.flush() },
        close: handle.close.bind(handle), [Symbol.asyncDispose]: handle[Symbol.asyncDispose].bind(handle),
      }
    })
    const beforeCalls = ctx.roleplayTestProvider.calls.length
    const cmd = command(`barrier-${failBarrier}`, { kind: 'confirm', target: 'beat/reward' })
    await assert.rejects(ctx.roleplayRuntime.submit(id, cmd, call), /injected durability failure/)
    mocked.mock.restore()
    // close() may finish a pending write: an error is not evidence of rollback.
    const recovered = await ctx.roleplayRuntime.submit(id, cmd, call)
    assert.equal(ctx.roleplayTestProvider.calls.length, beforeCalls + (failBarrier === 1 ? 0 : 1))
    assert.equal(recovered.status, failBarrier === 1 ? 'failed' : 'success')
    assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, failBarrier === 1 ? 0 : 1)
  }
})


void test('cancellation after header creation cannot strand a Session without its opening', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-roleplay-opening-'))
  const ctx = await load(root)
  context.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId('opening-story')
  const controller = new AbortController()
  const original = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  const mocked = context.mock.method(ctx.sessionPersistence, 'create', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args)
    controller.abort(new Error('cancelled after acquiring header'))
    return handle
  })
  const initial = await ctx.roleplayRuntime.create(id, replayInput(), controller.signal)
  mocked.mock.restore()
  assert.equal((await ctx.roleplayRuntime.inspect(id)).head, initial.head)
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
})


void test('declared event, output-reserve and stream limits reject without committing facts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-roleplay-limits-'))
  let ctx = await load(root, { ...config, max_event_bytes: 1 })
  context.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId('bounded-story')
  await assert.rejects(ctx.roleplayRuntime.create(id, replayInput()), { code: 'roleplay_runtime.event_over_budget' })
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
  await ctx.fiber.dispose()
  ctx = await load(root, { ...config, max_stream_bytes: 1 })
  await ctx.roleplayRuntime.create(id, replayInput())
  await assert.rejects(ctx.roleplayRuntime.submit(id, command('reserve', { kind: 'prepare' }), { ...call, maxTokens: 2000 }), { code: 'roleplay_runtime.output_reserve' })
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
  const result = await ctx.roleplayRuntime.submit(id, command('overflow', { kind: 'confirm', target: 'beat/reward' }), call)
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'stream_over_budget')
  assert.deepEqual(result.stream, [])
  assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, 0)
})
