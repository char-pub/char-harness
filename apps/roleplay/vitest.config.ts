/** Owner-local UI and HTTP transport behavior; full named-profile checks remain in the runtime package. */
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  // Same source resolution as the browser build: workspace packages need no prebuilt lib/ output.
  plugins: [react(), tsconfigPaths({ projects: ['../../tsconfig.base.json'] })],
  define: { __APP_VERSION__: JSON.stringify('test') },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], restoreMocks: true },
})
