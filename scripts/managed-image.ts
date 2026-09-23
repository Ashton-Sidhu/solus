import { execFile, spawn } from 'child_process'
import { once } from 'events'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Builds the managed-host image (packaging/managed-host/Dockerfile) for
 * linux/amd64, tagged from package.json: `registry.fly.io/solus-managed:<version>`.
 * It never pushes; the runbook in packaging/managed-host/README.md does that by hand.
 *
 *   bun scripts/managed-image.ts [--tag <image:tag>]
 *
 * The OAuth clients the bundle embeds come from the environment this runs in
 * (`SOLUS_GITHUB_CLIENT_ID`, `SOLUS_GOOGLE_CLIENT_ID/SECRET`,
 * `SOLUS_ATLASSIAN_CLIENT_ID/SECRET`) and are passed as build args, because the
 * build context ignores `.env`. Missing ones are reported and left empty.
 *
 * The agent CLIs are always the latest npm release. The exact versions are passed
 * as build args so a new release invalidates Docker's cached install layer.
 */

const repoRoot = resolve(import.meta.dir, '..')
const REGISTRY_IMAGE = 'registry.fly.io/solus-managed'
const OAUTH_CLIENT_ENV = [
  'SOLUS_GITHUB_CLIENT_ID',
  'SOLUS_GOOGLE_CLIENT_ID',
  'SOLUS_GOOGLE_CLIENT_SECRET',
  'SOLUS_ATLASSIAN_CLIENT_ID',
  'SOLUS_ATLASSIAN_CLIENT_SECRET',
] as const
const AGENT_PACKAGES = [
  ['CLAUDE_CODE_VERSION', '@anthropic-ai/claude-code'],
  ['CODEX_VERSION', '@openai/codex'],
] as const

async function latestVersion(pkg: string): Promise<string> {
  const { stdout } = await execFileAsync('npm', ['view', pkg, 'version'])
  const version = stdout.trim()
  if (!version) throw new Error(`Could not resolve the latest version of ${pkg}`)
  return version
}

function parseTag(args: string[]): string {
  const version: string = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  let tag = `${REGISTRY_IMAGE}:${version}`
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--tag') {
      const value = args[++i]
      if (!value) throw new Error('--tag requires a value')
      tag = value
    } else if (arg.startsWith('--tag=')) {
      tag = arg.slice('--tag='.length)
    } else {
      throw new Error(`Unknown managed-image option: ${arg}`)
    }
  }
  return tag
}

async function main(): Promise<void> {
  const tag = parseTag(process.argv.slice(2))
  const missing = OAUTH_CLIENT_ENV.filter((name) => !process.env[name])
  if (missing.length > 0) console.warn(`Building without ${missing.join(', ')}: those providers will be unconfigured in the image`)
  const buildArgs = OAUTH_CLIENT_ENV.flatMap((name) => (process.env[name] ? ['--build-arg', `${name}=${process.env[name]}`] : []))
  for (const [arg, pkg] of AGENT_PACKAGES) {
    const version = await latestVersion(pkg)
    console.log(`${pkg}@${version}`)
    buildArgs.push('--build-arg', `${arg}=${version}`)
  }
  const child = spawn('docker', [
    'build',
    '--platform', 'linux/amd64',
    '-f', join(repoRoot, 'packaging', 'managed-host', 'Dockerfile'),
    '-t', tag,
    ...buildArgs,
    repoRoot,
  ], { stdio: 'inherit' })
  // SAFETY: Node emits `exit` with `(code, signal)`; the first element is the exit code
  // or null when the child was killed by a signal.
  const [code] = await once(child, 'exit') as [number | null]
  if (code !== 0) throw new Error(`docker build exited with status ${code}`)
  console.log(`Built ${tag} (not pushed)`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
