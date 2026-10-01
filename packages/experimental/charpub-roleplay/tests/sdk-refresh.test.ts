/** Independent packed-SDK consumer: indirect role instances and editorial associations in real messages. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCreation, canonicalizeCreation, PRESET_REGIONS } from '@char-pub/core'
import type { CreationInput, ReleaseInput } from '@char-pub/core'
import { createReplay, replay } from '../src/index.ts'

const meta = { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' } as const
function published(n: number, creation: CreationInput): ReleaseInput {
  return {
    release: `rel_01h455vb4pex5vsknk084sn0${n.toString().padStart(2, '0')}`,
    visibility: 'public', creation, semantic_digest: canonicalizeCreation(creation).semantic_digest,
  }
}
function reference(id: string, target: ReleaseInput) {
  const canonical = canonicalizeCreation(target.creation)
  return { id, use: canonical.creation.ref, mode: 'default' as const,
    pin: { release: target.release, semantic_digest: canonical.semantic_digest } }
}
function inputArtifact() {
  const guard = published(1, {
    id: 'cr_01h455vb4pex5vsknk084sn001', ref: '@sdk/guard', type: 'character', display_name: 'Guard', meta,
    fragments: [
      { id: 'identity', kind: 'character', stable: true, content: { type: 'text', text: 'I guard the bridge.' } },
      { id: 'secret', kind: 'knowledge', stable: true, visibility: { scope: 'private', to: ['{{self}}'] },
        content: { type: 'text', text: 'ORIGINAL_PRIVATE' } },
    ],
  })
  const world = published(2, {
    id: 'cr_01h455vb4pex5vsknk084sn002', ref: '@sdk/world', type: 'world', display_name: 'World', meta,
    references: [reference('guard', guard)],
    fragments: [{ id: 'world', kind: 'world', stable: true, content: { type: 'text', text: 'The bridge crosses the river.' } }],
  })
  const other = published(3, {
    id: 'cr_01h455vb4pex5vsknk084sn003', ref: '@sdk/archive', type: 'lorebook', display_name: 'Archive', meta,
    fragments: [{ id: 'candidate', kind: 'knowledge', stable: true, description: 'Old bridge records', activation: { mode: 'semantic' },
      content: { type: 'text', text: 'UNSELECTED_ARCHIVE_BODY' } }],
  })
  const policy = published(4, {
    id: 'cr_01h455vb4pex5vsknk084sn004', ref: '@sdk/policy', type: 'preset', display_name: 'Policy', meta,
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const root = published(5, {
    id: 'cr_01h455vb4pex5vsknk084sn005', ref: '@sdk/scene', type: 'scenario', display_name: 'Bridge', meta,
    references: [reference('world', world), reference('archive', other)],
    cast: ['north', 'south'].map(key => ({ key, who: '@sdk/guard', override: [
      { op: 'replace', target: 'secret', content: { type: 'text', text: `${key.toUpperCase()}_PRIVATE` } },
    ] })),
    fragments: [{ id: 'topic', kind: 'scenario', stable: true, about: ['@sdk/archive#candidate'],
      content: { type: 'text', text: 'Ask about the bridge.' } }],
    story: { version: 1, scenes: [{ id: 'bridge', title: 'Bridge', cast: ['north', 'south'] }] },
  })
  const artifact = buildCreation({ root, dependencies: [guard, world, other, policy], default_policy: {
    ref: '@sdk/policy', release: policy.release, semantic_digest: canonicalizeCreation(policy.creation).semantic_digest,
  } }).artifact
  if (artifact.kind !== 'content') throw new Error('expected content artifact')
  return artifact
}

void test('indirect repeated Character has two real role identities and private override messages remain isolated', () => {
  assert.match(import.meta.resolve('@char-pub/core'), /\/dist\/index\.js$/)
  const artifact = inputArtifact()
  const guardParticipants = artifact.ir.participants.filter(participant => participant.ref === '@sdk/guard')
  assert.equal(guardParticipants.length, 2, 'the reference template must not create a third phantom Guard')
  assert.equal(new Set(guardParticipants.map(participant => participant.key)).size, 2)
  assert.equal(artifact.ir.graph.cast_edges?.length, 2)
  for (const key of ['north', 'south']) {
    const log = createReplay({
      artifact,
      profile: { runtime: { name: 'packed-sdk-test', version: '1' }, tokenizer: 'estimate', context_window: 8192,
        reserve_for_output: 512, mode: 'per-agent', capabilities: { system_role: true, multiple_system_messages: true } },
      bindings: { user: { kind: 'persona', display_name: 'Visitor' } },
      support: { supported: artifact.capabilities.map(capability => capability.id) },
      source_texts: {}, for_participant: key,
    })
    const current = replay(JSON.parse(JSON.stringify(log))).current
    const messages = current.assembly.messages.map(message => message.content).join('\n')
    assert.ok(messages.includes(`${key.toUpperCase()}_PRIVATE`))
    assert.ok(!messages.includes(`${key === 'north' ? 'SOUTH' : 'NORTH'}_PRIVATE`))
    assert.ok(!messages.includes('ORIGINAL_PRIVATE'))
    assert.ok(messages.includes('The bridge crosses the river.'))
    assert.ok(messages.includes('Ask about the bridge.'))
    assert.ok(!messages.includes('UNSELECTED_ARCHIVE_BODY'), 'about is an editorial relation, not a selection decision')
    assert.equal(artifact.catalog_index.about?.length, 1)
    const own = artifact.ir.graph.instances.find(instance => instance.cast?.key === key && instance.cast.scope === 'root')
    assert.ok(own?.cast?.introduced_by)
    const secret = artifact.ir.fragments.find(fragment => fragment.origin.instance_key === own.key && fragment.origin.fragment === 'secret')
    assert.ok(secret)
    assert.ok(current.assembly.messages.flatMap(message => message.source).includes(secret.id))
  }
})

void test('packed SDK preserves saved fixture Source bytes and OAuth client origin while rerunning actual messages', async () => {
  const { ASSEMBLER, TOKENIZER_VERSIONS, createPreparationCatalog, fixedSelection, prepareContext, digestAssemblyMessages, runAssemblyTests } = await import('@char-pub/assembler')
  const { sha256Bytes } = await import('@char-pub/core')
  const text = '\uFEFF# Cafe\u0301  \r\nSelected detail\t\r\n# Other\r\nNot selected \r\n'
  const policy = published(10, {
    id: 'cr_01h455vb4pex5vsknk084sn010', ref: '@sdk/raw-policy', type: 'preset', display_name: 'Policy', meta,
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const creation: CreationInput = {
    id: 'cr_01h455vb4pex5vsknk084sn011', ref: '@sdk/raw-source', type: 'character', display_name: 'Archivist', meta,
    provenance: { client_id: 'registered-runtime', contributors: [{ author: 'usr_01h455vb4pex5vsknk084sn001', client_id: 'contributing-runtime' }] },
    fragments: [{ id: 'identity', kind: 'character', stable: true, content: { type: 'text', text: 'An archivist.' } }],
    assets: [{ slot: 'book', role: 'context', variants: [{ id: 'default', media_type: 'text/markdown', blob: { availability: 'mirrored', size: new TextEncoder().encode(text).length, digest: sha256Bytes(new TextEncoder().encode(text)) } }] }],
    sources: [{ id: 'book', title: 'Archive', description: 'Original records', format: 'markdown', asset: 'book', visibility: { scope: 'shared' }, sections: [{ id: 'selected', title: 'Selected', description: 'Selected records', anchor: '#Café' }] }],
  }
  const input = { root: published(11, creation), dependencies: [policy], default_policy: { ref: '@sdk/raw-policy', release: policy.release, semantic_digest: canonicalizeCreation(policy.creation).semantic_digest } }
  const artifact = buildCreation(input).artifact
  assert.equal(artifact.kind, 'content')
  if (artifact.kind !== 'content') throw new Error('expected content')
  assert.equal(artifact.meta.contributors?.[0]?.client_id, 'contributing-runtime')
  assert.equal(artifact.ir.meta.contributors?.[0]?.client_id, 'contributing-runtime')
  const source = artifact.catalog_index.sources[0]
  assert.ok(source)
  const profile = { runtime: { name: 'sdk-refresh', version: '1' }, tokenizer: 'estimate', context_window: 4096, reserve_for_output: 512, mode: 'narrator' as const, capabilities: { system_role: true, multiple_system_messages: true } }
  const turn = { bindings: { user: { kind: 'persona' as const, display_name: 'Reader' } }, history: [{ role: 'user' as const, text: 'Cafe\u0301 \r\nExact user history\t' }] }
  const selection = [{ source: source.id, section: 'selected' }]
  const source_texts = { [source.asset]: text }
  const preparation = { artifact, profile, turn }
  const plan = fixedSelection(createPreparationCatalog(preparation), selection)
  const messages = prepareContext({ ...preparation, plan, source_texts }).messages
  assert.ok(JSON.stringify(messages).includes('Selected detail'))
  assert.ok(!JSON.stringify(messages).includes('Not selected'))
  const fixture = { id: 'raw-source', root: 'self' as const, profile, session: turn, selection, source_texts,
    assembler: ASSEMBLER, tokenizer: { name: 'estimate', version: TOKENIZER_VERSIONS.estimate }, expected: { kind: 'success' as const, messages_digest: digestAssemblyMessages(messages) } }
  const canonical = canonicalizeCreation({ ...creation, assembly_tests: [fixture] })
  const stored = canonicalizeCreation(JSON.parse(JSON.stringify(canonical.json)))
  assert.equal(stored.creation.assembly_tests?.[0]?.source_texts?.[source.asset], text)
  assert.deepEqual(stored.creation.assembly_tests?.[0]?.session, turn)
  assert.equal(stored.creation.provenance?.client_id, 'registered-runtime')
  assert.equal(stored.creation.provenance?.contributors?.[0]?.client_id, 'contributing-runtime')
  const result = await runAssemblyTests({
    ...input, root: { ...input.root, creation: stored.json, semantic_digest: stored.semantic_digest },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.results[0]?.messages_digest, fixture.expected.messages_digest)
})
