/** Plain Node consumer: compiled Harness exports and external SDK tarballs only. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCreation, createLocalBuildInput, canonicalizeCreation, lateSlotKey, PRESET_REGIONS } from '@char-pub/core'
import { createReplay, appendCommand, commandId, replay } from '@deepseek-ai/dsh-experimental-charpub-roleplay'

for (const local of [false, true]) test(`compiled ESM replays ${local ? 'local' : 'published'} content without a TypeScript loader`, () => {
  assert.match(import.meta.resolve('@deepseek-ai/dsh-experimental-charpub-roleplay'), /\/lib\/index\.js$/)
  assert.match(import.meta.resolve('@char-pub/core'), /\/dist\/index\.js$/)
  const meta = { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' }
  const policy = canonicalizeCreation({
    id: 'cr_01j00000000000000000000001', ref: '@smoke/policy', type: 'preset', display_name: 'Smoke policy', meta,
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const pin = { ref: policy.creation.ref, release: 'rel_01j00000000000000000000001', semantic_digest: policy.semantic_digest }
  const buildInput = {
    root: {
      release: 'rel_01j00000000000000000000002', visibility: 'public',
      creation: {
        id: 'cr_01j00000000000000000000002', ref: '@smoke/inn', type: 'scenario', display_name: 'Inn', meta,
        cast: [{ key: 'host', who: { late: 'character' } }],
        story: {
          version: 1,
          scenes: [{ id: 'inn', title: 'Rainy inn' }],
          starts: [{ id: 'arrival', greeting: 'The rain falls outside.' }],
          vars: { tokens: { type: 'int', min: 0, max: 3, init: 0, description: 'Tokens earned' } },
          beats: [{ id: 'help', title: 'Help', description: 'Help the innkeeper', effects: [{ add: ['var/tokens', 1] }] }],
        },
      },
    },
    dependencies: [{ ...pin, visibility: 'public', creation: policy.creation }],
    default_policy: pin,
  }
  const { artifact } = buildCreation(local ? createLocalBuildInput(buildInput) : buildInput)
  const initial = createReplay({
    artifact,
    profile: { runtime: { name: 'built-smoke', version: '1' }, tokenizer: 'estimate', context_window: 8192, reserve_for_output: 1024, mode: 'narrator', capabilities: { system_role: true, multiple_system_messages: true } },
    bindings: { user: { kind: 'persona', display_name: 'Guest' }, [lateSlotKey('root', 'host')]: { kind: 'character', display_name: 'Host' } },
    support: { supported: artifact.capabilities.map(capability => capability.id) },
    source_texts: {},
  })
  const command = { id: commandId('help-once'), operation: { kind: 'confirm', target: 'beat/help' }, selection: [] }
  const log = appendCommand(initial, command)
  assert.equal(appendCommand(log, command), log)
  const result = replay(JSON.parse(JSON.stringify(log)))
  assert.equal(result.current.state.vars.tokens, 1)
  assert.deepEqual(result.current.state.reached, ['help'])
  assert.deepEqual(result.current.assembly.messages.filter(message => message.role === 'assistant'), [
    { role: 'assistant', content: 'The rain falls outside.', source: ['history'] },
  ])
  assert.deepEqual(result, replay(log))
  assert.equal(result.current.assembly.trace.ir.semantic_digest, artifact.root.semantic_digest)
  if (local) {
    assert.equal(result.current.assembly.trace.ir.origin.kind, 'local-build')
    assert.deepEqual(result.current.assembly.trace.ir.origin, artifact.root.origin)
    assert.equal('release' in artifact.root, false)
  } else assert.equal(result.current.assembly.trace.ir.release, artifact.root.release)
})
