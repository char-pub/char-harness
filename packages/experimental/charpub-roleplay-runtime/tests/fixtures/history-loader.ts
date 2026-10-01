/** Actual Loader composition for immutable Session compatibility fixtures; all generation stays local. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type {} from './provider.ts'
import type {} from '../../src/index.ts'

export async function historyLoader(root: string) {
  const repository = new URL('../../../../../', import.meta.url)
  const filename = join(root, 'cordis.yml')
  await writeFile(filename, JSON.stringify([
    { name: new URL('packages/core/session/src/index.ts', repository).href },
    { name: new URL('packages/llm/llm/src/index.ts', repository).href },
    { name: new URL('packages/session/session-persistence-jsonl/src/index.ts', repository).href, config: { root: join(root, 'sessions'), compression: 'none' } },
    { name: new URL('./provider.ts', import.meta.url).href },
    { name: new URL('../../src/index.ts', import.meta.url).href, config: { timeout_ms: 5000, max_event_bytes: 1_000_000, max_stream_bytes: 100_000 } },
  ]))
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } })
    await ctx.loader.await()
    assert.ok(ctx.get('roleplayRuntime'))
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
