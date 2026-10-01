/** Build the roleplay libraries, named-profile entry and static browser application. */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('..', import.meta.url))
execFileSync(process.execPath, [
  resolve(root, 'node_modules/typescript/lib/tsc.js'),
  '-b', 'packages/experimental/charpub-roleplay-runtime', 'packages/util/crypto',
], { cwd: root, stdio: 'inherit' })
for (const directory of ['packages/util/brand', 'packages/util/values', 'packages/util/crypto', 'packages/experimental/charpub-roleplay', 'packages/experimental/charpub-roleplay-runtime']) {
  await build({
    config: false,
    cwd: resolve(root, directory),
    entry: directory.endsWith('charpub-roleplay-runtime') ? ['lib/types/index.js', 'lib/types/app.js'] : ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
  })
}
execFileSync('pnpm', ['--filter', '@deepseek-ai/dsh-charpub-roleplay-web', 'build'], { cwd: root, stdio: 'inherit' })
