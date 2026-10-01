/** Pure Session-event tests; executed with Node's runner and the declared tsx/esm hook. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCreation, canonicalizeCreation, digestOf, lateSlotKey, PRESET_REGIONS } from '@char-pub/core'
import { commandId, commandPreparation, type ReplayInput } from '@deepseek-ai/dsh-experimental-charpub-roleplay'
import { prepareContext } from '@char-pub/assembler'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { makeOpened, makeRequested, makeSettled, projectRoleplay, requestMessages } from '../src/projection.ts'
import type { RoleplayRequested, RoleplaySettled } from '../src/events.ts'

const route = { provider: 'test', model: 'scripted', maxTokens: 256 }
function fixture(): ReplayInput {
  const policy = canonicalizeCreation({
    id: 'cr_01j00000000000000000000001', ref: '@test/policy', type: 'preset', display_name: 'Policy',
    meta: { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' },
    policy: { version: '1-draft', blocks: [{ id: 'system', text: 'Use concise dialogue.', default_at: 'main' }], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const release = 'rel_01j00000000000000000000001'
  const { artifact } = buildCreation({
    root: { release: 'rel_01j00000000000000000000000', visibility: 'private', creation: {
      id: 'cr_01j00000000000000000000000', ref: '@test/inn', type: 'scenario', display_name: 'Inn',
      meta: { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' },
      cast: [{ key: 'host', who: { late: 'character' } }],
      story: { version: 1, scenes: [{ id: 'lobby', title: 'Lobby', opening: 'The inn is quiet.' }],
        starts: [{ id: 'arrival', greeting: 'Welcome, {{user}}.' }],
        vars: { count: { type: 'int', init: 0, min: 0, max: 3, description: 'Count' } },
        endings: [{ id: 'leave', title: 'Leave', description: 'The visit ends', after: 'stop' }],
        beats: [{ id: 'reward', title: 'Reward', description: 'Gain a token', effects: [{ add: ['var/count', 1] }] }],
      },
    } },
    dependencies: [{ release, visibility: 'public', creation: policy.creation }],
    default_policy: { ref: policy.creation.ref, release, semantic_digest: policy.semantic_digest },
  })
  return { artifact, bindings: { user: { kind: 'persona', display_name: 'Sam' },
    [lateSlotKey('root', 'host')]: { kind: 'character', display_name: 'Host' } },
  profile: { runtime: { name: 'test', version: '1' }, tokenizer: 'estimate', mode: 'narrator', context_window: 8192,
    reserve_for_output: 1024, capabilities: { system_role: true, multiple_system_messages: true } },
  support: { supported: artifact.capabilities.map(value => value.id) }, source_texts: {},
  }
}
function opened(): SessionEvent[] {
  return [{ type: 'roleplay/opened', seq: SessionSeq(0), time: 0, data: makeOpened(fixture()) }]
}
function request(events: SessionEvent[], id = 'request-1'): RoleplayRequested {
  const data = makeRequested(projectRoleplay(events), id,
    { id: commandId(`command-${id}`), operation: { kind: 'confirm', target: 'beat/reward' }, selection: [] }, route)
  events.push({ type: 'roleplay/requested', seq: SessionSeq(events.length), time: events.length, data })
  return data
}
function stream(text = 'Here is your token.'): AssistantStreamRecord[] {
  return [
    { type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['Private reasoning'] },
    { type: 'text-chunks', time0: 2, index: 1, dt: [], texts: [text] },
    { type: 'chunk', time: 3, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ]
}
function settle(events: SessionEvent[], data: RoleplaySettled): void {
  events.push({ type: 'roleplay/settled', seq: SessionSeq(events.length), time: events.length, data })
}

await test('request events preserve model order without committing prospective Story facts', () => {
  const events = opened()
  const before = projectRoleplay(events)
  const proposed = request(events)
  const pending = projectRoleplay(events)
  assert.equal(pending.current.state.vars.count, 0)
  assert.equal(pending.head, before.head)
  assert.equal(pending.pending?.id, proposed.id)
  const messages = requestMessages(proposed)
  assert.deepEqual(messages.map(message => ({ role: message.role, content: message.content })),
    proposed.messages.map(message => ({ role: message.role, content: [{ type: 'text', text: message.content }] })))
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1)
  assert.deepEqual(requestMessages(proposed), messages)
  assert.ok(events.every(event => event.surfaceOp === undefined))
  assert.ok(proposed.messages.some(message => message.source.length > 0))
})

await test('only successful settlement commits effects and exact assistant history', () => {
  const events = opened()
  const proposed = request(events)
  const pending = projectRoleplay(events)
  const settled = makeSettled(pending, { status: 'success', assistant: { text: 'Here is your token.' }, stream: stream() })
  assert.equal(pending.current.state.vars.count, 0)
  settle(events, settled)
  const committed = projectRoleplay(events)
  assert.equal(committed.current.state.vars.count, 1)
  assert.equal(committed.current.turn.history.at(-1)?.text, 'Here is your token.')
  assert.equal(committed.current.turn.history.filter(message => message.text.includes('Welcome')).length, 1)
  assert.ok(committed.current.turn.history.every(message => !message.text.includes('Private reasoning')))
  assert.equal(committed.pending, null)
  assert.equal(committed.requests.get(proposed.id)?.request_digest, proposed.request_digest)
  assert.equal(committed.settlements.get(proposed.id)?.status, 'success')
  assert.deepEqual(projectRoleplay(JSON.parse(JSON.stringify(events)) as SessionEvent[]), committed)
  assert.equal(JSON.stringify(events).split('"artifact"').length - 1, 1)
  const next = makeRequested(committed, 'request-2', { id: commandId('command-2'), operation: { kind: 'input', text: 'Thank you.' }, selection: [] }, route)
  assert.equal(next.messages.filter(message => message.content === 'Here is your token.').length, 1)
  assert.equal(next.messages.filter(message => message.content === 'Thank you.').length, 1)
})

for (const status of ['cancelled', 'failed'] as const) {
  await test(`${status} settlement retains the committed state and cannot run the same command again`, () => {
    const events = opened()
    const before = projectRoleplay(events)
    const proposed = request(events)
    settle(events, makeSettled(projectRoleplay(events), { status, reason: 'Stopped', stream: [] }))
    const result = projectRoleplay(events)
    assert.equal(result.head, before.head)
    assert.equal(result.current.state.vars.count, 0)
    assert.deepEqual(result.current.turn, before.current.turn)
    assert.equal(result.pending, null)
    assert.throws(() => makeRequested(result, 'different-attempt', proposed.command, route), { code: 'roleplay.command_reused' })
  })
}

await test('a restored uncompleted request stays pending and blocks a second request', () => {
  const events = opened()
  request(events)
  const restored = projectRoleplay(JSON.parse(JSON.stringify(events)) as SessionEvent[])
  assert.ok(restored.pending)
  assert.equal(restored.current.state.vars.count, 0)
  assert.throws(() => makeRequested(restored, 'next', { id: commandId('next'), operation: { kind: 'prepare' } }, route), { code: 'roleplay.request_pending' })
})

await test('rejects edited request messages, config/hash, settled state and assistant text', () => {
  const events = opened()
  request(events)
  const success = makeSettled(projectRoleplay(events), { status: 'success', assistant: { text: 'Here is your token.' }, stream: stream() })
  settle(events, success)
  for (const changed of ['message', 'route', 'proposed-route', 'state', 'assistant']) {
    const copy = structuredClone(events)
    const req = copy[1]
    const done = copy[2]
    if (req?.type !== 'roleplay/requested' || done?.type !== 'roleplay/settled' || done.data.status !== 'success') throw new Error('missing events')
    if (changed === 'message' && req.data.messages[0]) req.data.messages[0].content = 'changed'
    if (changed === 'route') req.data.config.model = 'changed'
    if (changed === 'proposed-route') req.data.proposed_config.model = 'changed'
    if (changed === 'state') done.data.state.vars.count = 2
    if (changed === 'assistant') done.data.assistant.text = 'Changed reply'
    assert.throws(() => projectRoleplay(copy))
  }
  assert.throws(() => projectRoleplay([events[0]!, events[2]!]), { code: 'roleplay.request_missing' })
})

await test('text-only settlement requires explicit stop and rejects tool/image content and wrong usage', () => {
  const events = opened()
  request(events)
  const projection = projectRoleplay(events)
  const plain = stream()
  assert.throws(() => makeSettled(projection, { status: 'success', assistant: { text: 'Here is your token.' }, stream: plain.slice(0, -1) }), { code: 'roleplay.incomplete_generation' })
  const incomplete: AssistantStreamRecord[] = [...plain.slice(0, -1), { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }]
  assert.throws(() => makeSettled(projection, { status: 'success', assistant: { text: 'Here is your token.' }, stream: incomplete }), { code: 'roleplay.incomplete_generation' })
  for (const blockType of ['image', 'tool-call'] as const) {
    const unsupported: AssistantStreamRecord[] = [{ type: 'chunk', time: 0, chunk: { type: 'block-start', index: 4, blockType } }, ...plain]
    assert.throws(() => makeSettled(projection, { status: 'success', assistant: { text: 'Here is your token.' }, stream: unsupported }), { code: 'roleplay.unsupported_message' })
  }
  assert.throws(() => makeSettled(projection, { status: 'success', assistant: { text: 'Here is your token.' }, stream: plain, usage: { inputTokens: 1, outputTokens: 2 } }), { code: 'roleplay.usage_mismatch' })
  assert.equal(digestOf(projectRoleplay(events).current.state), digestOf(projection.current.state))
})

await test('records the caller route separately from provider-resolved defaults', () => {
  const projection = projectRoleplay(opened())
  const action = { id: commandId('routing'), operation: { kind: 'prepare' as const } }
  const requested = makeRequested(projection, 'resolved', action,
    { provider: 'test', model: 'resolved-model', maxTokens: 256 },
    { provider: 'test', model: 'requested-alias' })
  assert.equal(requested.config.model, 'resolved-model')
  assert.deepEqual(requested.proposed_config, { provider: 'test', model: 'requested-alias' })
  const different = makeRequested(projection, 'resolved', action,
    { provider: 'test', model: 'resolved-model', maxTokens: 256 },
    { provider: 'test', model: 'another-alias' })
  assert.notEqual(requested.request_digest, different.request_digest)
})

await test('allows the ending response once, then refuses generation while retaining preview access', () => {
  const events = opened()
  const requested = makeRequested(projectRoleplay(events), 'ending', {
    id: commandId('end-story'), operation: { kind: 'confirm', target: 'ending/leave' },
  }, route)
  events.push({ type: 'roleplay/requested', seq: SessionSeq(events.length), time: 1, data: requested })
  assert.equal(projectRoleplay(events).current.state.stopped, false)
  settle(events, makeSettled(projectRoleplay(events), {
    status: 'success', assistant: { text: 'Goodbye.' }, stream: stream('Goodbye.'),
  }))
  const result = projectRoleplay(events)
  assert.equal(result.current.state.stopped, true)
  assert.equal(result.current.turn.history.at(-1)?.text, 'Goodbye.')
  const query = { id: commandId('after-end'), operation: { kind: 'prepare' as const } }
  assert.throws(() => makeRequested(result, 'after-end', query, route), { code: 'roleplay.session_stopped' })
  const preview = prepareContext(commandPreparation(result.log, query))
  assert.ok(preview.messages.some(message => message.content === 'Goodbye.'))
})

await test('success and recovery reject post-finish data and repeated finish chunks', () => {
  const events = opened()
  request(events)
  const pending = projectRoleplay(events)
  const valid = makeSettled(pending, { status: 'success', assistant: { text: 'Here is your token.' }, stream: stream() })
  const earlyFinish: AssistantStreamRecord = { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }
  const extraFinish: AssistantStreamRecord = { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'stop' } } }
  const malformed = [[earlyFinish, ...stream().slice(0, -1)], [...stream(), extraFinish]]
  for (const invalid of malformed) {
    assert.throws(() => makeSettled(pending, { status: 'success', assistant: { text: 'Here is your token.' }, stream: invalid }), { code: 'roleplay.stream_after_finish' })
    const recovered = structuredClone(events)
    settle(recovered, { ...valid, stream: invalid })
    assert.throws(() => projectRoleplay(recovered), { code: 'roleplay.stream_after_finish' })
  }
})
