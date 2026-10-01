/** Shared published-artifact exercise inputs; no model or network setup. */
import { buildCreation, createLocalBuildInput, canonicalizeCreation, lateSlotKey, PRESET_REGIONS, sha256Hex } from '@char-pub/core'
import type { BuildCreationInput } from '@char-pub/core'
import { commandId } from '../src/index.ts'
import type { ReplayCommand, ReplayInput } from '../src/index.ts'

export const SOURCE = 'A hidden service tunnel connects the inn to the river.'
export function replayInput(mode: 'narrator' | 'per-agent' = 'narrator', options: { catalog?: boolean; origin?: 'local' | 'draft' } = {}): ReplayInput {
  const policy = canonicalizeCreation({
    id: 'cr_01j00000000000000000000001', ref: '@fixture/policy', type: 'preset', display_name: 'Fixture policy',
    meta: { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' },
    policy: { version: '1-draft', blocks: [], layout: [...PRESET_REGIONS], requires: { system_role: true } },
  })
  const release = 'rel_01j00000000000000000000001'
  const buildInput: BuildCreationInput = {
    root: {
      release: 'rel_01j00000000000000000000000', visibility: 'public',
      creation: {
        id: 'cr_01j00000000000000000000000', ref: '@fixture/inn', type: 'scenario', display_name: 'Rainy Inn',
        meta: { default_locale: 'en', rating: 'general', rights: 'original', license: 'CC0-1.0' },
        cast: [{ key: 'alice', who: { late: 'character' } }, { key: 'bob', who: { late: 'character' } }],
        fragments: [
          { id: 'secret', kind: 'knowledge', stable: true, content: { type: 'text', text: 'ALICE_ONLY_SECRET' } },
          ...(options.catalog ? ['tunnel', 'market'].map(id => ({
            id, kind: 'knowledge' as const, stable: true, selectable: true,
            description: `${id} relevance description`, activation: { mode: 'keyword' as const, keys: [`unmatched-${id}`] },
            content: { type: 'text' as const, text: `${id.toUpperCase()}_CANDIDATE_BODY` },
          })) : []),
        ],
        ...(options.catalog ? { groups: [
          { id: 'city', title: 'City', description: 'Places near the inn', groups: ['district'] },
          { id: 'district', title: 'District', description: 'Local routes and trade', entries: ['tunnel', 'market'] },
        ] } : {}),
        sources: [{ id: 'guide', title: 'Inn guide', description: 'Paths around the inn', asset: 'guide', format: 'text', visibility: { scope: 'shared' } }],
        assets: [{ slot: 'guide', role: 'context', variants: [{ id: 'default', media_type: 'text/plain', blob: { digest: `sha256:${sha256Hex(SOURCE)}`, size: new TextEncoder().encode(SOURCE).byteLength, availability: 'mirrored' } }] }],
        story: {
          version: 1,
          vars: { count: { type: 'int', min: 0, max: 3, init: 0, description: 'Confirmed rewards' } },
          scenes: [{ id: 'lobby', title: 'Lobby' }, { id: 'garden', title: 'Garden', cast: ['alice'] }],
          starts: [{ id: 'arrival', scene: 'lobby', greeting: { en: 'Welcome, {{user}}.', ja: 'ようこそ、{{user}}。' } }],
          beats: [
            { id: 'reward', title: 'Reward', description: 'Gain one token', effects: [{ add: ['var/count', 1] }] },
            { id: 'refusal', title: 'Refusal', description: 'The guest refuses', when: { not: { judge: 'Did the guest agree?' } }, effects: [{ add: ['var/count', 1] }] },
          ],
          knowing: { '#secret': { start: { knows: ['alice'], not: ['bob'] } } },
        },
      },
    },
    dependencies: [{ release, visibility: 'public', creation: policy.creation, semantic_digest: policy.semantic_digest }],
    default_policy: { ref: policy.creation.ref, release, semantic_digest: policy.semantic_digest },
  }
  if (options.origin === 'draft') {
    buildInput.root = { creation: buildInput.root.creation, visibility: 'private', origin: {
      kind: 'draft-build', build_id: 'dbld_01j00000000000000000000000',
      revision: 'rev_01j00000000000000000000000', expires_at: '2026-10-08T00:00:00Z',
    } }
  }
  const { artifact } = buildCreation(options.origin === 'local' ? createLocalBuildInput(buildInput) : buildInput)
  if (artifact.kind !== 'content') throw new Error('expected content')
  const source = artifact.catalog_index.sources[0]
  if (!source) throw new Error('expected source')
  return {
    artifact,
    profile: { runtime: { name: 'offline-roleplay', version: '1' }, tokenizer: 'estimate', context_window: 8192, reserve_for_output: 1024, mode, locale: 'ja', capabilities: { system_role: true, multiple_system_messages: true } },
    bindings: {
      user: { kind: 'persona', display_name: 'Guest' },
      [lateSlotKey('root', 'alice')]: { kind: 'character', display_name: 'Alice' },
      [lateSlotKey('root', 'bob')]: { kind: 'character', display_name: 'Bob' },
    },
    support: { supported: artifact.capabilities.map(capability => capability.id) },
    source_texts: { [source.asset]: SOURCE },
    ...(mode === 'per-agent' ? { for_participant: 'alice' } : {}),
  }
}
export function command(id: string, operation: ReplayCommand['operation'], extra: Partial<ReplayCommand> = {}): ReplayCommand {
  return { id: commandId(id), operation, ...(extra.plan === undefined ? { selection: [] } : {}), ...extra }
}
