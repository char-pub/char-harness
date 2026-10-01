/** Fixed old SDK bytes, not fixtures rebuilt by the SDK under test. No network or source-log writes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { replay, ReplayCommandSchema } from '../../charpub-roleplay/src/index.ts'
import { requestMessages } from '../src/index.ts'
import { historyLoader } from './fixtures/history-loader.ts'
import { captureHistory, captureSnapshotHistory } from './fixtures/capture-history.ts'

for (const preserved of [
  { name: 'pre-registry-sdk', digest: '76b74c335bf2800c21d6d63f4bf4e582c86e80e4654f356fd5d8e0ccd723c264' },
  { name: 'legacy-sdk-280c696c', digest: 'db75378c6f4b66385834463507a38c9b78e583304458e018116f6b1ef4d8ac2e' },
  { name: 'pre-source-fixture-sdk', digest: '461aaf2a3d751d84a350cc655c3a4bd7dbd0714f2ada8583b452345e334f3f1e' },
]) {
  const fixture = new URL(`./fixtures/${preserved.name}/`, import.meta.url)
  const manifestBytes = await readFile(new URL('manifest.json', fixture))
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), preserved.digest)
  const manifest = z.object({
    sdk: z.object({ packages: z.array(z.object({ sha256: z.string() })).min(1) }),
    files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })),
    session_id: z.string(), head: z.string(), pending: z.unknown(), call: z.unknown(),
    expected_messages: z.unknown(),
  }).parse(JSON.parse(manifestBytes.toString('utf8')))
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  async function verifiedBytes(file: string) {
    const receipt = manifest.files.find((entry: { path: string }) => entry.path === file)
    assert.ok(receipt, `missing immutable fixture receipt: ${file}`)
    const bytes = await readFile(new URL(file, fixture))
    assert.equal(bytes.length, receipt.bytes)
    assert.equal(sha256(bytes), receipt.sha256)
    return bytes
  }

  void test(`${preserved.name}: packed-SDK Replay reconstructs recorded state without rebuilding its artifact`, async () => {
    if (preserved.name === 'legacy-sdk-280c696c') assert.equal(manifest.sdk.packages[0]?.sha256, '280c696cc64b64929d422f21a8dd59a1322f2bacec8724eb61609e7639ff1675')
    const bytes = await verifiedBytes('replay.json')
    const result = replay(JSON.parse(bytes.toString('utf8')))
    assert.equal(result.digest, manifest.head)
    assert.equal(result.current.state.vars.count, 1)
    assert.equal(result.current.state.scene, 'garden')
    assert.deepEqual(result.current.turn.history.map(item => item.text), [
      'ようこそ、Guest。', 'The innkeeper nods.', 'The innkeeper nods.',
    ])
    assert.deepEqual(await verifiedBytes('replay.json'), bytes)
  })

  void test(`${preserved.name}: real JSONL reads unchanged, then interrupts a pending request on a temporary copy without dispatch`, async () => {
    const file = 'sessions/_no-cwd/legacy-sdk-history/session.v4.jsonl'
    const original = await verifiedBytes(file)
    const root = await mkdtemp(join(tmpdir(), 'charpub-history-read-'))
    try {
      await cp(fileURLToPath(new URL('sessions', fixture)), join(root, 'sessions'), { recursive: true, errorOnExist: true, force: false })
      const ctx = await historyLoader(root)
      try {
        const id = SessionId(manifest.session_id)
        const restored = await ctx.roleplayRuntime.inspect(id)
        assert.equal(restored.head, manifest.head)
        assert.equal(restored.current.state.vars.count, 1)
        assert.equal(restored.pending?.command.id, 'pending')
        assert.deepEqual([...restored.requests.values()].slice(0, 2).map(requestMessages), manifest.expected_messages)
        assert.equal(ctx.roleplayTestProvider.calls.length, 0)
        // Read-only recovery must not rewrite even the isolated copy of an already committed generation.
        assert.deepEqual(await readFile(join(root, file)), original)
        const call = z.strictObject({
          provider: z.string(), model: z.string(), maxTokens: z.number().int().positive(),
        }).parse(manifest.call)
        const outcome = await ctx.roleplayRuntime.submit(id, ReplayCommandSchema.parse(manifest.pending), call)
        assert.equal(outcome.status, 'failed')
        if (outcome.status === 'failed') assert.equal(outcome.reason, 'interrupted')
        assert.equal(ctx.roleplayTestProvider.calls.length, 0)
        assert.equal((await ctx.roleplayRuntime.inspect(id)).current.state.vars.count, 1)
        assert.deepEqual(await verifiedBytes(file), original)
      } finally { await ctx.fiber.dispose() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  void test(`${preserved.name}: legacy capture rejects a different installed SDK before creating its destination`, {
    skip: import.meta.resolve('@char-pub/core').includes('file+third_party+charpub+tarballs+'),
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'charpub-capture-reject-'))
    const destination = join(root, 'must-not-exist')
    try {
      await assert.rejects(captureHistory(destination), /Capture requires the original installed SDK locator/)
      await assert.rejects(access(destination), { code: 'ENOENT' })
      await verifiedBytes('replay.json')
      await verifiedBytes('sessions/_no-cwd/legacy-sdk-history/session.v4.jsonl')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

void test('named snapshot capture refuses the upgraded installation before creating any output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'charpub-snapshot-capture-reject-'))
  const destination = join(root, 'must-not-exist')
  try {
    await assert.rejects(captureSnapshotHistory(destination, 'snapshots/story-v1-bb93d2171b49cf91', 'bb93d2171b49cf91f9974f214867d3fe219b600baadf9b0f0dde5c8e83befe80'), /Capture requires the requested installed SDK locator/)
    await assert.rejects(access(destination), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
