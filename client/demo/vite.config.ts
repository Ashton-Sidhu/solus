import { dirname, resolve } from 'path'
import { createRequire } from 'module'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const require = createRequire(import.meta.url)
const geistFontsDir = resolve(dirname(require.resolve('geist/font/sans')), 'fonts')

// The demo mounts the existing Electron renderer (src/renderer/) directly.
// Its in-memory transport fills in for `window.solus` before App.svelte mounts.

export default defineConfig({
  root: resolve(__dirname),
  publicDir: resolve(__dirname, 'public'),
  base: '/demo/',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, '../../src/renderer'),
      '@shared': resolve(__dirname, '../../src/shared'),
      '@client-core': resolve(__dirname, '../../src/client-core'),
      '@geist-fonts': geistFontsDir,
    },
    // Components inside src/renderer use relative imports like '../../shared/types';
    // those resolve correctly from the original file locations because Vite
    // walks the actual file path, not the alias.
  },
  // The @pierre/diffs highlighter worker dynamically imports its Shiki/WASM
  // chunks — IIFE format (Vite default) cannot code-split, so use ES modules.
  worker: {
    format: 'es',
  },
  plugins: [tailwindcss(), svelte()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    fs: {
      // Allow serving from the repo root so renderer/* works.
      allow: [resolve(__dirname, '../..')],
    },
  },
  build: {
    outDir: resolve(__dirname, '../../web/static/demo'),
    emptyOutDir: true,
    // Feature-level dynamic imports own chunk boundaries. Let Rollup follow
    // those boundaries instead of forcing shared dependencies into manual
    // vendor chunks, which creates circular static edges back to the entry.
    chunkSizeWarningLimit: 13000,
  },
})
