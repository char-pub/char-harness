/** Verify retained SDK bytes and the active dependency paths before roleplay installation. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { load } from 'js-yaml'

const packageNames = ['@char-pub/core', '@char-pub/assembler', '@char-pub/contracts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async url => JSON.parse(await readFile(url, 'utf8'))

async function verifySnapshot(directory) {
  const bytes = await readFile(new URL('manifest.json', directory))
  const manifest = JSON.parse(bytes)
  assert.equal(manifest.format, 1)
  assert.match(manifest.source_revision, /^[a-f0-9]{40}$/)
  assert.equal(typeof manifest.source_dirty, 'boolean')
  assert.deepEqual(manifest.packages.map(item => item.name), packageNames)
  for (const item of manifest.packages) {
    assert.match(item.version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
    assert.equal(item.file, `${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`)
    assert.equal(item.license, 'Apache-2.0')
    const tarball = await readFile(new URL(`tarballs/${item.file}`, directory))
    assert.equal(tarball.length, item.bytes, `${item.name}: size mismatch`)
    assert.equal(hash(tarball), item.sha256, `${item.name}: digest mismatch`)
  }
  return { manifest, digest: hash(bytes) }
}

/**
 * Check every retained snapshot and require all consumers to select the active bytes.
 * @param root - Harness repository directory URL, with trailing slash.
 * @returns The verified active snapshot directory, relative to third_party/charpub.
 */
export async function verifyCharpubSdk(root) {
  const base = new URL('third_party/charpub/', root)
  const current = await json(new URL('current.json', base))
  assert.deepEqual(Object.keys(current).sort(), ['directory', 'manifest_sha256'])
  assert.match(current.directory, /^snapshots\/[a-z0-9][a-z0-9-]*$/)
  assert.match(current.manifest_sha256, /^[a-f0-9]{64}$/)
  const directory = new URL(`${current.directory}/`, base)
  const active = await verifySnapshot(directory)
  assert.equal(active.digest, current.manifest_sha256, 'active manifest digest mismatch')
  await verifySnapshot(base)
  for (const entry of await readdir(new URL('snapshots/', base), { withFileTypes: true })) {
    assert.ok(entry.isDirectory(), `unexpected snapshot entry: ${entry.name}`)
    if (`snapshots/${entry.name}` !== current.directory)
      await verifySnapshot(new URL(`snapshots/${entry.name}/`, base))
  }
  const workspace = load(await readFile(new URL('pnpm-workspace.yaml', root), 'utf8'))
  const consumers = await Promise.all(['charpub-roleplay', 'charpub-roleplay-runtime'].map(async name => {
    const url = new URL(`packages/experimental/${name}/`, root)
    return { url, manifest: await json(new URL('package.json', url)) }
  }))
  for (const item of active.manifest.packages) {
    const target = fileURLToPath(new URL(`tarballs/${item.file}`, directory))
    const check = (value, relativeTo, subject) => {
      assert.equal(typeof value, 'string', `${subject}: missing SDK dependency`)
      assert.ok(value.startsWith('file:'), `${subject}: expected a packed file dependency`)
      assert.equal(resolve(fileURLToPath(relativeTo), value.slice(5)), target, `${subject}: inactive SDK snapshot`)
    }
    check(workspace.overrides[item.name], root, `overrides ${item.name}`)
    for (const consumer of consumers) {
      if (item.name !== '@char-pub/contracts' || consumer.manifest.dependencies[item.name] !== undefined)
        check(consumer.manifest.dependencies[item.name], consumer.url, `${consumer.manifest.name} ${item.name}`)
    }
  }
  return current.directory
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const active = await verifyCharpubSdk(new URL('../', import.meta.url))
  console.log(`Verified retained char.pub SDK snapshots; active ${active}`)
}
