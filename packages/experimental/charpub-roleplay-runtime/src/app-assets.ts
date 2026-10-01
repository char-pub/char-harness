/** Static files produced by the private browser package; the named profile still owns the HTTP server. */
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Only generated files listed at activation can be served by an asset URL. */
export interface AppAssets {
  template: string
  files: ReadonlyMap<string, { body: Uint8Array; contentType: string }>
}

/**
 * Load the compiled browser application from the profile's declared package dependency.
 * @returns An immutable page template and exact asset URL lookup.
 */
export async function loadAppAssets(): Promise<AppAssets> {
  const require = createRequire(import.meta.url)
  const root = join(dirname(require.resolve('@deepseek-ai/dsh-charpub-roleplay-web/package.json')), 'dist')
  const template = await readFile(join(root, 'index.html'), 'utf8')
  if (!template.includes('<!--CHARPUB_BOOTSTRAP-->')) throw new Error('roleplay_app.assets_invalid')
  const files = new Map<string, { body: Uint8Array; contentType: string }>()
  const directory = join(root, 'assets')
  for (const file of await readdir(directory, { withFileTypes: true })) {
    if (!file.isFile() || !/^[A-Za-z0-9_.-]+\.(?:js|css|woff2|svg)$/.test(file.name)) continue
    const type = file.name.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.name.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.name.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2'
    files.set(`/assets/${file.name}`, { body: await readFile(join(directory, file.name)), contentType: type })
  }
  if (![...files.keys()].some(path => path.endsWith('.js'))) throw new Error('roleplay_app.assets_invalid')
  return { template, files }
}
