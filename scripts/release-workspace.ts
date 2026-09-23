import { spawn } from 'child_process'
import { once } from 'events'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

/**
 * Releases the managed-host image to every role that runs it:
 *
 *   bun run release:workspace
 *
 * 1. Picks the next free tag, `registry.fly.io/solus-managed:<version>-<yyyymmdd>[-n]`.
 *    Tags are never moved (packaging/managed-host/README.md "Push").
 * 2. Builds it with scripts/managed-image.ts and pushes it.
 * 3. Deploys the workspace service (packaging/workspace-service/fly.toml).
 * 4. Pins fly.toml to the digest Fly reports for the machine, not the one
 *    `docker push` prints: Fly stores its own manifest for a pushed image.
 * 5. Sets the account Worker's MANAGED_HOST_IMAGE, so managed hosts created from
 *    now on boot the same image. The account repository is `../solus-cloud`, or
 *    SOLUS_CLOUD_DIR.
 *
 * The build context is the working tree, uncommitted changes included.
 */

const repoRoot = resolve(import.meta.dir, '..')
const REGISTRY_IMAGE = 'registry.fly.io/solus-managed'
const WORKSPACE_APP = 'solus-workspace'
const flyTomlPath = join(repoRoot, 'packaging', 'workspace-service', 'fly.toml')
const accountRepo = resolve(process.env.SOLUS_CLOUD_DIR ?? join(repoRoot, '..', 'solus-cloud'))

type Run = { cwd?: string; input?: string; quiet?: boolean }

async function run(command: string, args: string[], options: Run = {}): Promise<string> {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: [options.input === undefined ? 'inherit' : 'pipe', options.quiet ? 'pipe' : 'inherit', 'inherit'],
  })
  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  if (options.input !== undefined) child.stdin?.end(options.input)
  // SAFETY: Node emits `exit` with `(code, signal)`; the first element is the exit code
  // or null when the child was killed by a signal.
  const [code] = await once(child, 'exit') as [number | null]
  if (code !== 0) throw new Error(`${command} ${args[0]} exited with status ${code}`)
  return stdout
}

async function succeeds(command: string, args: string[]): Promise<boolean> {
  const child = spawn(command, args, { stdio: 'ignore' })
  // SAFETY: as in run().
  const [code] = await once(child, 'exit') as [number | null]
  return code === 0
}

async function nextFreeTag(): Promise<string> {
  const version: string = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const base = `${REGISTRY_IMAGE}:${version}-${date}`
  for (let n = 1; ; n++) {
    const tag = n === 1 ? base : `${base}-${n}`
    const taken = await succeeds('docker', ['image', 'inspect', tag])
      || await succeeds('docker', ['manifest', 'inspect', tag])
    if (!taken) return tag
  }
}

async function deployedDigest(tag: string): Promise<string> {
  // SAFETY: the shape `fly machine list --json` prints; only these fields are read.
  const machines = JSON.parse(await run('fly', ['machine', 'list', '--app', WORKSPACE_APP, '--json'], { quiet: true })) as {
    id: string
    config: { image: string }
    image_ref: { digest: string }
  }[]
  const machine = machines.find((entry) => entry.config.image === tag)
  if (!machine) throw new Error(`No ${WORKSPACE_APP} machine runs ${tag} after the deploy`)
  return machine.image_ref.digest
}

function pinFlyToml(tag: string, digest: string): void {
  const tagName = tag.slice(tag.lastIndexOf('/') + 1)
  const before = readFileSync(flyTomlPath, 'utf8')
  const after = before
    .replace(/Tag: solus-managed:[^\s]+?\.$/m, `Tag: ${tagName}.`)
    .replace(/^(\s*image = ")registry\.fly\.io\/solus-managed@sha256:[0-9a-f]+(")$/m, `$1${REGISTRY_IMAGE}@${digest}$2`)
  if (!after.includes(digest)) throw new Error(`Could not find the image pin in ${flyTomlPath}`)
  writeFileSync(flyTomlPath, after)
}

async function main(): Promise<void> {
  const dirty = (await run('git', ['status', '--porcelain'], { quiet: true })).trim()
  if (dirty) console.warn('The working tree has uncommitted changes; the image includes them.')
  if (!existsSync(join(accountRepo, 'wrangler.jsonc'))) {
    throw new Error(`No account repository at ${accountRepo}; set SOLUS_CLOUD_DIR`)
  }

  await run('fly', ['auth', 'docker'], { quiet: true })
  const tag = await nextFreeTag()
  console.log(`\n==> Releasing ${tag}`)

  console.log('\n==> Build')
  await run('bun', [join('scripts', 'managed-image.ts'), '--tag', tag])

  console.log('\n==> Push')
  await run('docker', ['push', tag])

  console.log(`\n==> Deploy ${WORKSPACE_APP}`)
  await run('fly', ['deploy', '--config', flyTomlPath, '--image', tag, '--ha=false'])

  const digest = await deployedDigest(tag)
  pinFlyToml(tag, digest)
  console.log(`\n==> Pinned fly.toml to ${digest}`)

  console.log('\n==> Set MANAGED_HOST_IMAGE on the account Worker')
  await run('bunx', ['wrangler', 'secret', 'put', 'MANAGED_HOST_IMAGE'], { cwd: accountRepo, input: tag })

  console.log(`\nReleased ${tag}. Commit packaging/workspace-service/fly.toml.`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
