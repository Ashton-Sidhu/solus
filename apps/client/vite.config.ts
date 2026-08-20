import { dirname, resolve } from 'path'
import { createRequire } from 'module'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { solusIconSubset } from '../../scripts/vite-icon-collections'

const require = createRequire(import.meta.url)
const geistFontsDir = resolve(dirname(require.resolve('geist/font/sans')), 'fonts')

// Web client mounts the shared workspace UI directly.
// The ws-transport stub fills in for `window.solus` before App.svelte mounts.
//
// We point `root` at this directory so the dev server uses our index.html, but
// alias package imports to workspace sources so the shared components stay
// in one place — no fork.

export default defineConfig({
  root: resolve(__dirname),
  envDir: resolve(__dirname, '../..'),
  publicDir: resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@solus/workspace-ui': resolve(__dirname, '../../packages/workspace-ui/src'),
      '@solus/contracts': resolve(__dirname, '../../packages/contracts/src'),
      '@solus/client-core': resolve(__dirname, '../../packages/client-core/src'),
      '@geist-fonts': geistFontsDir,
    },
    // ProseMirror classes rely on module identity. Keep editor nodes and table
    // resize decorations on the same model and view module instances.
    dedupe: ['prosemirror-model', 'prosemirror-view'],
    // Workspace components import contracts through the package name.
    // those resolve correctly from the original file locations because Vite
    // walks the actual file path, not the alias.
  },
  // The @pierre/diffs highlighter worker dynamically imports its Shiki/WASM
  // chunks — IIFE format (Vite default) cannot code-split, so use ES modules.
  worker: {
    format: 'es',
  },
  plugins: [solusIconSubset(), tailwindcss(), svelte()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    fs: {
      // Allow serving from the repo root so renderer/* works.
      allow: [resolve(__dirname, '../..')],
    },
  },
  build: {
    outDir: resolve(__dirname, '../../dist/client'),
    emptyOutDir: true,
    // Feature-level dynamic imports own chunk boundaries. Let Rollup follow
    // those boundaries instead of forcing shared dependencies into manual
    // vendor chunks, which creates circular static edges back to the entry.
    chunkSizeWarningLimit: 13000,
  },
})
