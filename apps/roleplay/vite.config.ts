/** Static browser assets; the named roleplay profile owns the application server. */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  // Workspace packages resolve to their source through tsconfig.base.json paths, so the browser build needs no
  // prebuilt lib/ output from transitive workspace dependencies such as schemastery and cosmokit.
  plugins: [react(), tsconfigPaths({ projects: ['../../tsconfig.base.json'] })],
  base: '/',
  define: { __APP_VERSION__: JSON.stringify(version) },
  // ui-primitives source resolves React from its own workspace links; one copy keeps hooks valid.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
})
