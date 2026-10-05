/** Real Loader + JSONL turn planning, atomic narration, bounded decisions and append-only rewind. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { digestExactJSON, resolveStoryPlayer, HistoryMessageSchema } from '@char-pub/core'
import { projectPlayerView } from '@char-pub/assembler'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { commandId } from '../../charpub-roleplay/src/index.ts'
import { replayInput } from '../../charpub-roleplay/tests/fixtures.ts'
import { canRewind, lookupPlay, requestMessages, type PlayIntent, type RoleplayProjection } from '../src/index.ts'
import { historyLoader } from './fixtures/history-loader.ts'

const DirectorInput = z.object({
  interaction: z.object({ history: z.array(HistoryMessageSchema) }), latest_input: HistoryMessageSchema,
})
const route = { provider: 'roleplay-test', model: 'fixed', maxTokens: 512 }
const config = { generation: route, decisions: route,
  limits: { min_confidence: 0.8, max_actions: 4, max_decision_calls: 1, max_decision_tokens: 8192 } }
const director = (targets: string[] = [], judgments: unknown[] = []) => JSON.stringify({
  actions: targets.map(target => ({ target, confidence: 0.95 })), judgments,
})
const intent = (view: RoleplayProjection, id: string, text = 'I claim the token and walk to the garden.'): PlayIntent => ({
  id: commandId(id), text, expected_revision: view.revision,
})
async function fixture(t: import('node:test').TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), 'charpub-play-'))
  const ctx = await historyLoader(root)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId(name)
  const initial = await ctx.roleplayRuntime.create(id, replayInput('narrator', { player: true, choices: true }))
  return { root, ctx, id, initial }
}

void test('new input reaches director before judging; ordered authored effects settle together and survive reopening', async (t) => {
  const { root, ctx, id, initial } = await fixture(t, 'complete-turn')
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward', 'beat/refusal', 'scene/garden'], [
    { target: 'beat/refusal', path: '/when/not', result: 'false', confidence: 0.95 },
  ]) }, { text: 'You claim two tokens and enter the garden.' }]
  const request = intent(initial, 'turn-one', 'I take the token, refuse the offer, and enter the garden.')
  const result = await ctx.roleplayRuntime.play(id, request, config)
  assert.equal(result.settlement.status, 'success')
  const view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.current.state.vars.count, 2)
  assert.equal(view.current.state.scene, 'garden')
  assert.equal(view.current.turn.history.at(-2)?.speaker, resolveStoryPlayer(initial.log.input.artifact)?.participant)
  assert.equal(view.pending_turn, null)
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
  const turn = view.turns.get(request.id)
  assert.ok(turn)
  const planned = turn.decisions.get(0)?.requested
  assert.ok(planned)
  const plannedBody = z.record(z.string(), z.unknown()).parse(JSON.parse(planned.messages[1]!.content))
  const evidence = DirectorInput.parse(plannedBody)
  assert.equal(Object.keys(plannedBody).at(-1), 'latest_input')
  assert.deepEqual(evidence.interaction.history, initial.current.turn.history)
  assert.deepEqual(evidence.latest_input, view.current.turn.history.at(-2))
  assert.equal(evidence.latest_input.text, request.text)
  assert.deepEqual(ctx.roleplayTestProvider.calls[0]?.messages, requestMessages({ ...planned, id: planned.request_digest }))
  assert.deepEqual(result.resolution.actions.map(value => value.status), ['applied', 'applied', 'applied'])
  const narration = [...view.requests.values()][0]
  assert.ok(narration)
  assert.deepEqual(ctx.roleplayTestProvider.calls[1]?.messages, requestMessages(narration))
  t.assert.snapshot({ decisions: planned.messages, narration: narration.messages, resolution: result.resolution })
  assert.deepEqual(await ctx.roleplayRuntime.play(id, request, config), result)
  await ctx.fiber.dispose()
  const reopened = await historyLoader(root)
  t.after(async () => { await reopened.fiber.dispose() })
  assert.deepEqual(await reopened.roleplayRuntime.play(id, request, config), result)
  assert.equal(reopened.roleplayTestProvider.calls.length, 0)
})

void test('unknown, ambiguous and missing evidence proposals fail closed; explicit choices are input evidence', async (t) => {
  const { ctx, id, initial } = await fixture(t, 'uncertain-turn')
  ctx.roleplayTestProvider.replies = [{ text: JSON.stringify({ actions: [
    { target: 'beat/invented', confidence: 1 }, { target: 'beat/reward', confidence: 0.5 },
    { target: 'beat/refusal', confidence: 0.95 },
  ], judgments: [] }) }, { text: 'Do you intend to claim the token?' }]
  const result = await ctx.roleplayRuntime.play(id, { ...intent(initial, 'uncertain', ''), choice_id: 'claim' }, config)
  assert.equal(result.settlement.status, 'success')
  assert.deepEqual(result.resolution.actions.map(value => value.status), ['skipped', 'skipped', 'skipped'])
  const view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.current.state.vars.count, 0)
  assert.equal(view.current.turn.history.at(-2)?.text, 'I claim the token.')
  const planned = view.turns.get(commandId('uncertain'))?.decisions.get(0)?.requested
  assert.ok(planned)
  const evidence = DirectorInput.parse(JSON.parse(planned.messages[1]!.content))
  assert.deepEqual(evidence.interaction.history, initial.current.turn.history)
  assert.deepEqual(evidence.latest_input, view.current.turn.history.at(-2))
  assert.equal(evidence.latest_input.text, 'I claim the token.')
  assert.match(ctx.roleplayTestProvider.calls[0]?.messages.at(-1)?.content.map(part => part.type === 'text' ? part.text : '').join('') ?? '', /I claim the token/)
  await assert.rejects(ctx.roleplayRuntime.play(id, { ...intent(view, 'bad-speaker'), speaker: initial.log.input.artifact.kind === 'content' ? initial.log.input.artifact.story_refs?.participants.bob : 'missing' }, config), { code: 'roleplay.player_speaker_mismatch' })
  await assert.rejects(ctx.roleplayRuntime.play(id, { ...intent(view, 'bad-choice'), choice_id: 'absent' }, config), { code: 'roleplay.choice_unavailable' })
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
})

void test('failed narration and cancellation never publish accepted effects or player dialogue', async (t) => {
  const { ctx, id, initial } = await fixture(t, 'failed-turn')
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward']) }, { mode: 'failure' }]
  const request = intent(initial, 'fails')
  const failed = await ctx.roleplayRuntime.play(id, request, config)
  assert.equal(failed.settlement.status, 'failed')
  assert.equal(failed.resolution.actions[0]?.status, 'uncommitted')
  let view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.head, initial.head)
  assert.deepEqual(view.current.turn.history, initial.current.turn.history)
  assert.deepEqual(await ctx.roleplayRuntime.play(id, request, config), failed)
  const controller = new AbortController()
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward']) }]
  ctx.roleplayTestProvider.onRequest = () => { controller.abort(new Error('cancel planning')) }
  const cancelled = await ctx.roleplayRuntime.play(id, intent(view, 'cancelled'), config, controller.signal)
  assert.equal(cancelled.settlement.status, 'cancelled')
  view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.head, initial.head)
  assert.equal(view.pending_turn, null)
  assert.equal(ctx.roleplayTestProvider.calls.length, 3)
})

void test('rewind restores one committed turn and fences both old revisions and replayed request IDs', async (t) => {
  const { ctx, id, initial } = await fixture(t, 'rewind-turn')
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward', 'scene/garden']) }, { text: 'A token, then the garden.' }]
  const request = intent(initial, 'original')
  await ctx.roleplayRuntime.play(id, request, config)
  let view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(canRewind(view), true)
  const rewind = { id: commandId('undo-one'), expected_revision: view.revision }
  const result = await ctx.roleplayRuntime.rewind(id, rewind)
  view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.head, initial.head)
  assert.notEqual(view.revision, initial.revision)
  assert.deepEqual(view.current.turn.history, initial.current.turn.history)
  assert.equal(canRewind(view), false)
  assert.equal((await ctx.roleplayRuntime.play(id, request, config)).superseded, true)
  assert.deepEqual(await ctx.roleplayRuntime.rewind(id, rewind), result)
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
  await assert.rejects(ctx.roleplayRuntime.play(id, intent(initial, 'stale-tab'), config), { code: 'roleplay_runtime.stale_revision' })
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward']) }, { text: 'You stay in the lobby with the token.' }]
  const replacement = await ctx.roleplayRuntime.play(id, intent(view, 'replacement'), config)
  assert.equal(replacement.settlement.status, 'success')
  view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.current.state.scene, 'lobby')
  assert.equal(view.current.state.vars.count, 1)
  assert.equal(lookupPlay(view, 'original').status, 'settled')
})

void test('planning and narration interruption require explicit recovery and retain old IDs without redispatch', async (t) => {
  const { ctx, id, initial } = await fixture(t, 'interrupted-turn')
  const old = intent(initial, 'interrupted')
  const fields = { intent: old, config, parent_head: initial.head, parent_revision: initial.revision }
  const handle = await ctx.sessionPersistence.open(id, 'write')
  try {
    const stored = await handle.read()
    await handle.append([{ type: 'roleplay/turn-started', data: { ...fields, digest: digestExactJSON(fields) },
      seq: SessionSeq(stored.events.length), time: Date.now() }])
    await handle.flush()
  } finally { await handle.close() }
  const pending = await ctx.roleplayRuntime.inspect(id)
  assert.equal(pending.pending_turn?.id, old.id)
  await assert.rejects(ctx.roleplayRuntime.play(id, old, config), { code: 'roleplay_runtime.interrupted_retry_forbidden' })
  await assert.rejects(ctx.roleplayRuntime.play(id, intent(pending, 'without-recovery'), config), { code: 'roleplay_runtime.interrupted_request' })
  ctx.roleplayTestProvider.replies = [{ text: director() }, { text: 'The rain continues.' }]
  const next = await ctx.roleplayRuntime.play(id, { ...intent(pending, 'recovery'), recover_interrupted: true }, config)
  assert.equal(next.settlement.status, 'success')
  const ended = await ctx.roleplayRuntime.play(id, old, config)
  assert.equal(ended.settlement.status, 'failed')
  assert.ok('reason' in ended.settlement)
  assert.equal(ended.settlement.reason, 'interrupted')
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
})

void test('decision admission reserves aggregate input and output tokens before dispatch', async (t) => {
  const { ctx, id, initial } = await fixture(t, 'budget-turn')
  const result = await ctx.roleplayRuntime.play(id, intent(initial, 'budget'), { ...config,
    limits: { ...config.limits, max_decision_tokens: 512 },
  })
  assert.equal(result.settlement.status, 'success')
  assert.equal(result.resolution.actions[0]?.reason, 'decision_token_budget')
  assert.equal(ctx.roleplayTestProvider.calls.length, 1)
  assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, 0)
  await assert.rejects(ctx.roleplayRuntime.play(id, intent(await ctx.roleplayRuntime.inspect(id), 'bad-output'), {
    ...config, generation: { ...route, maxTokens: 2000 },
  }), { code: 'roleplay_runtime.output_reserve' })
  assert.equal(ctx.roleplayTestProvider.calls.length, 1)
})

void test('each write barrier reconciles without silently repeating a decision or narration request', async (t) => {
  const { ctx, initial } = await fixture(t, 'barrier-placeholder')
  for (const barrier of [1, 2, 3, 4, 5]) {
    const id = SessionId(`turn-barrier-${barrier}`)
    const opening = await ctx.roleplayRuntime.create(id, initial.log.input)
    const request = intent(opening, `request-${barrier}`)
    ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward']) }, { text: 'You receive a token.' }]
    const original = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    let flushes = 0
    const mocked = t.mock.method(ctx.sessionPersistence, 'open', async (...args: Parameters<typeof original>) => {
      const handle = await original(...args)
      if (args[1] !== 'write') return handle
      return {
        id: handle.id, header: handle.header, inheritedEventCount: handle.inheritedEventCount, access: handle.access,
        read: handle.read.bind(handle), append: handle.append.bind(handle),
        async flush() { if (++flushes === barrier) throw new Error('injected turn durability failure'); await handle.flush() },
        close: handle.close.bind(handle), [Symbol.asyncDispose]: handle[Symbol.asyncDispose].bind(handle),
      }
    })
    const before = ctx.roleplayTestProvider.calls.length
    await assert.rejects(ctx.roleplayRuntime.play(id, request, config), /injected turn durability failure/)
    mocked.mock.restore()
    const view = await ctx.roleplayRuntime.inspect(id)
    assert.equal(ctx.roleplayTestProvider.calls.length - before, barrier <= 2 ? 0 : barrier <= 4 ? 1 : 2)
    if (barrier === 5) {
      assert.equal((await ctx.roleplayRuntime.play(id, request, config)).settlement.status, 'success')
      assert.equal(view.current.state.vars.count, 1)
    } else {
      assert.equal(view.current.state.vars.count, 0)
      await assert.rejects(ctx.roleplayRuntime.play(id, request, config), { code: 'roleplay_runtime.interrupted_retry_forbidden' })
      ctx.roleplayTestProvider.replies = [{ text: director() }, { text: 'The rain continues.' }]
      const recovered = await ctx.roleplayRuntime.play(id, { ...intent(view, `recover-${barrier}`), recover_interrupted: true }, config)
      assert.equal(recovered.settlement.status, 'success')
      const ended = await ctx.roleplayRuntime.play(id, request, config)
      assert.equal(ended.settlement.status !== 'success' && ended.settlement.reason, 'interrupted')
      assert.equal(ctx.roleplayTestProvider.calls.length - before, (barrier <= 2 ? 0 : 1) + 2)
    }
  }
})

void test('selector progressively receives descriptions and current input while raw candidate bodies remain private', async (t) => {
  const { ctx } = await fixture(t, 'selector-placeholder')
  const id = SessionId('selected-turn')
  const initial = await ctx.roleplayRuntime.create(id, replayInput('narrator', { catalog: true, player: true }))
  ctx.roleplayTestProvider.onRequest = () => {
    const request = ctx.roleplayTestProvider.calls.at(-1)
    const system = request?.messages[0]?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') ?? ''
    if (system.includes('"actions":[')) ctx.roleplayTestProvider.replies.push({ text: director() })
    else if (system.startsWith('Score the relevance')) {
      const body = request?.messages[1]?.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') ?? '{}'
      const query = JSON.parse(body) as { questions: Record<string, object> }
      ctx.roleplayTestProvider.replies.push({ text: JSON.stringify({ answers: Object.fromEntries(
        Object.keys(query.questions).map(key => [key, { type: 'noul', noul: 0.95, confidence: 0.95 }]),
      ) }) })
    }
  }
  const result = await ctx.roleplayRuntime.play(id, intent(initial, 'select', 'I ask about the tunnel and nearby market.'), {
    ...config, limits: { ...config.limits, max_decision_calls: 8, max_decision_tokens: 20_000 },
  })
  assert.equal(result.settlement.status, 'success')
  const view = await ctx.roleplayRuntime.inspect(id)
  const decisions = [...view.turns.get(commandId('select'))!.decisions.values()].map(value => value.requested)
  assert.ok(decisions.filter(value => value.stage === 'selector').length >= 2)
  assert.ok(decisions.length <= 8)
  for (const decision of decisions) {
    const text = JSON.stringify(decision.messages)
    assert.match(text, /I ask about the tunnel and nearby market/)
    assert.ok(!text.includes('TUNNEL_CANDIDATE_BODY'))
    assert.ok(!text.includes('ALICE_ONLY_SECRET'))
    assert.equal(decision.messages.filter(message => message.role === 'system').length, 1)
  }
  const request = [...view.requests.values()][0]
  assert.ok(request)
  assert.match(JSON.stringify(request.messages), /TUNNEL_CANDIDATE_BODY/)
  assert.equal(request.command.plan?.selector.name, 'roleplay/llm-selector')
  assert.ok(request.command.plan?.decisions.some(value => value.action === 'expand'))
})

void test('thirty durable turns retain complete history and bounded per-turn dispatches', async (t) => {
  const { ctx, id, initial } = await fixture(t, 'long-turns')
  let view = initial
  const elapsed: number[] = []
  for (let index = 0; index < 30; index++) {
    ctx.roleplayTestProvider.replies = [{ text: director() }, { text: `The rain continues, ${index}.` }]
    const start = performance.now()
    const result = await ctx.roleplayRuntime.play(id, intent(view, `long-${index}`, `I watch the rain, ${index}.`), config)
    elapsed.push(performance.now() - start)
    assert.equal(result.settlement.status, 'success', JSON.stringify({ turn: index + 1, outcome: result.settlement.status === 'success' ? 'success' : result.settlement.reason, elapsed_ms: elapsed.at(-1) }))
    view = await ctx.roleplayRuntime.inspect(id)
    if ((index + 1) % 5 === 0) t.diagnostic(JSON.stringify({ completed: index + 1, elapsed_ms: elapsed.at(-1) }))
  }
  assert.equal(ctx.roleplayTestProvider.calls.length, 60)
  assert.equal(view.current.turn.history.length, initial.current.turn.history.length + 60)
  assert.equal(view.turns.size, 30)
  assert.equal(view.pending_turn, null)
  assert.equal(view.current.turn.history.at(-1)?.text, 'The rain continues, 29.')
  t.diagnostic(JSON.stringify({ turns: 30, first_ms: Math.round(elapsed[0]!), last_ms: Math.round(elapsed.at(-1)!),
    total_ms: Math.round(elapsed.reduce((sum, value) => sum + value, 0)), model_calls: 60 }))
})

void test('director sees localized scene openings, prerequisites and completed targets before a topical scene transition', async (t) => {
  const { ctx } = await fixture(t, 'phase-placeholder')
  const id = SessionId('discussion-phase')
  const initial = await ctx.roleplayRuntime.create(id, replayInput('narrator', { player: true, phaseScene: true }))
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/refusal'], [
    { target: 'beat/refusal', path: '/when/not', result: 'false', confidence: 0.95 },
  ]) }, { text: 'The offer is set aside.' }]
  await ctx.roleplayRuntime.play(id, intent(initial, 'refuse', 'I refuse the offer.'), config)
  const before = await ctx.roleplayRuntime.inspect(id)
  ctx.roleplayTestProvider.replies = [{ text: director(['scene/garden', 'beat/reward']) }, { text: 'Together you list the known facts.' }]
  const result = await ctx.roleplayRuntime.play(id, intent(before, 'discuss', 'Now let us list what is known and what still needs checking.'), config)
  assert.equal(result.settlement.status, 'success')
  const view = await ctx.roleplayRuntime.inspect(id)
  const request = view.turns.get(commandId('discuss'))?.decisions.get(0)?.requested
  assert.ok(request)
  const evidence = JSON.parse(request.messages[1]!.content) as {
    current: { completed_targets: string[] }
    targets: { target: string; opening?: string; condition_result_now: boolean | 'unknown'; associated_scenes: string[]; beats?: string[] }[]
  }
  const scene = evidence.targets.find(value => value.target === 'scene/garden')
  const beat = evidence.targets.find(value => value.target === 'beat/reward')
  assert.match(scene?.opening ?? '', /Guest and Alice compare what is known/)
  assert.ok(!scene?.opening?.includes('{{'))
  assert.equal(scene?.condition_result_now, true)
  assert.deepEqual(scene?.beats, ['beat/reward'])
  assert.equal(beat?.condition_result_now, false)
  assert.deepEqual(beat?.associated_scenes, ['garden'])
  assert.deepEqual(evidence.current.completed_targets, ['beat/refusal'])
  assert.equal(evidence.targets.some(value => value.target === 'beat/refusal'), false)
  assert.equal(view.current.state.scene, 'garden')
  assert.equal(view.current.state.vars.count, 2)
  assert.deepEqual(result.resolution.actions.map(value => value.status), ['applied', 'applied'])
  assert.ok(!request.messages[1]!.content.includes('ALICE_ONLY_SECRET'))
  const attributed = DirectorInput.parse(JSON.parse(request.messages[1]!.content))
  assert.deepEqual(attributed.interaction.history, before.current.turn.history)
  assert.equal(attributed.latest_input.text, 'Now let us list what is known and what still needs checking.')
  assert.deepEqual([...attributed.interaction.history, attributed.latest_input], view.current.turn.history.slice(0, -1))
  t.assert.snapshot({ input: request.messages, resolution: result.resolution })
})

void test('selecting an unavailable external Source fails preparation without publishing authored effects', async (t) => {
  const { ctx } = await fixture(t, 'source-placeholder')
  const id = SessionId('source-not-loaded')
  const input = replayInput('narrator', { player: true })
  input.source_texts = {}
  const initial = await ctx.roleplayRuntime.create(id, input)
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward']) }, { text: JSON.stringify({
    answers: { q0: { type: 'noul', noul: 0.95, confidence: 0.95 } },
  }) }]
  const result = await ctx.roleplayRuntime.play(id, intent(initial, 'select-unloaded'), {
    ...config, limits: { ...config.limits, max_decision_calls: 3 },
  })
  assert.equal(result.settlement.status, 'failed')
  assert.equal(ctx.roleplayTestProvider.calls.length, 2)
  const view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.current.state.vars.count, 0)
  assert.equal(view.head, initial.head)
  assert.equal(view.pending_turn, null)
  assert.equal(view.requests.size, 0)
})

void test('undeclared structural judge paths are ignored while independent declared leaves remain usable', async (t) => {
  const { ctx } = await fixture(t, 'extra-judge-placeholder')
  const id = SessionId('extra-judge')
  const initial = await ctx.roleplayRuntime.create(id, replayInput('narrator', { player: true, phaseScene: true, judgePairs: true }))
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/refusal', 'scene/garden', 'beat/reward'], [
    { target: 'beat/refusal', path: '/when/not', result: 'false', confidence: 0.95 },
    { target: 'beat/reward', path: '/when/all/1', result: 'true', confidence: 0.95 },
    { target: 'scene/garden', path: '/when', result: 'true', confidence: 0.99 },
  ]) }, { text: 'You decline, compare the facts, and claim the token.' }]
  const result = await ctx.roleplayRuntime.play(id, intent(initial, 'extra-judge-turn'), config)
  assert.equal(result.settlement.status, 'success')
  const view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.current.state.vars.count, 2)
  assert.equal(view.current.state.scene, 'garden')
  const judgments = view.turns.get(commandId('extra-judge-turn'))?.command?.judgments ?? []
  assert.equal(judgments.some(value => value.target === 'scene/garden'), false)
  assert.deepEqual(judgments.map(value => [value.target, value.path, value.result]), [
    ['beat/reward', '/when/all/1', 'true'], ['beat/refusal', '/when/not', 'false'],
  ])
  assert.deepEqual(result.resolution.actions.map(value => value.status), ['applied', 'applied', 'applied'])
})

void test('duplicate declared judge entries make only their own leaf unknown and cannot overwrite independent evidence', async (t) => {
  const { ctx } = await fixture(t, 'duplicate-judge-placeholder')
  const id = SessionId('duplicate-judge')
  const initial = await ctx.roleplayRuntime.create(id, replayInput('narrator', { player: true, judgePairs: true }))
  ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward', 'beat/refusal'], [
    { target: 'beat/reward', path: '/when', result: 'true', confidence: 0.99 },
    { target: 'beat/reward', path: '/when', result: 'false', confidence: 0.99 },
    { target: 'beat/reward', path: '/when', result: 'true', confidence: 0.99 },
    { target: 'beat/refusal', path: '/when/not', result: 'false', confidence: 0.95 },
  ]) }, { text: 'You refuse the offer; the token claim remains unclear.' }]
  const result = await ctx.roleplayRuntime.play(id, intent(initial, 'duplicate-judge-turn'), config)
  assert.equal(result.settlement.status, 'success')
  const view = await ctx.roleplayRuntime.inspect(id)
  assert.equal(view.current.state.vars.count, 1)
  const judgments = view.turns.get(commandId('duplicate-judge-turn'))?.command?.judgments ?? []
  assert.equal(judgments.find(value => value.target === 'beat/reward')?.result, 'undetermined')
  assert.equal(judgments.find(value => value.target === 'beat/refusal')?.result, 'false')
  assert.deepEqual(result.resolution.actions.map(value => value.status), ['skipped', 'applied'])
})

void test('play rejects command IDs consumed by legacy submit before appending a turn or dispatching decisions', async (t) => {
  const { ctx, initial } = await fixture(t, 'legacy-id-placeholder')
  for (const mode of ['success', 'failure'] as const) {
    const id = SessionId(`legacy-id-${mode}`)
    await ctx.roleplayRuntime.create(id, initial.log.input)
    const command = { id: commandId(`shared-${mode}`), operation: { kind: 'prepare' as const } }
    ctx.roleplayTestProvider.replies = [{ mode }]
    await ctx.roleplayRuntime.submit(id, command, route)
    const before = await ctx.roleplayRuntime.inspect(id)
    const calls = ctx.roleplayTestProvider.calls.length
    await assert.rejects(ctx.roleplayRuntime.play(id, intent(before, command.id), config), {
      code: 'roleplay_runtime.command_conflict',
    })
    const after = await ctx.roleplayRuntime.inspect(id)
    assert.equal(after.revision, before.revision)
    assert.equal(after.head, before.head)
    assert.equal(after.pending_turn, null)
    assert.equal(ctx.roleplayTestProvider.calls.length, calls)
  }
})

void test('legacy submit cannot reuse a planning-aborted play ID even when it has no narration request', async (t) => {
  const { ctx, id, initial } = await fixture(t, 'aborted-id')
  const controller = new AbortController()
  ctx.roleplayTestProvider.onRequest = () => { controller.abort(new Error('cancel before narration')) }
  const request = intent(initial, 'shared-aborted')
  const aborted = await ctx.roleplayRuntime.play(id, request, config, controller.signal)
  assert.equal(aborted.settlement.status, 'cancelled')
  ctx.roleplayTestProvider.onRequest = undefined
  const before = await ctx.roleplayRuntime.inspect(id)
  assert.equal(before.requests.size, 0)
  const calls = ctx.roleplayTestProvider.calls.length
  await assert.rejects(ctx.roleplayRuntime.submit(id, { id: request.id, operation: { kind: 'prepare' } }, route), {
    code: 'roleplay_runtime.command_conflict',
  })
  const after = await ctx.roleplayRuntime.inspect(id)
  assert.equal(after.revision, before.revision)
  assert.equal(after.head, initial.head)
  assert.equal(ctx.roleplayTestProvider.calls.length, calls)
  assert.deepEqual(await ctx.roleplayRuntime.play(id, request, config), aborted)
})


void test('restored choice admission uses the same committed fixed/manual evidence as the player view', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-choice-admission-'))
  let ctx = await historyLoader(root)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  for (const origin of ['opening', 'legacy-submit'] as const) {
    const id = SessionId(`choice-${origin}`)
    const input = replayInput('narrator', { choices: true, choiceJudge: true })
    const judgments = [{ target: 'choice/claim', path: '/when', result: 'true' as const,
      provider: { name: origin === 'opening' ? 'fixed' : 'manual', version: '1' } }]
    if (origin === 'opening') input.judgments = judgments
    await ctx.roleplayRuntime.create(id, input)
    if (origin === 'legacy-submit') await ctx.roleplayRuntime.submit(id, {
      id: commandId('legacy-choice-evidence'), operation: { kind: 'prepare' }, judgments,
    }, route)
    const before = await ctx.roleplayRuntime.inspect(id)
    assert.deepEqual(projectPlayerView({ artifact: input.artifact, turn: before.current.turn }).choices.map(value => value.id), ['claim'])
    await ctx.fiber.dispose()
    ctx = await historyLoader(root)
    const restored = await ctx.roleplayRuntime.inspect(id)
    assert.equal(restored.head, before.head)
    assert.deepEqual(restored.current.turn.judgments, judgments)
    ctx.roleplayTestProvider.replies = [{ text: director() }, { text: 'The innkeeper hears your claim.' }]
    const result = await ctx.roleplayRuntime.play(id, { ...intent(restored, `choose-${origin}`, ''), choice_id: 'claim' }, config)
    assert.equal(result.settlement.status, 'success')
    const committed = await ctx.roleplayRuntime.inspect(id)
    assert.equal(committed.current.turn.history.at(-2)?.text, 'I claim the token.')
    assert.equal(ctx.roleplayTestProvider.calls.length, 2)
  }
})
