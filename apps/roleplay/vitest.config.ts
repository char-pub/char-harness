/** Owner-local UI and HTTP transport behavior; full named-profile checks remain in the runtime package. */
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], restoreMocks: true },
})
