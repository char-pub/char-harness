/** Explicit synthetic handoff tests; full Session records remain private and unchanged. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RUNTIME_PREVIEW_BYTES, RuntimePreviewInputSchema, digestExactJSON } from '@char-pub/core'
import { validateRuntimePreviewInput } from '@char-pub/assembler'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createRuntimePreviewExports } from '../src/preview-export.ts'
import { makeOpened, makeRequested, projectRoleplay } from '../src/projection.ts'
import { command, replayInput, SOURCE } from '../../charpub-roleplay/tests/fixtures.ts'
import { historyLoader } from './fixtures/history-loader.ts'

const session = SessionId('preview-export')
function fixture(origin?: 'local' | 'draft', mode: 'narrator' | 'per-agent' = 'narrator') {
  const input = replayInput(mode, origin ? { origin } : {})
  let current = projectRoleplay([{ type: 'roleplay/opened', seq: SessionSeq(0), time: 0, data: makeOpened(input) }])
  let inspections = 0
  const services = { inspect: async () => { inspections++; return current } }
  const exports = createRuntimePreviewExports(services)
  const bindings = Object.fromEntries(Object.entries(input.bindings).map(([key, value]) =>
    [key, { kind: value.kind, display_name: 'Synthetic person' }]))
  const intent = { session, history: [{ role: 'user' as const, text: 'A synthetic summary, not the chat. e\u0301\r\n  ' }], bindings }
  return { input, current: () => current, services, exports, intent, inspections: () => inspections,
    replace: (value: typeof current) => { current = value } }
}

for (const origin of [undefined, 'local', 'draft'] as const) {
  void test(`exports the real ${origin ?? 'release'} source identity with only explicit synthetic messages and bindings`, async () => {
    const h = fixture(origin)
    const review = await h.exports.prepare(h.intent)
    assert.deepEqual(review.payload.source.root, h.input.artifact.root)
    assert.equal(review.payload.source.artifact_json_digest, digestExactJSON(h.input.artifact))
    assert.equal(review.payload.turn.locale, 'ja')
    assert.equal(review.payload.profile.locale, 'ja')
    assert.deepEqual(review.payload.turn.history, h.intent.history)
    assert.deepEqual(review.payload.turn.bindings, h.intent.bindings)
    assert.equal(review.payload.turn.history.some(message => message.text.includes('ようこそ')), false)
    const result = await h.exports.export(review, { candidate_digest: review.digest })
    assert.deepEqual(RuntimePreviewInputSchema.parse(JSON.parse(result.json)), result.payload)
    assert.deepEqual(validateRuntimePreviewInput(h.input.artifact, result.payload), result.payload)
    assert.equal((await h.exports.export(review, { candidate_digest: review.digest })).json, result.json)
    assert.equal(result.json.includes(SOURCE), false)
    assert.equal(result.json.includes('head'), false)
    assert.equal(result.json.includes('source_texts'), false)
    assert.equal(result.json.includes('candidate_digest'), false)
    assert.ok(Buffer.byteLength(result.json) <= MAX_RUNTIME_PREVIEW_BYTES)
  })
}

void test('requires an explicit per-agent viewpoint and validates synthetic speakers and role bindings', async () => {
  const h = fixture(undefined, 'per-agent')
  await assert.rejects(h.exports.prepare(h.intent), /view_required/)
  const review = await h.exports.prepare({ ...h.intent, for_participant: 'alice' })
  assert.equal(review.payload.turn.for_participant, 'alice')
  await assert.rejects(h.exports.prepare({ ...h.intent, for_participant: 'not-a-role' }))
  await assert.rejects(h.exports.prepare({ ...h.intent, for_participant: 'alice', bindings: {} }))
  await assert.rejects(h.exports.prepare({ ...h.intent, for_participant: 'alice',
    history: [{ role: 'assistant', text: 'Summary', speaker: 'Alice' }],
  }))
})

void test('rejects copied, modified, stale and oversized reviews and performs no inspection when already cancelled', async () => {
  const h = fixture()
  const abort = new AbortController(); abort.abort()
  await assert.rejects(h.exports.prepare(h.intent, abort.signal), /cancelled/)
  assert.equal(h.inspections(), 0)
  const review = await h.exports.prepare(h.intent)
  const confirmation = { candidate_digest: review.digest }
  await assert.rejects(h.exports.export(structuredClone(review), confirmation), /unknown_review/)
  await assert.rejects(h.exports.export(review, { candidate_digest: 'not-reviewed' }), /confirmation_mismatch/)
  const text = review.payload.turn.history[0]
  assert.ok(text)
  text.text = text.text.normalize('NFC')
  await assert.rejects(h.exports.export(review, confirmation), /review_changed/)
  text.text = h.intent.history[0]?.text ?? ''
  const count = h.inspections()
  await assert.rejects(h.exports.export(review, confirmation, abort.signal), /cancelled/)
  assert.equal(h.inspections(), count)
  h.replace({ ...h.current(), head: `sha256:${'a'.repeat(64)}` })
  await assert.rejects(h.exports.export(review, confirmation), /session_changed/)
  await assert.rejects(h.exports.prepare({ ...h.intent, history: [{ role: 'user', text: 'x'.repeat(MAX_RUNTIME_PREVIEW_BYTES) }] }))
})

void test('pending requests and expired Registry build sources cannot be exported', async () => {
  const h = fixture('draft')
  const current = h.current()
  h.replace({ ...current,
    pending: makeRequested(current, 'pending', command('pending', { kind: 'prepare' }), { provider: 'fixed', model: 'fixed' }),
  })
  await assert.rejects(h.exports.prepare(h.intent), /request_pending/)
  const expired = structuredClone(current)
  const artifact = expired.log.input.artifact
  assert.ok('origin' in artifact.root && artifact.root.origin.kind === 'draft-build')
  artifact.root.origin.expires_at = '2020-01-01T00:00:00Z'
  h.replace(expired)
  await assert.rejects(h.exports.prepare(h.intent), /source_expired/)
})

void test('exports the committed state after a real reply without copying private chat, loaded documents or changing JSONL bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'preview-export-'))
  const ctx = await historyLoader(root)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const h = fixture()
  await ctx.roleplayRuntime.create(session, h.input)
  assert.ok(h.input.artifact.kind === 'content')
  const source = h.input.artifact.catalog_index.sources[0]
  assert.ok(source)
  await ctx.roleplayRuntime.submit(session,
    command('chat', { kind: 'input', text: 'PRIVATE_CHAT_SHOULD_STAY_LOCAL' }, { selection: [{ source: source.id }] }),
    { provider: 'roleplay-test', model: 'fixed', maxTokens: 128 })
  assert.ok(JSON.stringify(ctx.roleplayTestProvider.calls[0]?.messages).includes(SOURCE))
  const files = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'))
  assert.ok(files.length)
  const original = await Promise.all(files.map(path => readFile(join(root, 'sessions', path))))
  const exporter = createRuntimePreviewExports({ inspect: id => ctx.roleplayRuntime.inspect(id) })
  const review = await exporter.prepare(h.intent)
  const result = await exporter.export(review, { candidate_digest: review.digest })
  assert.equal(result.json.includes('PRIVATE_CHAT_SHOULD_STAY_LOCAL'), false)
  assert.equal(result.json.includes(SOURCE), false)
  assert.equal(result.json.includes('The innkeeper nods.'), false)
  assert.deepEqual(result.payload.turn.history, h.intent.history)
  assert.deepEqual(await Promise.all(files.map(path => readFile(join(root, 'sessions', path)))), original)
  await ctx.roleplayRuntime.submit(session, command('later', { kind: 'input', text: 'More private dialogue' }),
    { provider: 'roleplay-test', model: 'fixed', maxTokens: 128 })
  await assert.rejects(exporter.export(review, { candidate_digest: review.digest }), /session_changed/)
})
