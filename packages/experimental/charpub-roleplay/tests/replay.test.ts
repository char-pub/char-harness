/** Node test runner, launched with tsx/esm; all char.pub imports resolve packed dist exports. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { digestOf } from '@char-pub/core'
import { digestAssemblyMessages, createPreparationCatalog, fixedSelection, selectorCatalog, selectorView, prepareContext } from '@char-pub/assembler'
import { appendCommand, createReplay, replay, commandPreparation, makeDecisionRecord } from '../src/index.ts'
import { replayInput as input, command, SOURCE } from './fixtures.ts'

await test('imports char.pub from packed dist exports, without cross-repository source aliases', () => {
  for (const name of ['@char-pub/core', '@char-pub/assembler']) {
    const resolved = import.meta.resolve(name)
    assert.match(resolved, /\/dist\/index\.js$/)
    assert.doesNotMatch(resolved, /\/char_pub\//)
  }
})

await test('initializes the profile locale and keeps the opening once in model history', () => {
  const log = createReplay(input())
  const result = replay(log)
  assert.equal(result.current.turn.locale, 'ja')
  assert.equal(result.current.turn.history.length, 1)
  assert.equal(result.current.turn.history[0]?.text, 'ようこそ、Guest。')
  const next = appendCommand(log, command('walk', { kind: 'input', text: 'I climb out through the window.' }))
  assert.equal(replay(next).current.turn.history.length, 2)
  assert.equal(replay(next).current.state.scene, 'lobby')
  assert.deepEqual(replay(next).current.state.reached, [])
})

await test('unknown judgment cannot confirm the negated branch; an explicit false judgment can', () => {
  const log = createReplay(input())
  assert.throws(() => appendCommand(log, command('unknown', { kind: 'confirm', target: 'beat/refusal' })), { code: 'story.condition_unsatisfied' })
  assert.equal(log.entries.length, 0)
  assert.equal(replay(log).current.state.vars.count, 0)
  const next = appendCommand(log, command('known', { kind: 'confirm', target: 'beat/refusal' }, {
    judgments: [{ target: 'beat/refusal', path: '/when/not', result: 'false', provider: { name: 'fixed', version: '1' } }],
  }))
  assert.deepEqual(replay(next).current.state.reached, ['refusal'])
})

await test('exact command retries do not reapply effects and changed reuse fails before committing', () => {
  const log = createReplay(input())
  const reward = command('reward', { kind: 'confirm', target: 'beat/reward' })
  const next = appendCommand(log, reward)
  assert.equal(replay(next).current.state.vars.count, 1)
  assert.equal(appendCommand(next, reward), next)
  assert.equal(next.entries.length, 1)
  assert.throws(() => appendCommand(next, command('reward', { kind: 'set-present', present: ['alice'] })), { code: 'roleplay.command_conflict' })
  assert.equal(replay(next).current.state.vars.count, 1)
})

await test('cancellation returns no appended event or state change', () => {
  const log = createReplay(input())
  const before = JSON.stringify(log)
  const controller = new AbortController()
  controller.abort(new Error('cancel exercise'))
  assert.throws(() => appendCommand(log, command('cancel', { kind: 'confirm', target: 'beat/reward' }), { signal: controller.signal }), /cancel exercise/)
  assert.equal(JSON.stringify(log), before)
})

await test('replays presence, scene, Plan and actual messages from serialized exercise data', () => {
  const start = createReplay(input())
  const artifact = start.input.artifact
  if (artifact.kind !== 'content') throw new Error('expected content')
  const source = artifact.catalog_index.sources[0]
  if (!source) throw new Error('expected source')
  const moved = appendCommand(start, command('move', { kind: 'enter-scene', scene: 'garden' }))
  assert.deepEqual(replay(moved).current.state.present, ['alice'])
  const alone = appendCommand(moved, command('alone', { kind: 'set-present', present: [] }))
  const selected = appendCommand(alone, command('read', { kind: 'prepare' }, { selection: [{ source: source.id }] }))
  const result = replay(JSON.parse(JSON.stringify(selected)))
  assert.deepEqual(result.current.state.present, [])
  assert.equal(result.current.state.scene, 'garden')
  assert.ok(result.current.assembly.messages.some(message => message.content.includes(SOURCE)))
  assert.deepEqual(result.current.plan, selected.entries.at(-1)?.plan)
  assert.equal(result.current.assembly.trace.selection?.plan_digest, digestOf(result.current.plan))
  assert.equal(digestAssemblyMessages(result.current.assembly.messages), selected.entries.at(-1)?.messages_digest)
  assert.deepEqual(result, replay(selected))
})

await test('participant views require explicit input and keep secret knowledge isolated', () => {
  const value = input('per-agent')
  const log = createReplay(value)
  assert.ok(replay(log).current.assembly.messages.some(message => message.content.includes('ALICE_ONLY_SECRET')))
  const bob = appendCommand(log, command('bob-view', { kind: 'prepare' }, { for_participant: 'bob' }))
  assert.ok(replay(bob).current.assembly.messages.every(message => !message.content.includes('ALICE_ONLY_SECRET')))
  assert.throws(() => appendCommand(bob, command('missing-view', { kind: 'prepare' })))
  const { for_participant: _view, ...missing } = value
  assert.throws(() => createReplay(missing))
})

await test('detects edits to input, operation, state, Plan, messages digest and log truncation', () => {
  const log = appendCommand(createReplay(input()), command('reward', { kind: 'confirm', target: 'beat/reward' }))
  const edits: ((value: typeof log) => void)[] = [
    (value) => { value.input.bindings.user = { kind: 'persona', display_name: 'Changed' } },
    (value) => { const first = value.entries[0]; if (first) first.command.operation = { kind: 'prepare' } },
    (value) => { const first = value.entries[0]; if (first) first.state_digest = 'changed' },
    (value) => { const first = value.entries[0]; if (first) first.plan.selector.version = 'changed' },
    (value) => { const first = value.entries[0]; if (first) first.messages_digest = 'changed' },
    (value) => { value.entries = [] },
  ]
  for (const edit of edits) {
    const changed = structuredClone(log)
    edit(changed)
    assert.throws(() => replay(changed), { code: 'roleplay.replay_mismatch' })
  }
})

await test('unknown required capability refuses the exercise and explicit degradation remains visible', () => {
  const value = input()
  value.artifact.capabilities.push({ id: 'unknown.future' })
  assert.throws(() => createReplay(value), { code: 'roleplay.unsupported_capabilities' })
  value.support.degraded = [{ id: 'unknown.future', reason: 'Fixed exercise does not execute this feature' }]
  assert.equal(replay(createReplay(value)).support.status, 'degraded')
})

await test('preserves a provider Plan and complete sanitized evidence during offline replay', () => {
  const log = createReplay(input())
  const draft = command('provider-selection', { kind: 'prepare' })
  const preparation = commandPreparation(log, draft)
  const build = createPreparationCatalog(preparation)
  const artifact = log.input.artifact
  if (artifact.kind !== 'content') throw new Error('content required')
  const source = artifact.catalog_index.sources[0]
  if (!source) throw new Error('source required')
  const config = { model: 'jev-test', threshold: 0.7, request_budget: 5000 }
  const plan = fixedSelection(build, [{ source: source.id }])
  plan.selector = { name: 'typesafe/jev', version: '1', config_digest: digestOf(config) }
  plan.decisions = plan.decisions.map(decision => ({ ...decision, score: 0.9, confidence: 0.9 }))
  const evidence = makeDecisionRecord({
    purpose: 'selector', provider: { name: 'typesafe/jev', version: '1' }, config, input: build.input,
    request: [{ model: 'jev-test', state: { catalog: selectorCatalog(build.catalog), view: selectorView(build.context) }, questions: ['select source at index 0'] }],
    response: [{ status: 'ok', model: 'jev-test-resolved', answers: [{ probability: 0.9 }], request_id: 'evidence-not-model-text' }],
    binding: { plan_digest: digestOf(plan) },
  })
  const { selection: _fixed, ...withoutFixed } = draft
  const selected = { ...withoutFixed, plan, evidence: [evidence] }
  assert.throws(() => appendCommand(log, { ...withoutFixed, plan }), { code: 'roleplay.evidence_required' })
  const next = appendCommand(log, selected)
  const result = replay(JSON.parse(JSON.stringify(next)))
  assert.deepEqual(result.current.plan, plan)
  assert.equal(result.current.assembly.trace.selection?.selector.name, 'typesafe/jev')
  assert.ok(result.current.assembly.messages.some(message => message.content.includes(SOURCE)))
  assert.ok(result.current.assembly.messages.every(message => !message.content.includes('evidence-not-model-text')))
  assert.deepEqual(next.entries[0]?.command.evidence, [evidence])
  assert.throws(() => appendCommand(log, { ...selected, selection: [] }), /Use selection refs or a complete Plan/)
  const changed = structuredClone(selected)
  const record = changed.evidence[0]
  if (!record) throw new Error('record required')
  record.response = [{ status: 'ok', probability: 0.1 }]
  assert.throws(() => appendCommand(log, changed), /Decision evidence digest mismatch/)
  const { digest: _digest, ...payload } = evidence
  const wrongConfig = makeDecisionRecord({ ...payload, config: { ...config, threshold: 0.8 } })
  assert.throws(() => appendCommand(log, { ...selected, evidence: [wrongConfig] }), { code: 'roleplay.evidence_mismatch' })
  const wrongInput = makeDecisionRecord({ ...payload, input: { ...payload.input, turn_digest: `sha256:${'0'.repeat(64)}` } })
  assert.throws(() => appendCommand(log, { ...selected, evidence: [wrongInput] }), { code: 'roleplay.evidence_mismatch' })
})

await test('binds judgment evidence to the command-before view and supplied results', () => {
  const log = createReplay(input())
  const draft = command('judge', { kind: 'confirm', target: 'beat/refusal' })
  const before = createPreparationCatalog(commandPreparation(log, draft, 'before'), false)
  const judgments = [{ target: 'beat/refusal', path: '/when/not', result: 'false' as const, provider: { name: 'typesafe/jev', version: '1' } }]
  const evidence = makeDecisionRecord({
    purpose: 'judge', provider: { name: 'typesafe/jev', version: '1' }, config: { model: 'jev-test', true_threshold: 0.8, false_threshold: 0.2 },
    input: before.input,
    request: [{ model: 'jev-test', state: selectorView(before.context), questions: ['Did the guest agree?'] }],
    response: [{ status: 'ok', model: 'jev-test-resolved', probability: 0.1 }], binding: { judgments },
  })
  assert.throws(() => appendCommand(log, { ...draft, judgments }), { code: 'roleplay.evidence_required' })
  assert.throws(() => createReplay({ ...input(), judgments }), { code: 'roleplay.initial_judgment_evidence_unavailable' })
  const next = appendCommand(log, { ...draft, judgments, evidence: [evidence] })
  assert.deepEqual(replay(next).current.state.reached, ['refusal'])
  assert.equal(replay(next).current.state.vars.count, 1)
  assert.notEqual(before.input.turn_digest, next.entries[0]?.plan.input.turn_digest)
  if (evidence.purpose !== 'judge' || !judgments[0]) throw new Error('judge evidence required')
  const { digest: _digest, ...payload } = evidence
  const mismatch = makeDecisionRecord({ ...payload, binding: { judgments: [{ ...judgments[0], path: '/when' }] } })
  assert.throws(() => appendCommand(log, { ...draft, judgments, evidence: [mismatch] }), { code: 'roleplay.evidence_mismatch' })
})

await test('rejects transport or credential fields without pretending to scrub user text', () => {
  const log = createReplay(input())
  const draft = command('safe', { kind: 'prepare' })
  const build = createPreparationCatalog(commandPreparation(log, draft))
  const plan = fixedSelection(build, [])
  const payload = {
    purpose: 'selector' as const, provider: { name: 'typesafe/jev', version: '1' }, config: { model: 'jev-test' },
    input: build.input, request: { state: 'User text may contain a URL or the word password.' }, response: [],
    binding: { plan_digest: digestOf(plan) },
  }
  assert.ok(makeDecisionRecord(payload).digest)
  for (const key of ['headers', 'authorization', 'apiKey', 'baseURL', 'access_token']) {
    assert.throws(() => makeDecisionRecord({ ...payload, request: { nested: { [key]: 'never-record' } } }), /Transport or credential/)
  }
})

await test('records an assistant response without spending the next input budget or pretending the old Plan is current', () => {
  const log = createReplay(input())
  const before = replay(log).current
  const next = appendCommand(log, command('reply', { kind: 'response', text: 'A very long reply. '.repeat(4000) }))
  const current = replay(next).current
  assert.equal(current.turn.history.length, before.turn.history.length + 1)
  assert.deepEqual(current.prepared_turn, before.prepared_turn)
  assert.deepEqual(current.plan, before.plan)
  assert.notEqual(digestOf(current.turn), digestOf(current.prepared_turn))
  assert.throws(() => prepareContext({ artifact: log.input.artifact, profile: log.input.profile, turn: current.turn, plan: current.plan }), { code: 'selection.input_mismatch' })
  const preparation = commandPreparation(next, command('next', { kind: 'prepare' }))
  assert.equal(preparation.turn.history?.length, current.turn.history.length)
  const fresh = createPreparationCatalog(preparation, false)
  assert.notEqual(fresh.input.turn_digest, current.plan.input.turn_digest)
})

for (const origin of ['local', 'draft'] as const) await test(`replays ${origin} inputs without treating their sources as published Releases`, () => {
  const value = input('narrator', { origin })
  const log = createReplay(value)
  if (value.artifact.kind !== 'content') throw new Error('content required')
  const source = value.artifact.catalog_index.sources[0]
  if (!source) throw new Error('source required')
  const next = appendCommand(log, command(`${origin}-source`, { kind: 'prepare' }, {
    selection: [{ source: source.id }],
  }))
  const result = replay(JSON.parse(JSON.stringify(next)))
  assert.equal('release' in result.current.assembly.trace.ir, false)
  assert.ok('origin' in result.current.assembly.trace.ir)
  assert.ok('origin' in value.artifact.root)
  assert.deepEqual(result.current.assembly.trace.ir.origin, value.artifact.root.origin)
  assert.equal(result.current.assembly.trace.ir.semantic_digest, value.artifact.root.semantic_digest)
  assert.ok(result.current.assembly.messages.some(message => typeof message.content === 'string' && message.content.includes(SOURCE)))
  assert.ok(value.artifact.lock.every(pin => 'release' in pin && !('origin' in pin)))
  const tampered = structuredClone(next)
  tampered.input.source_texts[source.asset] = `${SOURCE} changed`
  assert.throws(() => replay(tampered), { code: 'roleplay.replay_mismatch' })
  const badSource = createReplay(tampered.input)
  assert.throws(() => appendCommand(badSource, command(`${origin}-bad-source`, { kind: 'prepare' }, {
    selection: [{ source: source.id }],
  })), { code: 'source.asset_mismatch' })
})
