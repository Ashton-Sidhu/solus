import { dirname, resolve } from 'path'
import { createRequire } from 'module'
import { defineConfig, loadEnv } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { solusIconSubset } from './scripts/vite-icon-collections'
import { devServeRoots } from './scripts/vite-fs-allow'

const require = createRequire(import.meta.url)
const geistFontsDir = resolve(dirname(require.resolve('geist/font/sans')), 'fonts')

// e2e test build: swap the production agent backends and skills registry for
// deterministic mocks under tests/e2e/mock. Gated on BUILD_TARGET=test so the
// mock code never resolves into — and so never ships in — release bundles.
const isTestBuild = process.env.BUILD_TARGET === 'test'
const testMainAliases = isTestBuild
  ? [
      { find: /^\.\/agents\/backend-registry$/, replacement: resolve(__dirname, 'tests/e2e/mock/backend-registry.ts') },
      { find: /^\.\.\/\.\.\/skills\/skills-provider$/, replacement: resolve(__dirname, 'tests/e2e/mock/skills-provider.ts') },
    ]
  : []

function rendererManualChunks(id: string): string | undefined {
  // A tiny module shared across vendors is the trap here: whichever large
  // manual chunk Rollup files it under becomes a blocking bootstrap dependency,
  // because the entry has to load that whole chunk to reach two kilobytes.
  // Vite's dynamic-import preload helper did it via the 10 MB diff stack;
  // `w3c-keyname` — keyboard-name lookup that CodeMirror and ProseMirror both
  // depend on — did it via vendor-editor, so the composer's CodeMirror dragged
  // all 1.4 MB of Tiptap onto every launch. Park both in `runtime`, which no
  // vendor owns.
  if (id.includes('w3c-keyname')) return 'runtime'
  if (id.includes('vite/preload-helper')) return 'runtime'
  if (!id.includes('node_modules')) return undefined
  if (id.includes('@tiptap') || id.includes('prosemirror')) return 'vendor-editor'
  // Highlighting is its own chunk, not part of vendor-editor: the transcript's
  // code blocks need lowlight on the first frame, and grouping the two made the
  // editor a boot dependency for a package the boot path never touches.
  if (id.includes('lowlight') || id.includes('highlight.js')) return 'vendor-highlight'
  if (id.includes('@xyflow') || id.includes('@dagrejs')) return 'vendor-diagram'
  if (id.includes('@iconify')) return 'vendor-iconify'
  // Deliberately broad. Narrowing this to the Svelte runtime scattered the
  // svelte-named UI libraries across 60 more chunks and re-formed the very
  // cross-vendor edges the two rules above exist to break, which measured
  // slower — the per-chunk instantiation cost outweighs the bytes saved.
  if (id.includes('svelte')) return 'vendor-svelte'
  return undefined
}

export default defineConfig(({ mode }) => {
  // The OAuth client id/secrets are read in the main process via bare
  // `process.env.*`, which Vite leaves as a runtime lookup — undefined on the
  // end-user's machine. Inline them at build time so production bundles embed
  // the real values. loadEnv merges `.env[.mode]` files with the build env.
  const env = loadEnv(mode, process.cwd(), '')
  const oauthDefines = {
    'process.env.SOLUS_GOOGLE_CLIENT_ID': JSON.stringify(env.SOLUS_GOOGLE_CLIENT_ID ?? ''),
    'process.env.SOLUS_GOOGLE_CLIENT_SECRET': JSON.stringify(env.SOLUS_GOOGLE_CLIENT_SECRET ?? ''),
    'process.env.SOLUS_GITHUB_CLIENT_ID': JSON.stringify(env.SOLUS_GITHUB_CLIENT_ID ?? ''),
    'process.env.SOLUS_ATLASSIAN_CLIENT_ID': JSON.stringify(env.SOLUS_ATLASSIAN_CLIENT_ID ?? ''),
    'process.env.SOLUS_ATLASSIAN_CLIENT_SECRET': JSON.stringify(env.SOLUS_ATLASSIAN_CLIENT_SECRET ?? ''),
    'process.env.SOLUS_POSTHOG_KEY': JSON.stringify(env.VITE_POSTHOG_KEY ?? '')
  }

  return {
  main: {
    define: oauthDefines,
    resolve: {
      alias: {
        ...testMainAliases,
        '@solus/contracts': resolve(__dirname, 'packages/contracts/src'),
        '@solus/server': resolve(__dirname, 'packages/server/src'),
        '@solus/desktop-main': resolve(__dirname, 'apps/desktop/src/main'),
        '@solus/workspace-ui': resolve(__dirname, 'packages/workspace-ui/src'),
      }
    },
    server: {
      watch: {
        ignored: ['**/apps/client/**', '**/tests/**']
      }
    },
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/desktop/src/main/index.ts'),
          standalone: resolve(__dirname, 'apps/standalone-server/src/index.ts'),
          'transcription-worker': resolve(__dirname, 'packages/server/src/transcription/worker.ts')
        },
        external: [
          'electron',
          /\.node$/,
          '@ff-labs/fff-node',
          '@anthropic-ai/claude-agent-sdk',
          'electron-updater',
          'onnxruntime-node',
          'socket.io',
          // Optional, and resolved at runtime by the standalone server only.
          // Following it would pull a browser driver into the desktop bundle
          // and make an absent package a build failure instead of a state.
          'playwright-core',
        ]
      }
    }
  },
  preload: {
    server: {
      watch: {
        ignored: ['**/apps/client/**', '**/tests/**']
      }
    },
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/desktop/src/preload/index.ts')
        },
        external: [
          'electron',
          /\.node$/,
        ]
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'apps/desktop/src/renderer'),
    resolve: {
      alias: {
        '@solus/client-core': resolve(__dirname, 'packages/client-core/src'),
        '@solus/workspace-ui': resolve(__dirname, 'packages/workspace-ui/src'),
        '@solus/contracts': resolve(__dirname, 'packages/contracts/src'),
        '@geist-fonts': geistFontsDir
      },
      // ProseMirror classes rely on module identity. Nested model copies break
      // splitBlock, while nested view copies corrupt table DecorationGroup.
      dedupe: ['prosemirror-model', 'prosemirror-view']
    },
    server: {
      watch: {
        ignored: ['**/apps/site/**', '**/apps/client/**', '**/tests/**']
      },
      fs: {
        allow: devServeRoots(__dirname)
      }
    },
    // The @pierre/diffs highlighter worker dynamically imports its Shiki/WASM
    // chunks, so it must be emitted as an ES module — Vite's default IIFE
    // worker format cannot code-split.
    worker: {
      format: 'es'
    },
    plugins: [solusIconSubset(), svelte(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      // The renderer intentionally ships large isolated vendor chunks for the
      // diagram/icon and diff highlighter stacks. App code stays split out via
      // manualChunks above; the default 500 KB browser-site warning is too low
      // for this desktop bundle shape.
      chunkSizeWarningLimit: 13000,
      // Gzipping every emitted chunk only to print a size column costs seconds
      // on a 30 MB renderer bundle. The desktop bundle ships from disk, so the
      // compressed number is not a metric we act on.
      reportCompressedSize: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/desktop/src/renderer/index.html')
        },
        output: {
          manualChunks: rendererManualChunks
        }
      }
    }
  }
  }
})
