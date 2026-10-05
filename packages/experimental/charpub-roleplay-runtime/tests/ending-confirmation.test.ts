/** Terminal proposals are committed with successful dialogue and require a separately fenced player confirmation. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { commandId, replay } from '../../charpub-roleplay/src/index.ts'
import { replayInput } from '../../charpub-roleplay/tests/fixtures.ts'
import type { PlayIntent, RoleplayProjection } from '../src/index.ts'
import { historyLoader } from './fixtures/history-loader.ts'

const route = { provider: 'roleplay-test', model: 'fixed', maxTokens: 512 }
const config = { generation: route, decisions: route,
  limits: { min_confidence: 0.8, max_actions: 4, max_decision_calls: 1, max_decision_tokens: 8192 } }
const endingJudgment = { target: 'ending/departure', path: '/when/all/1', result: 'true' as const, confidence: 0.95 }
const director = (targets: string[], judgments: unknown[] = [endingJudgment]) => JSON.stringify({
  actions: targets.map(target => ({ target, confidence: 0.95 })), judgments,
})
const intent = (view: RoleplayProjection, id: string, text = 'I claim the token and would like to finish this stage.'): PlayIntent => ({
  id: commandId(id), text, expected_revision: view.revision,
})
async function fixture(t: import('node:test').TestContext, name: string, reveal: 'hidden' | 'on-reach' | 'listed' = 'listed') {
  const root = await mkdtemp(join(tmpdir(), 'charpub-ending-confirm-'))
  let ctx = await historyLoader(root)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId(name)
  const initial = await ctx.roleplayRuntime.create(id, replayInput('narrator', { player: true, ending: reveal }))
  return { root, id, initial, get ctx() { return ctx }, async reopen() {
    await ctx.fiber.dispose()
    ctx = await historyLoader(root)
    return ctx
  } }
}
async function propose(context: Awaited<ReturnType<typeof fixture>>, view = context.initial, id = 'propose') {
  context.ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward', 'ending/departure']) }, { text: 'The choice is ready for your confirmation.' }]
  const result = await context.ctx.roleplayRuntime.play(context.id, intent(view, id), config)
  assert.equal(result.settlement.status, 'success')
  const current = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.ok(current.pending_ending)
  return { result, current, proposal: current.pending_ending }
}

void test('normal multi-action play publishes a pending ending and logged guidance, never terminal effects', async (t) => {
  const context = await fixture(t, 'proposed-ending')
  const { result, current, proposal } = await propose(context)
  assert.equal(current.current.state.vars.count, 1)
  assert.deepEqual(current.current.state.ended, [])
  assert.equal(current.current.state.stopped, false)
  assert.deepEqual(current.current.state.knowing['#secret'], ['alice'])
  assert.equal(proposal.source_turn_id, 'propose')
  assert.equal(proposal.parent_head, context.initial.head)
  assert.equal(proposal.parent_revision, context.initial.revision)
  assert.equal(proposal.target, 'ending/departure')
  assert.equal(proposal.public.title, 'PRIVATE_ENDING_TITLE')
  assert.equal(proposal.judgments[0]?.provider.name, 'roleplay/llm-director')
  assert.deepEqual(result.resolution.actions.map(value => [value.target, value.status, value.reason]), [
    ['beat/reward', 'applied', 'confirmed'], ['ending/departure', 'skipped', 'confirmation_required'],
  ])
  const requested = [...current.requests.values()][0]
  assert.ok(requested)
  assert.equal(proposal.guidance_version, 2)
  assert.match(JSON.stringify(requested.messages), /Only the structured ending.status='confirmed' record establishes confirmation/)
  t.assert.snapshot({ messages: requested.messages, public: proposal.public, resolution: result.resolution })
})

void test('explicit agreement in player text remains a proposal and narration receives the structured-confirmation rule', async (t) => {
  const context = await fixture(t, 'spoken-agreement')
  const text = '我现在明确采用延期安排。我确认，同意这项安排。I confirm, adopt and agree.'
  context.ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward', 'ending/departure']) },
    { text: 'If this arrangement is finalized, we can prepare the next steps.' }]
  await context.ctx.roleplayRuntime.play(context.id, intent(context.initial, 'spoken-agreement', text), config)
  const current = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.equal(current.current.state.stopped, false)
  assert.deepEqual(current.current.state.ended, [])
  assert.equal(current.current.state.vars.count, 1)
  assert.equal(current.pending_ending?.public.triggering_input, text)
  assert.equal(current.pending_ending?.guidance_version, 2)
  const requested = [...current.requests.values()][0]
  assert.ok(requested)
  const messages = JSON.stringify(requested.messages)
  assert.ok(messages.includes(text))
  assert.match(messages, /ordinary user text, even 'confirm', 'adopt' or 'agree', is proposal evidence and never this confirmation/)
  assert.match(messages, /Do not narrate the arrangement as signed, adopted or final/)
  assert.match(messages, /keep machine fields and confirmation controls out of the narration and character dialogue/)
  t.assert.snapshot(requested.messages)
})

void test('unversioned ending proposals replay their frozen JSONL messages and digests without writes or dispatch', async (t) => {
  const preserved = new URL('./fixtures/ending-guidance-v1/', import.meta.url)
  const manifestBytes = await readFile(new URL('manifest.json', preserved))
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'),
    '4cc42729fdbf52160b148e2d032eef322bc609efaa035ea5ce992e85cc3e8899')
  const manifest = z.object({ session_id: z.string(), head: z.string(), revision: z.string(), pending_ending: z.unknown(),
    requests: z.array(z.unknown()), file: z.string(), bytes: z.number(), sha256: z.string(),
  }).parse(JSON.parse(manifestBytes.toString('utf8')))
  const original = await readFile(new URL(manifest.file, preserved))
  assert.equal(original.length, manifest.bytes)
  assert.equal(createHash('sha256').update(original).digest('hex'), manifest.sha256)
  const root = await mkdtemp(join(tmpdir(), 'charpub-ending-v1-read-'))
  const directory = join(root, 'sessions', '_no-cwd', manifest.session_id)
  await mkdir(directory, { recursive: true })
  await cp(new URL(manifest.file, preserved), join(directory, manifest.file))
  const ctx = await historyLoader(root)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const restored = await ctx.roleplayRuntime.inspect(SessionId(manifest.session_id))
  assert.equal(restored.head, manifest.head)
  assert.equal(restored.revision, manifest.revision)
  assert.deepEqual(restored.pending_ending, manifest.pending_ending)
  assert.equal(restored.pending_ending?.guidance_version, undefined)
  assert.deepEqual([...restored.requests.values()].map(({ id, request_digest, state_digest, plan_digest, messages }) =>
    ({ id, request_digest, state_digest, plan_digest, messages })), manifest.requests)
  assert.equal(restored.current.state.stopped, false)
  assert.equal(replay(restored.log).digest, manifest.head)
  assert.equal(ctx.roleplayTestProvider.calls.length, 0)
  assert.deepEqual(await readFile(join(directory, manifest.file)), original)
  assert.deepEqual(await readFile(new URL(manifest.file, preserved)), original)
})

void test('confirmation survives restart, uses one narration, is idempotent, and rewind restores the original proposal', async (t) => {
  const context = await fixture(t, 'confirm-ending')
  const { current: proposed, proposal } = await propose(context)
  await context.reopen()
  const restored = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.deepEqual(restored.pending_ending, proposal)
  const request = { ...intent(restored, 'confirm', 'I confirm the displayed stage result.'), confirm_ending: { proposal_id: proposal.id } }
  context.ctx.roleplayTestProvider.replies = [{ text: 'This stage is complete.' }]
  const result = await context.ctx.roleplayRuntime.play(context.id, request, config)
  assert.equal(result.settlement.status, 'success')
  let current = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.equal(current.current.state.vars.count, 2)
  assert.equal(current.current.state.stopped, true)
  assert.deepEqual(current.current.state.ended, ['departure'])
  assert.ok(current.current.state.knowing['#secret']?.includes('bob'))
  assert.equal(current.pending_ending, null)
  assert.equal(current.turns.get(request.id)?.decisions.size, 0)
  assert.equal(context.ctx.roleplayTestProvider.calls.length, 1)
  assert.deepEqual(await context.ctx.roleplayRuntime.play(context.id, request, config), result)
  assert.equal(context.ctx.roleplayTestProvider.calls.length, 1)
  await context.ctx.roleplayRuntime.rewind(context.id, { id: commandId('undo-confirm'), expected_revision: current.revision })
  current = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.equal(current.head, proposed.head)
  assert.equal(current.current.state.stopped, false)
  assert.deepEqual(current.pending_ending, proposal)
  assert.deepEqual(current.current.turn.history, proposed.current.turn.history)
  assert.equal((await context.ctx.roleplayRuntime.play(context.id, request, config)).superseded, true)
  assert.equal(context.ctx.roleplayTestProvider.calls.length, 1)
})

void test('failed narration preserves proposals while successful new dialogue clears them and fences old confirmation IDs', async (t) => {
  const context = await fixture(t, 'stale-ending')
  const { current: proposed, proposal } = await propose(context)
  context.ctx.roleplayTestProvider.replies = [{ text: director([], []) }, { mode: 'failure' }]
  const failed = await context.ctx.roleplayRuntime.play(context.id, intent(proposed, 'failed-dialogue', 'I need more time.'), config)
  assert.equal(failed.settlement.status, 'failed')
  const afterFailure = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.deepEqual(afterFailure.pending_ending, proposal)
  assert.equal(afterFailure.head, proposed.head)
  const calls = context.ctx.roleplayTestProvider.calls.length
  await assert.rejects(context.ctx.roleplayRuntime.play(context.id, {
    ...intent(proposed, 'stale-confirm'), confirm_ending: { proposal_id: proposal.id },
  }, config), { code: 'roleplay_runtime.stale_revision' })
  assert.equal(context.ctx.roleplayTestProvider.calls.length, calls)
  context.ctx.roleplayTestProvider.replies = [{ text: director([], []) }, { text: 'You leave the question open.' }]
  await context.ctx.roleplayRuntime.play(context.id, intent(afterFailure, 'new-dialogue', 'Do not finish the stage; I want to discuss it.'), config)
  const current = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.equal(current.pending_ending, null)
  const beforeRejected = context.ctx.roleplayTestProvider.calls.length
  await assert.rejects(context.ctx.roleplayRuntime.play(context.id, {
    ...intent(current, 'expired-confirm'), confirm_ending: { proposal_id: proposal.id },
  }, config), { code: 'roleplay_runtime.ending_proposal_mismatch' })
  assert.equal((await context.ctx.roleplayRuntime.inspect(context.id)).revision, current.revision)
  assert.equal(context.ctx.roleplayTestProvider.calls.length, beforeRejected)
})

void test('proposal and confirmation failures publish no terminal state and exact retries never dispatch again', async (t) => {
  const context = await fixture(t, 'ending-failures')
  context.ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward', 'ending/departure']) }, { mode: 'failure' }]
  const failedProposal = await context.ctx.roleplayRuntime.play(context.id, intent(context.initial, 'failed-proposal'), config)
  assert.equal(failedProposal.settlement.status, 'failed')
  let current = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.equal(current.pending_ending, null)
  assert.equal(current.head, context.initial.head)
  const { proposal } = await propose(context, current, 'successful-proposal')
  current = await context.ctx.roleplayRuntime.inspect(context.id)
  const request = { ...intent(current, 'failed-confirm', 'Confirm this stage result.'), confirm_ending: { proposal_id: proposal.id } }
  context.ctx.roleplayTestProvider.replies = [{ mode: 'failure' }]
  const failed = await context.ctx.roleplayRuntime.play(context.id, request, config)
  assert.equal(failed.settlement.status, 'failed')
  const after = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.equal(after.head, current.head)
  assert.deepEqual(after.pending_ending, proposal)
  assert.equal(after.current.state.stopped, false)
  const calls = context.ctx.roleplayTestProvider.calls.length
  assert.deepEqual(await context.ctx.roleplayRuntime.play(context.id, request, config), failed)
  assert.equal(context.ctx.roleplayTestProvider.calls.length, calls)
})

void test('hidden and on-reach proposals expose only already-public player input', async (t) => {
  for (const reveal of ['hidden', 'on-reach'] as const) {
    const context = await fixture(t, `private-ending-${reveal}`, reveal)
    const { proposal } = await propose(context)
    assert.deepEqual(proposal.public, { triggering_input: 'I claim the token and would like to finish this stage.' })
    assert.ok(!JSON.stringify(proposal.public).includes('PRIVATE_ENDING'))
    assert.ok(!JSON.stringify(proposal.public).includes('judgments'))
  }
})

void test('historical atomic turn commands without confirmation metadata retain their original automatic ending semantics', async (t) => {
  const context = await fixture(t, 'legacy-auto-ending')
  const result = await context.ctx.roleplayRuntime.submit(context.id, { id: commandId('legacy-turn'),
    operation: { kind: 'turn', input: { text: 'An older automatically confirmed turn.' },
      actions: [{ kind: 'confirm', target: 'beat/reward' }, { kind: 'confirm', target: 'ending/departure' }],
      assessments: ['beat/reward', 'ending/departure'].map(target => ({ target, status: 'accepted', reason: 'confirmed' })),
    }, judgments: [{ ...endingJudgment, provider: { name: 'manual', version: '1' } }].map(({ confidence: _confidence, ...value }) => value),
  }, route)
  assert.equal(result.status, 'success')
  await context.reopen()
  const restored = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.equal(restored.current.state.stopped, true)
  assert.equal(restored.current.state.vars.count, 2)
  assert.equal(restored.pending_ending, null)
  assert.equal(replay(restored.log).digest, restored.head)
})

void test('new successful proposals replace their identifiers and cannot be confirmed through a stale proposal ID', async (t) => {
  const context = await fixture(t, 'replace-ending')
  const { current: before, proposal: previous } = await propose(context)
  context.ctx.roleplayTestProvider.replies = [{ text: director(['ending/departure']) }, { text: 'The revised result is ready to review.' }]
  await context.ctx.roleplayRuntime.play(context.id, intent(before, 'revised', 'I want to revise how this stage would finish.'), config)
  const current = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.ok(current.pending_ending)
  assert.notEqual(current.pending_ending.id, previous.id)
  assert.equal(current.pending_ending.public.triggering_input, 'I want to revise how this stage would finish.')
  const calls = context.ctx.roleplayTestProvider.calls.length
  await assert.rejects(context.ctx.roleplayRuntime.play(context.id, {
    ...intent(current, 'wrong-proposal'), confirm_ending: { proposal_id: previous.id },
  }, config), { code: 'roleplay_runtime.ending_proposal_mismatch' })
  assert.equal(context.ctx.roleplayTestProvider.calls.length, calls)
  assert.equal((await context.ctx.roleplayRuntime.inspect(context.id)).revision, current.revision)
})

void test('interrupted confirmation requires explicit recovery and never dispatches the old narration again', async (t) => {
  const context = await fixture(t, 'interrupted-confirmation')
  const { current: before, proposal } = await propose(context)
  const request = { ...intent(before, 'interrupted-confirm', 'Confirm this result.'), confirm_ending: { proposal_id: proposal.id } }
  const original = context.ctx.sessionPersistence.open.bind(context.ctx.sessionPersistence)
  let flushes = 0
  const mocked = t.mock.method(context.ctx.sessionPersistence, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args)
    if (args[1] !== 'write') return handle
    return {
      id: handle.id, header: handle.header, inheritedEventCount: handle.inheritedEventCount, access: handle.access,
      read: handle.read.bind(handle), append: handle.append.bind(handle),
      async flush() { if (++flushes === 2) throw new Error('confirmation durability failure'); await handle.flush() },
      close: handle.close.bind(handle), [Symbol.asyncDispose]: handle[Symbol.asyncDispose].bind(handle),
    }
  })
  const calls = context.ctx.roleplayTestProvider.calls.length
  await assert.rejects(context.ctx.roleplayRuntime.play(context.id, request, config), /confirmation durability failure/)
  mocked.mock.restore()
  assert.equal(context.ctx.roleplayTestProvider.calls.length, calls)
  await context.reopen()
  const interrupted = await context.ctx.roleplayRuntime.inspect(context.id)
  assert.equal(interrupted.pending_turn?.id, request.id)
  assert.deepEqual(interrupted.pending_ending, proposal)
  assert.equal(interrupted.current.state.stopped, false)
  await assert.rejects(context.ctx.roleplayRuntime.play(context.id, request, config), { code: 'roleplay_runtime.interrupted_retry_forbidden' })
  context.ctx.roleplayTestProvider.replies = [{ text: 'The stage now ends with your confirmed result.' }]
  const recovered = await context.ctx.roleplayRuntime.play(context.id, {
    ...intent(interrupted, 'recover-confirm', 'Confirm this result.'), recover_interrupted: true,
    confirm_ending: { proposal_id: proposal.id },
  }, config)
  assert.equal(recovered.settlement.status, 'success')
  const old = await context.ctx.roleplayRuntime.play(context.id, request, config)
  assert.equal(old.settlement.status, 'failed')
  assert.ok('reason' in old.settlement)
  assert.equal(old.settlement.reason, 'interrupted')
  assert.equal(context.ctx.roleplayTestProvider.calls.length, 1)
  assert.equal((await context.ctx.roleplayRuntime.inspect(context.id)).current.state.vars.count, 2)
})

void test('low-confidence or missing ending judgments never create a confirmable proposal', async (t) => {
  for (const confidence of [0.79, 0]) {
    const context = await fixture(t, `uncertain-ending-${confidence}`)
    context.ctx.roleplayTestProvider.replies = [{ text: director(['beat/reward', 'ending/departure'], confidence
      ? [{ ...endingJudgment, confidence }] : []) }, { text: 'You have a token; the final choice is still open.' }]
    const result = await context.ctx.roleplayRuntime.play(context.id, intent(context.initial, 'uncertain'), config)
    assert.equal(result.settlement.status, 'success')
    const current = await context.ctx.roleplayRuntime.inspect(context.id)
    assert.equal(current.pending_ending, null)
    assert.equal(current.current.state.stopped, false)
    assert.equal(current.current.state.vars.count, 1)
    assert.deepEqual(current.current.state.ended, [])
  }
})
