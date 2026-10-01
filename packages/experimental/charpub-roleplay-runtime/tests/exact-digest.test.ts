/** Runtime records bind exact JSON strings; canonical author text remains a separate SDK contract. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { digestExactJSON } from '@char-pub/core'
import { createPreparationCatalog, digestAssemblyMessages, fixedSelection } from '@char-pub/assembler'
import { appendCommand, commandPreparation, createReplay, DecisionRecordSchema, makeDecisionRecord, replay } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { command, replayInput } from '../../charpub-roleplay/tests/fixtures.ts'
import { makeOpened, makeRequested, makeSettled, projectRoleplay } from '../src/projection.ts'

void test('message identity distinguishes Unicode normalization, line endings and trailing spaces', () => {
  for (const [left, right] of [['e\u0301', 'é'], ['a\r\nb', 'a\nb'], ['a  ', 'a']]) {
    assert.notEqual(digestAssemblyMessages([{ role: 'user', content: left ?? '', source: [] }]),
      digestAssemblyMessages([{ role: 'user', content: right ?? '', source: [] }]))
  }
})

void test('replay rejects a raw text edit even when the old author digest regards it as equal', () => {
  const log = appendCommand(createReplay(replayInput()), command('raw', { kind: 'input', text: 'e\u0301' }))
  const changed = structuredClone(log)
  const entry = changed.entries[0]
  assert.ok(entry)
  entry.command.operation = { kind: 'input', text: 'é' }
  assert.throws(() => replay(changed), { code: 'roleplay.replay_mismatch' })
  assert.equal(replay(log).current.turn.history.at(-1)?.text, 'e\u0301')
})

void test('a reused command ID with different raw text is a conflict', () => {
  const log = appendCommand(createReplay(replayInput()), command('raw', { kind: 'input', text: 'e\u0301' }))
  assert.throws(() => appendCommand(log, command('raw', { kind: 'input', text: 'é' })), { code: 'roleplay.command_conflict' })
})

void test('decision receipts reject edits to exact provider request and response strings', () => {
  const build = createPreparationCatalog(commandPreparation(createReplay(replayInput()), command('select', { kind: 'prepare' })))
  const plan = fixedSelection(build, [])
  const record = makeDecisionRecord({ provider: { name: 'typesafe/jev', version: '1' }, purpose: 'selector', config: { model: 'fixed' },
    input: plan.input, request: [{ state: 'e\u0301' }], response: [{ text: 'a\r\nb' }], binding: { plan_digest: digestExactJSON(plan) } })
  assert.equal(DecisionRecordSchema.safeParse({ ...record, request: [{ state: 'é' }] }).success, false)
  assert.equal(DecisionRecordSchema.safeParse({ ...record, response: [{ text: 'a\nb' }] }).success, false)
})

void test('Session request projection rejects changed retained message bytes', () => {
  const events: SessionEvent[] = [{ type: 'roleplay/opened', seq: SessionSeq(0), time: 0, data: makeOpened(replayInput()) }]
  const request = makeRequested(projectRoleplay(events), 'raw-request', command('request', { kind: 'input', text: 'e\u0301' }), { provider: 'fixed', model: 'fixed', maxTokens: 128 })
  const changed = structuredClone(request)
  const message = changed.messages.at(-1)
  assert.ok(message)
  message.content += '  '
  assert.throws(() => projectRoleplay([...events, { type: 'roleplay/requested', seq: SessionSeq(1), time: 1, data: changed }]), { code: 'roleplay.event_mismatch' })
})

void test('the initial receipt detects changed unused Source bytes before any materialization', () => {
  const log = createReplay(replayInput())
  const changed = structuredClone(log)
  const asset = Object.keys(changed.input.source_texts)[0]
  assert.ok(asset)
  changed.input.source_texts[asset] = `${changed.input.source_texts[asset] ?? ''}  `
  assert.throws(() => replay(changed), { code: 'roleplay.replay_mismatch' })
})


void test('rejects the preserved old raw-text Replay without rewriting its byte receipt', async () => {
  const path = new URL('./fixtures/pre-exact-digest-replay.json', import.meta.url)
  const before = await readFile(path)
  assert.equal(createHash('sha256').update(before).digest('hex'), '69473c0cd5eb1b32ae4db05ea9609030b035fe676dc84e9895cb511ac1113029')
  assert.throws(() => replay(JSON.parse(before.toString('utf8'))), { code: 'roleplay.replay_mismatch' })
  assert.deepEqual(await readFile(path), before)
})

void test('successful Session settlement preserves exact assistant history and rejects a normalized stored turn', () => {
  const events: SessionEvent[] = [{ type: 'roleplay/opened', seq: SessionSeq(0), time: 0, data: makeOpened(replayInput()) }]
  const request = makeRequested(projectRoleplay(events), 'response', command('response', { kind: 'prepare' }),
    { provider: 'fixed', model: 'fixed', maxTokens: 128 })
  events.push({ type: 'roleplay/requested', seq: SessionSeq(1), time: 1, data: request })
  const text = 'e\u0301\r\nAssistant trailing spaces  '
  const settlement = makeSettled(projectRoleplay(events), {
    status: 'success', assistant: { text }, stream: [
      { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: [text] },
      { type: 'chunk', time: 3, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ],
  })
  assert.equal(settlement.status, 'success')
  const settledEvent: SessionEvent = { type: 'roleplay/settled', seq: SessionSeq(2), time: 2, data: settlement }
  assert.equal(projectRoleplay([...events, settledEvent]).current.turn.history.at(-1)?.text, text)
  const changed = structuredClone(settlement)
  assert.equal(changed.status, 'success')
  if (changed.status !== 'success') throw new Error('Expected success')
  const message = changed.turn.history.at(-1)
  assert.ok(message)
  message.text = text.normalize('NFC').replaceAll('\r\n', '\n').trimEnd()
  assert.throws(() => projectRoleplay([...events, { ...settledEvent, data: changed }]), { code: 'roleplay.event_mismatch' })
})
