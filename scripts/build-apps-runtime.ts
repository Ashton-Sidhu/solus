import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import packageJson from '../package.json'

/**
 * Builds what the `solus-apps-runtime` image holds (docs/plans/app-deploy.md
 * §5.1): the runtime as one file for Node, the SQLite migrations it reads
 * beside itself, and the Dockerfile. The output is the build context:
 *
 *   bun scripts/build-apps-runtime.ts
 *   docker build -t solus-apps-runtime:<release> dist/apps-runtime
 *
 * esbuild only: no Electron, no Vite, and no client build.
 */

const repoRoot = resolve(import.meta.dir, '..')
const output = join(repoRoot, 'dist', 'apps-runtime')

/** The server modules name these at build time. The image is public, so each one is empty here whatever the build machine has. */
const NO_BUILD_SECRETS = ['SOLUS_GOOGLE_CLIENT_ID', 'SOLUS_GOOGLE_CLIENT_SECRET', 'SOLUS_GITHUB_CLIENT_ID', 'SOLUS_ATLASSIAN_CLIENT_ID', 'SOLUS_ATLASSIAN_CLIENT_SECRET']

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} exited with ${code}`))))
  })
}

async function main(): Promise<void> {
  const esbuild = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.exe' : 'esbuild')
  if (!existsSync(esbuild)) throw new Error('esbuild binary not found; run bun install first')
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  await run(esbuild, [
    join(repoRoot, 'apps', 'apps-runtime', 'src', 'index.ts'),
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--log-level=warning',
    '--define:import.meta.url=__filename',
    ...NO_BUILD_SECRETS.map((name) => `--define:process.env.${name}=""`),
    `--outfile=${join(output, 'runtime.js')}`,
    '--external:electron',
    '--external:electron-updater',
    '--external:@ff-labs/fff-node',
    '--external:playwright-core',
    '--external:*.node',
  ])
  // The bundle reads its migrations beside itself (packages/server/src/db/migration-files.ts).
  cpSync(join(repoRoot, 'packages', 'server', 'drizzle', 'sqlite'), join(output, 'drizzle', 'sqlite'), { recursive: true })
  cpSync(join(repoRoot, 'packaging', 'apps-runtime', 'Dockerfile'), join(output, 'Dockerfile'))
  console.log(`Built solus-apps-runtime ${packageJson.version} in ${output}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
