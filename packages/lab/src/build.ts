import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'

/**
 * The Lab's own host build (`bun lab build`): the standalone server only, with the
 * test agent backends, in one esbuild pass. It does not build the renderer, the
 * preload, or Electron, and it does not write to `dist/`, which is the developer's.
 *
 * It uses the same esbuild options as the release server bundle
 * (`scripts/package-server.ts` `bundleServerEntry`), and it replaces the same two
 * modules that `BUILD_TARGET=test` replaces (`electron.vite.config.ts`).
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
export const LAB_BUILD_DIR = resolve(REPO_ROOT, '.solus-local/lab-build')
export const LAB_BUILD_ENTRY = resolve(LAB_BUILD_DIR, 'standalone.js')

/** Real module (no extension) → the test replacement. */
const TEST_MODULES = new Map([
  [resolve(REPO_ROOT, 'packages/server/src/execution/agents/backend-registry'), resolve(REPO_ROOT, 'tests/e2e/mock/backend-registry.ts')],
  [resolve(REPO_ROOT, 'packages/server/src/skills/skills-provider'), resolve(REPO_ROOT, 'tests/e2e/mock/skills-provider.ts')],
])

const testModules: Plugin = {
  name: 'lab-test-modules',
  setup(builder) {
    builder.onResolve({ filter: /(backend-registry|skills-provider)$/ }, (args) => {
      const replacement = TEST_MODULES.get(resolve(args.resolveDir, args.path))
      return replacement ? { path: replacement } : undefined
    })
  },
}

export async function buildLabHost(): Promise<{ entry: string; durationMs: number }> {
  const startedAt = Date.now()
  rmSync(LAB_BUILD_DIR, { recursive: true, force: true })
  mkdirSync(LAB_BUILD_DIR, { recursive: true })
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/standalone-server/src/index.ts')],
    outfile: LAB_BUILD_ENTRY,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    logLevel: 'warning',
    define: {
      'import.meta.url': '__filename',
      'process.env.SOLUS_GOOGLE_CLIENT_ID': '""',
      'process.env.SOLUS_GOOGLE_CLIENT_SECRET': '""',
      'process.env.SOLUS_GITHUB_CLIENT_ID': '""',
      'process.env.SOLUS_ATLASSIAN_CLIENT_ID': '""',
      'process.env.SOLUS_ATLASSIAN_CLIENT_SECRET': '""',
    },
    external: ['electron', 'electron-updater', '@ff-labs/fff-node', 'onnxruntime-node', 'playwright-core', '*.node'],
    plugins: [testModules],
  })
  // The server reads its migrations beside the bundle (packages/server/src/db/migration-files.ts).
  cpSync(resolve(REPO_ROOT, 'packages/server/drizzle'), resolve(LAB_BUILD_DIR, 'drizzle'), { recursive: true })
  return { entry: LAB_BUILD_ENTRY, durationMs: Date.now() - startedAt }
}
