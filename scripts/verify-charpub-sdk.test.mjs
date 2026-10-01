/** Snapshot checks use detached files so rejection tests cannot corrupt retained SDK bytes. */
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { verifyCharpubSdk } from './verify-charpub-sdk.mjs'

const repository = new URL('../', import.meta.url)

test('snapshot verification binds consumers and rejects tampered active or historical bytes', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'charpub-snapshot-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = pathToFileURL(`${temporary}/`)
  for (const path of ['third_party/charpub', 'pnpm-workspace.yaml',
    'packages/experimental/charpub-roleplay/package.json',
    'packages/experimental/charpub-roleplay-runtime/package.json']) {
    await cp(new URL(path, repository), new URL(path, root), { recursive: true })
  }
  const current = await verifyCharpubSdk(root)
  for (const [path, pattern, mutate] of [
    ['packages/experimental/charpub-roleplay/package.json', /inactive SDK snapshot/,
      text => text.replaceAll(`${current}/`, '')],
    ['packages/experimental/charpub-roleplay-runtime/package.json', /inactive SDK snapshot/,
      text => text.replace(`charpub/${current}/tarballs/char-pub-contracts`, 'charpub/tarballs/char-pub-contracts')],
    [`third_party/charpub/${current}/manifest.json`, /active manifest digest mismatch/, text => `${text} `],
    [`third_party/charpub/${current}/tarballs/char-pub-core-0.0.0.tgz`, /size mismatch/, bytes => Buffer.concat([bytes, Buffer.from('x')])],
    ['third_party/charpub/tarballs/char-pub-core-0.0.0.tgz', /size mismatch/, bytes => Buffer.concat([bytes, Buffer.from('x')])],
  ]) {
    const file = new URL(path, root)
    const before = await readFile(file)
    await writeFile(file, mutate(path.endsWith('.json') ? before.toString() : before))
    await assert.rejects(verifyCharpubSdk(root), pattern)
    await writeFile(file, before)
  }
  assert.equal(await verifyCharpubSdk(root), current)
})
