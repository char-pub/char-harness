/** Owner-local UI and HTTP transport behavior; full named-profile checks remain in the runtime package. */
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify('test') },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], restoreMocks: true },
})
