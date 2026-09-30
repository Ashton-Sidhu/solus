import { spawn } from 'child_process'
import { once } from 'events'
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

/**
 * Releases the Solus API:
 *
 *   bun run release:api
 *
 * 1. Builds the image locally (scripts/managed-image.ts) as `<app>:<label>`, where the
 *    label is `<version>-<yyyymmdd>-<hhmmss>`, so a label is never reused.
 * 2. Deploys it with `fly deploy --local-only --image`: flyctl pushes the local image
 *    to `registry.fly.io/<app>:<label>` with its own credentials. A plain `docker push`
 *    to that repository answers "app repository not found".
 * 3. Pins fly.toml to the digest Fly reports for the machine, not the one the push
 *    prints: Fly stores its own manifest for a pushed image.
 *
 * The build context is the working tree, uncommitted changes included.
 */

const repoRoot = resolve(import.meta.dir, '..')
const API_APP = 'solus-sh-api'
const REGISTRY_IMAGE = `registry.fly.io/${API_APP}`
const flyTomlPath = join(repoRoot, 'packaging', 'solus-api', 'fly.toml')

async function run(command: string, args: string[], options: { quiet?: boolean } = {}): Promise<string> {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ['inherit', options.quiet ? 'pipe' : 'inherit', 'inherit'],
  })
  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  // SAFETY: Node emits `exit` with `(code, signal)`; the first element is the exit code
  // or null when the child was killed by a signal.
  const [code] = await once(child, 'exit') as [number | null]
  if (code !== 0) throw new Error(`${command} ${args[0]} exited with status ${code}`)
  return stdout
}

function releaseLabel(): string {
  const version: string = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const [date, time] = new Date().toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '').split('T')
  return `${version}-${date}-${time}`
}

async function deployedDigest(image: string): Promise<string> {
  // SAFETY: the shape `fly machine list --json` prints; only these fields are read.
  const machines = JSON.parse(await run('fly', ['machine', 'list', '--app', API_APP, '--json'], { quiet: true })) as {
    id: string
    config: { image: string }
    image_ref: { digest: string }
  }[]
  const machine = machines.find((entry) => entry.config.image === image)
  if (!machine) throw new Error(`No ${API_APP} machine runs ${image} after the deploy`)
  return machine.image_ref.digest
}

function pinFlyToml(label: string, digest: string): void {
  const before = readFileSync(flyTomlPath, 'utf8')
  const after = before
    .replace(/Tag: [a-z0-9-]+:[^\s]+?\.$/m, `Tag: ${API_APP}:${label}.`)
    .replace(/^(\s*image = ")registry\.fly\.io\/[a-z0-9-]+@sha256:[0-9a-f]+(")$/m, `$1${REGISTRY_IMAGE}@${digest}$2`)
  if (!after.includes(digest)) throw new Error(`Could not find the image pin in ${flyTomlPath}`)
  writeFileSync(flyTomlPath, after)
}

async function main(): Promise<void> {
  const dirty = (await run('git', ['status', '--porcelain'], { quiet: true })).trim()
  if (dirty) console.warn('The working tree has uncommitted changes; the image includes them.')

  const label = releaseLabel()
  const localImage = `${API_APP}:${label}`
  console.log(`\n==> Releasing ${localImage}`)

  console.log('\n==> Build')
  await run('bun', [join('scripts', 'managed-image.ts'), '--tag', localImage])

  console.log(`\n==> Push and deploy ${API_APP}`)
  await run('fly', ['deploy', '--config', flyTomlPath, '--image', localImage, '--local-only', '--image-label', label, '--ha=false'])

  const digest = await deployedDigest(`${REGISTRY_IMAGE}:${label}`)
  pinFlyToml(label, digest)
  console.log(`\n==> Pinned fly.toml to ${digest}`)

  console.log(`\nReleased ${REGISTRY_IMAGE}:${label}. Commit packaging/solus-api/fly.toml.`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
