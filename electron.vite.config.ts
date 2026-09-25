import { cpSync } from 'fs'
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
    plugins: [
      // The generated database migrations are read from disk at boot
      // (packages/server/src/db/migration-files.ts); they ship beside the bundle.
      {
        name: 'solus-copy-db-migrations',
        closeBundle() {
          cpSync(resolve(__dirname, 'packages/server/drizzle'), resolve(__dirname, 'dist/main/drizzle'), { recursive: true })
        },
      },
    ],
    resolve: {
      // An array, not an object: the test aliases are `{ find, replacement }`
      // entries, and spreading them into an object keyed them "0" and "1", so
      // the mock backends never reached a test bundle.
      alias: [
        ...testMainAliases,
        { find: '@solus/contracts', replacement: resolve(__dirname, 'packages/contracts/src') },
        { find: '@solus/server', replacement: resolve(__dirname, 'packages/server/src') },
        { find: '@solus/desktop-main', replacement: resolve(__dirname, 'apps/desktop/src/main') },
        { find: '@solus/workspace-ui', replacement: resolve(__dirname, 'packages/workspace-ui/src') },
      ]
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
          // package.json `main`: turns on the compile cache, then loads `index`.
          boot: resolve(__dirname, 'apps/desktop/src/main/boot.ts'),
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
      // Let feature imports own chunk boundaries, as in the web client. Manual
      // vendor groups formed a Svelte/diagram cycle that called from_html before
      // Svelte's TEMPLATE_FRAGMENT constant was initialized.
      chunkSizeWarningLimit: 13000,
      // Gzipping every emitted chunk only to print a size column costs seconds
      // on a 30 MB renderer bundle. The desktop bundle ships from disk, so the
      // compressed number is not a metric we act on.
      reportCompressedSize: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/desktop/src/renderer/index.html')
        }
      }
    }
  }
  }
})
