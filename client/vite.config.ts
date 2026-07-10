import { dirname, resolve } from 'path'
import { createRequire } from 'module'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const require = createRequire(import.meta.url)
const geistFontsDir = resolve(dirname(require.resolve('geist/font/sans')), 'fonts')

function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  if (id.includes('@pierre/diffs') || id.includes('@shikijs') || id.includes('shiki')) return 'vendor-diffs'
  if (id.includes('@tiptap') || id.includes('prosemirror') || id.includes('lowlight')) return 'vendor-editor'
  if (id.includes('@xyflow') || id.includes('@dagrejs') || id.includes('@iconify')) return 'vendor-diagram'
  if (id.includes('svelte')) return 'vendor-svelte'
  return undefined
}

// Web client mounts the existing Electron renderer (src/renderer/) directly.
// The ws-transport stub fills in for `window.solus` before App.svelte mounts.
//
// We point `root` at this directory so the dev server uses our index.html, but
// alias all imports back into ../src/renderer so the shared components stay
// in one place — no fork.

export default defineConfig({
  root: resolve(__dirname),
  publicDir: resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, '../src/renderer'),
      '@shared':   resolve(__dirname, '../src/shared'),
      '@client-core': resolve(__dirname, '../src/client-core'),
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
      allow: [resolve(__dirname, '..')],
    },
  },
  build: {
    outDir: resolve(__dirname, '../dist/client'),
    emptyOutDir: true,
    // Matches the Electron renderer: large vendor chunks are isolated by
    // manualChunks, while the app entry remains small enough to cache/update
    // independently.
    chunkSizeWarningLimit: 13000,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
})
