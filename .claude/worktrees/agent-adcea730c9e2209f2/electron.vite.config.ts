import { dirname, resolve } from 'path'
import { createRequire } from 'module'
import { defineConfig, loadEnv } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

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
  // Keep Vite's dynamic-import preload helper out of whichever large manual
  // vendor chunk Rollup happens to visit first. The renderer entry needs this
  // tiny helper, and absorbing it into vendor-diffs makes the 10 MB diff stack
  // a blocking bootstrap dependency even when every diff import is dynamic.
  if (id.includes('vite/preload-helper')) return 'runtime'
  if (!id.includes('node_modules')) return undefined
  if (id.includes('@tiptap') || id.includes('prosemirror') || id.includes('lowlight')) return 'vendor-editor'
  if (id.includes('@xyflow') || id.includes('@dagrejs') || id.includes('@iconify')) return 'vendor-diagram'
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
    'process.env.SOLUS_GITHUB_CLIENT_ID': JSON.stringify(env.SOLUS_GITHUB_CLIENT_ID ?? '')
  }

  return {
  main: {
    define: oauthDefines,
    resolve: {
      alias: testMainAliases
    },
    server: {
      watch: {
        ignored: ['**/client/**']
      }
    },
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          standalone: resolve(__dirname, 'src/main/standalone.ts'),
          'transcription-worker': resolve(__dirname, 'src/main/transcription/worker.ts')
        },
        external: [
          'electron',
          /\.node$/,
          '@ff-labs/fff-node',
          '@anthropic-ai/claude-agent-sdk',
          'electron-updater',
          'onnxruntime-node',
          'socket.io',
        ]
      }
    }
  },
  preload: {
    server: {
      watch: {
        ignored: ['**/client/**']
      }
    },
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        external: [
          'electron',
          /\.node$/,
        ]
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@client-core': resolve(__dirname, 'src/client-core'),
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@geist-fonts': geistFontsDir
      }
    },
    server: {
      watch: {
        ignored: ['**/web/**', '**/client/**']
      }
    },
    // The @pierre/diffs highlighter worker dynamically imports its Shiki/WASM
    // chunks, so it must be emitted as an ES module — Vite's default IIFE
    // worker format cannot code-split.
    worker: {
      format: 'es'
    },
    plugins: [svelte(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      // The renderer intentionally ships large isolated vendor chunks for the
      // diagram/icon and diff highlighter stacks. App code stays split out via
      // manualChunks above; the default 500 KB browser-site warning is too low
      // for this desktop bundle shape.
      chunkSizeWarningLimit: 13000,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        },
        output: {
          manualChunks: rendererManualChunks
        }
      }
    }
  }
  }
})
