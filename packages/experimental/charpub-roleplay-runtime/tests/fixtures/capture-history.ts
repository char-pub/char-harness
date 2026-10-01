/** Explicit one-time fixture capture. A new destination is required; existing fixtures are never rewritten. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { makeRequested, requestMessages } from '../../src/index.ts'
import { command, replayInput } from '../../../charpub-roleplay/tests/fixtures.ts'
import { historyLoader } from './history-loader.ts'

export async function captureHistory(destination: string) {
  for (const name of ['core', 'assembler']) {
    assert.ok(import.meta.resolve(`@char-pub/${name}`).includes(
      `file+third_party+charpub+tarballs+char-pub-${name}-0.0.0.tgz/`,
    ), 'Capture requires the original installed SDK locator, not the current snapshot')
  }
  const manifestBytes = await readFile(new URL('../../../../../third_party/charpub/manifest.json', import.meta.url))
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'),
    '26890f96d536d5c51b95d247324327c8637736e1c48a2372043ea37aa3ac2944', 'Original SDK manifest changed')
  const sdk: unknown = JSON.parse(manifestBytes.toString('utf8'))
  return capture(destination, sdk)
}

/** Capture a named retained snapshot only while those exact tarballs are installed. */
export async function captureSnapshotHistory(destination: string, directory: string, manifestDigest: string) {
  assert.match(directory, /^snapshots\/[a-z0-9][a-z0-9-]*$/)
  assert.match(manifestDigest, /^[a-f0-9]{64}$/)
  const root = new URL(`../../../../../third_party/charpub/${directory}/`, import.meta.url)
  const manifestBytes = await readFile(new URL('manifest.json', root))
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), manifestDigest, 'Snapshot manifest changed')
  for (const name of ['core', 'assembler']) {
    const locator = `file+third_party+charpub+${directory.replaceAll('/', '+')}+tarballs+char-pub-${name}-0.0.0.tgz/`
    assert.ok(import.meta.resolve(`@char-pub/${name}`).includes(locator), 'Capture requires the requested installed SDK locator')
  }
  const sdk: unknown = JSON.parse(manifestBytes.toString('utf8'))
  return capture(destination, sdk)
}

async function capture(destination: string, sdk: unknown) {
  // Exclusive directory creation is the overwrite barrier. No real Session root is ever opened.
  await mkdir(destination)
  const temporary = await mkdtemp(join(tmpdir(), 'charpub-history-capture-'))
  let ctx: Awaited<ReturnType<typeof historyLoader>> | undefined
  const id = SessionId('legacy-sdk-history')
  const call = { provider: 'roleplay-test', model: 'fixed', maxTokens: 512 }
  try {
    ctx = await historyLoader(temporary)
    const input = replayInput('per-agent', { catalog: true })
    if (input.artifact.kind !== 'content') throw new Error('content required')
    const source = input.artifact.catalog_index.sources[0]
    assert.ok(source)
    await ctx.roleplayRuntime.create(id, input)
    await ctx.roleplayRuntime.submit(id, command('reward', { kind: 'confirm', target: 'beat/reward' }, {
      for_participant: 'alice', selection: [{ source: source.id }],
    }), call)
    await ctx.roleplayRuntime.submit(id, command('garden', { kind: 'enter-scene', scene: 'garden' }, { for_participant: 'bob' }), call)
    const committed = await ctx.roleplayRuntime.inspect(id)
    assert.equal(committed.current.state.vars.count, 1)
    const pending = command('pending', { kind: 'prepare' }, { for_participant: 'bob' })
    const handle = await ctx.sessionPersistence.open(id, 'write')
    try {
      const stored = await handle.read()
      await handle.append([{ type: 'roleplay/requested', seq: SessionSeq(stored.events.length), time: Date.now(),
        data: makeRequested(committed, pending.id, pending, call) }])
      await handle.flush()
    } finally { await handle.close() }
    await ctx.fiber.dispose()
    const files: { path: string; bytes: number; sha256: string }[] = []
    async function save(filename: string, bytes: Uint8Array) {
      await mkdir(dirname(join(destination, filename)), { recursive: true })
      await writeFile(join(destination, filename), bytes, { flag: 'wx' })
      files.push({ path: filename, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    await save('replay.json', Buffer.from(JSON.stringify(committed.log, null, 2) + '\n'))
    const storage = join(temporary, 'sessions')
    for (const file of await readdir(storage, { recursive: true })) {
      if (file.endsWith('.jsonl')) await save(`sessions/${file}`, await readFile(join(storage, file)))
    }
    assert.equal(files.filter(file => file.path.endsWith('.jsonl')).length, 1)
    await writeFile(join(destination, 'manifest.json'), JSON.stringify({
      format: 1, sdk, session_id: id, head: committed.head, pending, call,
      expected_messages: [...committed.requests.values()].map(requestMessages), files,
      generated_with: 'Actual Loader + runtime + JSONL provider, two successful text-only synthetic dispatches, then one flushed unanswered request; no network',
    }, null, 2) + '\n', { flag: 'wx' })
  } finally {
    try { await ctx?.fiber.dispose() } finally { await rm(temporary, { recursive: true, force: true }) }
  }
}
