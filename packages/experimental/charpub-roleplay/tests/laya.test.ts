/** Fixed Laya protocol fixtures and actual loopback HTTP; no checkpoint or inference process runs. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { z } from 'zod'
import { createPreparationCatalog, validateSelectionPlan } from '@char-pub/assembler'
import { DecisionRecordSchema } from '../src/decision-record.ts'
import { createLayaDecisions, type LayaConfig } from '../src/laya.ts'
import { appendCommand, commandPreparation, createReplay, replay } from '../src/index.ts'
import { command, replayInput, SOURCE } from './fixtures.ts'

const config: LayaConfig = {
  model: 'english', timeout_ms: 1000, request_budget: 100_000, max_requests: 10,
  select_threshold: 0.7, expand_threshold: 0.7, true_threshold: 0.9, false_threshold: 0.1,
  max_questions: 64, max_state_chars: 50_000, max_request_bytes: 2 * 1024 * 1024,
  max_response_bytes: 1024 * 1024, max_len: 2048, head_max_len: 256, min_confidence: 0.6,
}
const RequestSchema = z.object({
  model: z.string(), state: z.record(z.string(), z.json()),
  questions: z.record(z.string(), z.object({ type: z.literal('noul'), instructions: z.json() })),
  max_len: z.number(), head_max_len: z.number(), min_confidence: z.number(),
})
type Request = z.infer<typeof RequestSchema>
function parse(init?: RequestInit): Request {
  const value = init?.body
  if (typeof value !== 'string') throw new Error('JSON request body required')
  return RequestSchema.parse(JSON.parse(value))
}
function answer(request: Request, probability = 0.95, low = false, model = 'english') {
  return { model: 'checkpoint-actual-identity',
    answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, {
      type: 'noul', noul: probability, confidence: 0.84, answer_confidence: Math.max(probability, 1 - probability),
      low_confidence: low, action: { act_probability: 0.8 },
    }])),
    routing: { model, repo: `test-checkpoint/${model}`, reason: 'Explicit test routing', detection: null, workflow: null },
    usage: { input_tokens: 80, output_tokens: 8 },
  }
}
function setup(fetch: typeof globalThis.fetch, overrides: Partial<LayaConfig> = {}) {
  return createLayaDecisions({ ...config, ...overrides }, {
    apiKey: 'test-only-key', baseURL: 'https://laya.invalid', allowLoopbackHTTP: false, fetch,
  })
}
function prepared() {
  const log = createReplay(replayInput('per-agent', { catalog: true }))
  const cmd = command('choose', { kind: 'prepare' }, { for_participant: 'bob' })
  return { log, cmd, input: commandPreparation(log, cmd) }
}
const tasks = [{ target: 'beat/refusal', path: '/when/not' }]

void test('validates explicit model routing, windows and transport before issuing any request', () => {
  const never = async () => { throw new Error('network not expected') }
  assert.throws(() => setup(never, { model: 'unknown' as LayaConfig['model'] }))
  assert.throws(() => setup(never, { max_questions: 65 }))
  assert.throws(() => setup(never, { max_len: 8193 }))
  assert.throws(() => setup(never, { false_threshold: 0.95 }))
  assert.throws(() => createLayaDecisions(config, { apiKey: 'key', baseURL: 'https://laya.invalid?secret=x', allowLoopbackHTTP: false }))
  assert.throws(() => createLayaDecisions(config, { apiKey: 'key', baseURL: 'http://laya.invalid', allowLoopbackHTTP: true }))
})

void test('maps probabilities to three values and upstream low confidence to abstention, preserving actual model and routing', async () => {
  const { input } = prepared()
  for (const [probability, low, expected] of [[0.95, false, 'true'], [0.01, false, 'false'], [0.5, false, 'undetermined'], [0.99, true, 'undetermined']] as const) {
    const result = await setup(async (_url, init) => Response.json(answer(parse(init), probability, low))).judgeStory(input, tasks)
    assert.equal(result.judgments[0]?.result, expected)
    assert.deepEqual(result.judgments[0]?.provider, { name: 'laya/systemone', version: '1' })
    const text = JSON.stringify(result.record)
    for (const field of ['checkpoint-actual-identity', 'routing', 'answer_confidence', 'low_confidence', 'max_len', 'head_max_len', 'min_confidence']) assert.ok(text.includes(field), field)
    assert.ok(!text.includes('test-only-key'))
    assert.ok(!text.includes('https://laya.invalid'))
    assert.deepEqual(DecisionRecordSchema.parse(result.record), result.record)
  }
})

void test('low-confidence candidate responses neither select nor expand and do not pretend a transport failure', async () => {
  const { input } = prepared()
  let calls = 0
  const result = await setup(async (_url, init) => { calls++; return Response.json(answer(parse(init), 0.999, true)) }).selectContext(input)
  assert.equal(calls, 1)
  assert.deepEqual(result.plan.selected, [])
  assert.equal(result.plan.fallback, undefined)
  assert.ok(result.plan.decisions.every(decision => decision.action === 'reject' && decision.note === 'provider.abstained'))
})

void test('preserves explicit automatic routing and refuses a mismatched pinned route', async () => {
  const { input } = prepared()
  const automatic = await setup(async (_url, init) => {
    const request = parse(init); assert.equal(request.model, 'convaiinnovations/laya')
    return Response.json(answer(request, 0.95, false, 'multilingual'))
  }, { model: 'auto' }).judgeStory(input, tasks)
  assert.equal(automatic.judgments[0]?.result, 'true')
  assert.ok(JSON.stringify(automatic.record).includes('multilingual'))
  const mismatch = await setup(async (_url, init) => Response.json(answer(parse(init), 0.95, false, 'multilingual'))).judgeStory(input, tasks)
  assert.equal(mismatch.judgments[0]?.result, 'undetermined')
  assert.ok(JSON.stringify(mismatch.record.response).includes('invalid-response'))
})

void test('records explicit request limits without silently dropping candidates or issuing unrecorded requests', async () => {
  const { input } = prepared()
  for (const [overrides, status] of [
    [{ max_questions: 1 }, 'question-limit'], [{ max_state_chars: 1 }, 'state-limit'],
    [{ max_request_bytes: 1 }, 'body-limit'], [{ request_budget: 1 }, 'request-budget'],
  ] as const) {
    const result = await setup(async () => { throw new Error('request should be refused locally') }, overrides).selectContext(input)
    assert.equal(result.plan.fallback, 'skip')
    assert.deepEqual(result.record.request, [])
    assert.ok(JSON.stringify(result.record.response).includes(status))
  }
})

void test('invalid, missing and empty responses become recorded abstention and cannot manufacture a Plan', async () => {
  const { input } = prepared()
  const values = [{}, { model: 'not-enough', answers: {} }, null]
  for (const value of values) {
    const result = await setup(async () => Response.json(value)).selectContext(input)
    assert.equal(result.plan.fallback, 'skip')
    assert.ok(JSON.stringify(result.record.response).includes('invalid-response'))
  }
  const empty = await setup(async () => new Response(null, { status: 204 })).judgeStory(input, tasks)
  assert.equal(empty.judgments[0]?.result, 'undetermined')
  const missing = await setup(async (_url, init) => {
    const result = answer(parse(init)); delete result.answers.q0
    return Response.json(result)
  }).judgeStory(input, tasks)
  assert.equal(missing.judgments[0]?.result, 'undetermined')
})

void test('caller cancellation rejects, while stalled body or ignored transport abort times out without waiting for cancel cleanup', async () => {
  const { input } = prepared()
  const never = async () => new Promise<Response>(() => {})
  const timeout = await setup(never, { timeout_ms: 15 }).selectContext(input)
  assert.equal(timeout.plan.fallback, 'skip')
  assert.ok(JSON.stringify(timeout.record.response).includes('timeout'))
  let cancelledBody = false
  const stalled = await setup(async () => new Response(new ReadableStream({
    cancel: () => { cancelledBody = true; return new Promise<undefined>(() => {}) },
  })), { timeout_ms: 15 }).judgeStory(input, tasks)
  assert.equal(stalled.judgments[0]?.result, 'undetermined')
  assert.equal(cancelledBody, true)
  const abort = new AbortController()
  const pending = setup(never).selectContext(input, abort.signal)
  abort.abort(new Error('user cancelled'))
  await assert.rejects(pending, /user cancelled/)
})

void test('real loopback HTTP exposes progressive projections, applies server controls and replays the original provider Plan', async (t) => {
  const { log, cmd, input } = prepared()
  const seen: Request[] = []
  const failures: unknown[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const value: unknown = chunk
        if (!(value instanceof Uint8Array)) throw new Error('HTTP bytes required')
        chunks.push(Buffer.from(value))
      }
      assert.equal(request.url, '/v1/systemone')
      assert.equal(request.headers.authorization, 'Bearer local-test-key')
      const body = RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      seen.push(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer(body)))
    })().catch((error: unknown) => { failures.push(error); response.writeHead(500); response.end() })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
  })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const provider = createLayaDecisions(config, { baseURL: `http://127.0.0.1:${address.port}`, apiKey: 'local-test-key', allowLoopbackHTTP: true })
  const { plan, record } = await provider.selectContext(input)
  assert.deepEqual(failures, [])
  assert.ok(seen.length >= 3)
  assert.equal(plan.selector.name, 'laya/systemone')
  assert.ok(plan.selected.length >= 3)
  for (const request of seen) {
    assert.equal(request.max_len, 2048); assert.equal(request.head_max_len, 256); assert.equal(request.min_confidence, 0.6)
    for (const text of [SOURCE, 'ALICE_ONLY_SECRET', 'knowing', 'bindings', 'source_texts', 'CANDIDATE_BODY']) assert.ok(!JSON.stringify(request).includes(text), text)
  }
  t.assert.snapshot(seen)
  assert.deepEqual(record.request, seen)
  assert.deepEqual(validateSelectionPlan(createPreparationCatalog(input), plan), plan)
  const { selection: _fixed, ...base } = cmd
  const next = appendCommand(log, { ...base, plan, evidence: [record] })
  assert.deepEqual(replay(JSON.parse(JSON.stringify(next))).current.plan, plan)
})


void test('rejects corrupt UTF-8, oversized responses and invalid confidence without confusing them with network failure', async () => {
  const { input } = prepared()
  const corrupt = await setup(async () => new Response(new Uint8Array([0xff, 0xfe]))).judgeStory(input, tasks)
  assert.ok(JSON.stringify(corrupt.record.response).includes('invalid-response'))
  const huge = await setup(async (_url, init) => Response.json(answer(parse(init))), { max_response_bytes: 8 }).selectContext(input)
  assert.ok(JSON.stringify(huge.record.response).includes('invalid-response'))
  const invalid = await setup(async (_url, init) => {
    const response = answer(parse(init))
    const first = response.answers.q0; assert.ok(first)
    first.answer_confidence = 2
    return Response.json(response)
  }).judgeStory(input, tasks)
  assert.equal(invalid.judgments[0]?.result, 'undetermined')
  assert.ok(JSON.stringify(invalid.record.response).includes('raw_response_digest'))
})
