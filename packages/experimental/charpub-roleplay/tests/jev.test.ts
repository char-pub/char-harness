/** Official TypeSafe SDK with a local Fetch replacement; no model requests leave this process. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { digestOf } from '@char-pub/core'
import { createPreparationCatalog, prepareContext, selectorCatalog, validateSelectionPlan } from '@char-pub/assembler'
import type { Fetch } from '@typesafe-ai/sdk'
import { z } from 'zod'
import { createJevDecisions, type JevConfig } from '../src/jev.ts'
import { appendCommand, commandPreparation, createReplay, replay } from '../src/index.ts'
import { command, replayInput, SOURCE } from './fixtures.ts'

const config: JevConfig = {
  model: 'jev-test-pinned', timeout_ms: 5000, request_budget: 100_000, max_requests: 10,
  select_threshold: 0.7, expand_threshold: 0.7, true_threshold: 0.9, false_threshold: 0.1,
}
function setup(fetch: Fetch, overrides: Partial<JevConfig> = {}) {
  return createJevDecisions({ ...config, ...overrides }, { apiKey: 'test-only-key', baseURL: 'https://jev.invalid', fetch })
}
const RequestSchema = z.object({
  model: z.string(),
  state: z.object({
    context: z.record(z.string(), z.unknown()),
    directory: z.unknown().optional(),
    expansion: z.object({ parent: z.unknown(), children: z.array(z.record(z.string(), z.unknown())) }).optional(),
  }),
  questions: z.record(z.string(), z.object({ type: z.string(), instructions: z.unknown() })),
})
function bodyText(init?: RequestInit): string {
  const value = init?.body
  if (typeof value !== 'string') throw new Error('Expected a JSON request body')
  return value
}
function body(init?: RequestInit) {
  return RequestSchema.parse(JSON.parse(bodyText(init)))
}
function answer(init: RequestInit | undefined, probability = 0.95) {
  const request = body(init)
  assert.equal(request.model, config.model)
  assert.ok(Object.values(request.questions).every(question => question.type === 'noul'))
  return Response.json({ model: 'jev-resolved-test', answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: probability }])), usage: { input_tokens: 100, output_tokens: 10 } })
}
function prepared(catalog = false) {
  const log = createReplay(replayInput('per-agent', { catalog }))
  const cmd = command('choose', { kind: 'prepare' }, { for_participant: 'bob' })
  return { log, cmd, input: commandPreparation(log, cmd) }
}
const tasks = [{ target: 'beat/refusal', path: '/when/not' }]
const neverFetch: Fetch = async () => { throw new Error('Unexpected network operation') }

void test('requires explicit probability policy and rejects transport credentials in URLs', () => {
  assert.throws(() => setup(neverFetch, { false_threshold: 0.9, true_threshold: 0.9 }))
  assert.throws(() => createJevDecisions(config, { apiKey: 'key', baseURL: 'https://user:secret@jev.invalid' }))
  assert.throws(() => createJevDecisions(config, { apiKey: 'key', baseURL: 'https://jev.invalid?key=secret' }))
})

void test('progressive multi-selection transmits descriptions once, never trusted state or bodies', async (context) => {
  const { log, cmd, input } = prepared(true)
  input.turn.focus = 'Find shelter and a route through the inn'
  input.turn.overlay = { memory: ['PRIVATE_OVERLAY'] }
  const sent: string[] = []
  const adapter = setup(async (url, init) => {
    assert.equal(url, 'https://jev.invalid/v1/systemone')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only-key')
    sent.push(bodyText(init))
    return answer(init)
  })
  const { plan, record } = await adapter.selectContext(input)
  assert.ok(sent.length >= 3)
  context.assert.snapshot(sent.map(value => RequestSchema.parse(JSON.parse(value))))
  assert.ok(plan.selected.length >= 3)
  assert.ok(plan.decisions.some(item => item.action === 'expand' && item.score === 0.95))
  assert.ok(plan.decisions.every(item => item.confidence === undefined))
  for (const serialized of sent) {
    const state = RequestSchema.parse(JSON.parse(serialized)).state
    assert.deepEqual(Object.keys(state.context).sort(), ['focus', 'history', 'scene', 'view'])
    assert.ok(!serialized.includes(SOURCE))
    for (const text of ['ALICE_ONLY_SECRET', 'PRIVATE_OVERLAY', 'vars', 'knowing', 'bindings', 'judgments', 'source_texts', 'CANDIDATE_BODY']) assert.ok(!serialized.includes(text), text)
  }
  assert.ok(RequestSchema.parse(JSON.parse(sent[0] ?? '{}')).state.directory)
  for (const next of sent.slice(1)) {
    const state = RequestSchema.parse(JSON.parse(next)).state
    assert.deepEqual(Object.keys(state).sort(), ['context', 'expansion'])
    assert.ok(state.expansion?.children.every((child: Record<string, unknown>) => child.children === undefined))
  }
  assert.ok(!JSON.stringify(record).includes('test-only-key'))
  assert.ok(JSON.stringify(record).includes('jev-resolved-test'))
  const build = createPreparationCatalog(input)
  assert.deepEqual(validateSelectionPlan(build, plan), plan)
  const assembly = prepareContext({ ...input, plan, source_texts: log.input.source_texts })
  assert.ok(assembly.messages.some(item => item.content.includes(SOURCE)))
  assert.equal(assembly.trace.selection?.plan_digest, digestOf(plan))
  // Restore the non-mutated command input before using another decision in the offline log.
  const plain = await adapter.selectContext(commandPreparation(log, cmd))
  const { selection: _fixed, ...withPlan } = cmd
  const next = appendCommand(log, { ...withPlan, plan: plain.plan, evidence: [plain.record] })
  assert.deepEqual(replay(JSON.parse(JSON.stringify(next))).current.plan, plain.plan)
})

void test('low relevance permits empty selection without claiming provider failure', async () => {
  const { input } = prepared(true)
  let calls = 0
  const result = await setup(async (_url, init) => { calls++; return answer(init, 0.2) }).selectContext(input)
  assert.equal(calls, 1)
  assert.deepEqual(result.plan.selected, [])
  assert.equal(result.plan.fallback, undefined)
})

void test('initial directory overflow skips without any request and preserves required/direct preparation', async () => {
  const { input, log } = prepared()
  input.selection = { catalog_budget: 0, max_depth: 4 }
  const result = await setup(neverFetch).selectContext(input)
  assert.equal(result.plan.discovery, false)
  assert.equal(result.plan.fallback, 'skip')
  assert.deepEqual(result.record.request, [])
  assert.ok(prepareContext({ ...input, plan: result.plan, source_texts: log.input.source_texts }).messages.length > 0)
})

void test('expansion is rejected before exposing descriptions beyond the catalog budget', async () => {
  const { input } = prepared(true)
  const original = createPreparationCatalog(input)
  input.selection = { catalog_budget: original.counter.count(JSON.stringify(selectorCatalog(original.catalog))), max_depth: 4 }
  let calls = 0
  const result = await setup(async (_url, init) => { calls++; return answer(init) }).selectContext(input)
  assert.equal(calls, 1)
  assert.ok(result.plan.decisions.some(item => item.note === 'selection.directory_over_budget'))
  assert.ok(!result.plan.decisions.some(item => item.action === 'expand'))
})

void test('provider failure after expansion clears chosen leaves and records the exposed directory', async () => {
  const { input } = prepared(true)
  let calls = 0
  const result = await setup(async (_url, init) => ++calls === 1 ? answer(init) : new Response('unavailable', { status: 503 })).selectContext(input)
  assert.equal(calls, 2)
  assert.equal(result.plan.discovery, true)
  assert.equal(result.plan.fallback, 'skip')
  assert.deepEqual(result.plan.selected, [])
  assert.ok(result.plan.decisions.some(item => item.action === 'expand'))
  assert.match(JSON.stringify(result.record.response), /unavailable/)
  assert.deepEqual(validateSelectionPlan(createPreparationCatalog(input), result.plan), result.plan)
})

void test('missing, extra, mistyped and out-of-range wire answers fail closed', async () => {
  const { input } = prepared()
  for (const answers of [{}, { q0: { type: 'noul', noul: 2 } }, { q0: { type: 'choice', choice: 'yes' } }, { q0: { type: 'noul', noul: 0.9 }, injected: { type: 'noul', noul: 1 } }]) {
    const result = await setup(async () => Response.json({ model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } })).selectContext(input)
    assert.equal(result.plan.fallback, 'skip')
    assert.deepEqual(result.plan.selected, [])
    assert.match(JSON.stringify(result.record.response), /invalid-response/)
  }
})

void test('total request and call limits include history, questions and repeated view data', async () => {
  const { input } = prepared(true)
  const budget = await setup(neverFetch, { request_budget: 1 }).selectContext(input)
  assert.equal(budget.plan.fallback, 'skip')
  assert.deepEqual(budget.record.request, [])
  let calls = 0
  const limited = await setup(async (_url, init) => { calls++; return answer(init) }, { max_requests: 1 }).selectContext(input)
  assert.equal(calls, 1)
  assert.equal(limited.plan.fallback, 'skip')
  assert.match(JSON.stringify(limited.record.response), /request-limit/)
})

void test('judge probability maps to true, false or undetermined, without changing Story state', async () => {
  const log = createReplay(replayInput())
  const cmd = command('refuse', { kind: 'confirm', target: 'beat/refusal' })
  const input = commandPreparation(log, cmd, 'before')
  for (const [probability, expected] of [[0.95, 'true'], [0.05, 'false'], [0.5, 'undetermined']] as const) {
    const result = await setup(async (_url, init) => answer(init, probability)).judgeStory(input, tasks)
    assert.equal(result.judgments[0]?.result, expected)
    assert.equal(replay(log).current.state.vars.count, 0)
    if (expected === 'false') {
      const next = appendCommand(log, { ...cmd, judgments: result.judgments, evidence: [result.record] })
      assert.deepEqual(replay(next).current.state.reached, ['refusal'])
    }
    if (expected === 'undetermined') assert.throws(() => appendCommand(log, { ...cmd, judgments: result.judgments, evidence: [result.record] }), { code: 'story.condition_unsatisfied' })
  }
  const unavailable = await setup(async () => new Response('no key', { status: 401 })).judgeStory(input, tasks)
  assert.equal(unavailable.judgments[0]?.result, 'undetermined')
})

void test('rejects absent, non-judge and duplicate requested leaves before HTTP', async () => {
  const { input } = prepared()
  const adapter = setup(neverFetch)
  await assert.rejects(adapter.judgeStory(input, []), { code: 'jev.empty_judgments' })
  await assert.rejects(adapter.judgeStory(input, [{ target: 'beat/missing', path: '/when' }]), { code: 'jev.invalid_judge' })
  await assert.rejects(adapter.judgeStory(input, [{ target: 'beat/refusal', path: '/when' }]), { code: 'jev.invalid_judge' })
  await assert.rejects(adapter.judgeStory(input, [...tasks, ...tasks]), { code: 'jev.duplicate_judge' })
})

const pendingFetch: Fetch = (_url, init) => new Promise((_resolve, reject) => {
  const signal = init?.signal
  if (signal?.aborted) reject(new Error('fetch aborted', { cause: signal.reason }))
  else signal?.addEventListener('abort', () => { reject(new Error('fetch aborted', { cause: signal.reason })) }, { once: true })
})

void test('caller cancellation rejects instead of returning a usable skip/false result', async () => {
  const { input } = prepared()
  const cancelled = new AbortController()
  cancelled.abort(new Error('cancelled before request'))
  await assert.rejects(setup(neverFetch).selectContext(input, cancelled.signal), /cancelled before request/)
  for (const action of ['select', 'judge'] as const) {
    const controller = new AbortController()
    const adapter = setup(async (url, init) => { queueMicrotask(() => { controller.abort(new Error('cancelled in flight')) }); return pendingFetch(url, init) })
    await assert.rejects(action === 'select' ? adapter.selectContext(input, controller.signal) : adapter.judgeStory(input, tasks, controller.signal), /cancelled in flight/)
  }
})

void test('whole-operation timeout yields skip for selection and unknown for judgment', async () => {
  const { input } = prepared()
  const adapter = setup(pendingFetch, { timeout_ms: 5 })
  const selected = await adapter.selectContext(input)
  assert.equal(selected.plan.fallback, 'skip')
  assert.match(JSON.stringify(selected.record.response), /timeout/)
  const judged = await adapter.judgeStory(input, tasks)
  assert.equal(judged.judgments[0]?.result, 'undetermined')
  assert.match(JSON.stringify(judged.record.response), /timeout/)
})


void test('timeout also covers a response body that never finishes', async () => {
  const { input } = prepared()
  const adapter = setup(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"model":"jev-partial"'))
  } })), { timeout_ms: 5 })
  const result = await adapter.selectContext(input)
  assert.equal(result.plan.fallback, 'skip')
  assert.match(JSON.stringify(result.record.response), /timeout/)
})


void test('empty successful HTTP bodies become invalid-response evidence, not canonicalization failures', async () => {
  const { input } = prepared()
  const adapter = setup(async () => new Response(null, { status: 204 }))
  const selected = await adapter.selectContext(input)
  assert.equal(selected.plan.fallback, 'skip')
  assert.deepEqual(selected.record.response, [{ status: 'invalid-response' }])
  const judged = await adapter.judgeStory(input, tasks)
  assert.equal(judged.judgments[0]?.result, 'undetermined')
  assert.deepEqual(judged.record.response, [{ status: 'invalid-response' }])
})
