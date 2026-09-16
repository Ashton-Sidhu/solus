import { spawn } from 'child_process'
import { once } from 'events'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

/**
 * Builds the managed-host image (packaging/managed-host/Dockerfile) for
 * linux/amd64, tagged from package.json: `registry.fly.io/solus-managed:<version>`.
 * It never pushes; the runbook in packaging/managed-host/README.md does that by hand.
 *
 *   bun scripts/managed-image.ts [--tag <image:tag>]
 */

const repoRoot = resolve(import.meta.dir, '..')
const REGISTRY_IMAGE = 'registry.fly.io/solus-managed'

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
  const child = spawn('docker', [
    'build',
    '--platform', 'linux/amd64',
    '-f', join(repoRoot, 'packaging', 'managed-host', 'Dockerfile'),
    '-t', tag,
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
