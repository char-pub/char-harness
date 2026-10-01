/** Static browser assets; the named roleplay profile owns the application server. */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  // ui-primitives source resolves React from its own workspace links; one copy keeps hooks valid.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
})
