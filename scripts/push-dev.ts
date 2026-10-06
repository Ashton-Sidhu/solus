import { spawn } from 'child_process'
import { once } from 'events'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { buildServerBundle } from './package-server'

/**
 * Pushes the working tree's server and web client to the runner Sprite in seconds,
 * without a release:
 *
 *   bun run push:dev                  # server and client
 *   bun run push:dev -- --no-client   # server only: skips the Vite build
 *
 * It bundles only what changes between commits (libexec/server, its migrations,
 * libexec/client, the Sprite boot script), extracts it over the Sprite's release under
 * /opt/solus/releases, and restarts its `solus` service. The Sprite's disk keeps the
 * files until a new release installs. The Sprite is --sprite, $SOLUS_DEV_SPRITE, or the
 * only one `sprite list` shows. The Solus API is part of the cloud application now
 * (plans/013); it is released with solus-cloud.
 *
 * Development only: the release the machine reports is unchanged.
 */

const repoRoot = resolve(import.meta.dir, '..')
const REMOTE_ARCHIVE = '/tmp/solus-dev.tgz'

interface Options {
  client: boolean
  sprite: string | undefined
}

async function run(command: string, args: string[], options: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: ['ignore', options.quiet ? 'pipe' : 'inherit', 'inherit'],
  })
  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  // SAFETY: Node emits `exit` with `(code, signal)`; the first element is the exit code
  // or null when the child was killed by a signal.
  const [code] = await once(child, 'exit') as [number | null]
  if (code !== 0) throw new Error(`${command} ${args[0]} exited with status ${code}`)
  return stdout
}

function parseOptions(args: string[]): Options {
  let client = true
  let sprite = process.env.SOLUS_DEV_SPRITE
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-client') client = false
    else if (arg === '--sprite') sprite = args[++i]
    else throw new Error(`Unknown push-dev option: ${arg}`)
  }
  return { client, sprite }
}

async function buildArchive(options: Options, workDir: string): Promise<string> {
  const staging = join(workDir, 'staging')
  const builds: Promise<unknown>[] = [buildServerBundle(staging)]
  if (options.client) builds.push(run('bun', ['run', 'build:client']))
  await Promise.all(builds)

  if (options.client) {
    rmSync(join(staging, 'libexec', 'client'), { recursive: true, force: true })
    cpSync(join(repoRoot, 'dist', 'client'), join(staging, 'libexec', 'client'), { recursive: true })
  }
  mkdirSync(join(staging, 'libexec', 'managed'), { recursive: true })
  const boot = join(staging, 'libexec', 'managed', 'sprite-boot.sh')
  cpSync(join(repoRoot, 'packaging', 'managed-host', 'sprite-boot.sh'), boot)
  chmodSync(boot, 0o755)

  const archive = join(workDir, 'solus-dev.tgz')
  await run('tar', ['--no-xattrs', '-czf', archive, '-C', staging, 'libexec'])
  return archive
}

async function resolveSprite(named: string | undefined): Promise<string> {
  if (named) return named
  const sprites = (await run('sprite', ['list'], { quiet: true })).split('\n').map((line) => line.trim()).filter(Boolean)
  if (sprites.length !== 1) {
    throw new Error(`Name the runner Sprite with --sprite or SOLUS_DEV_SPRITE; \`sprite list\` shows ${sprites.length}`)
  }
  return sprites[0]
}

async function pushRunner(archive: string, spriteName: string): Promise<void> {
  // The release the running server came from; else the newest one installed.
  const install = `set -eu
dir=$(ps -eo args | grep -o '/opt/solus/releases/[^/ ]*/libexec/server/standalone.js' | head -n 1 | sed 's|/libexec/server/standalone.js$||' || true)
[ -n "$dir" ] || dir=/opt/solus/releases/$(ls -1 /opt/solus/releases | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+([-][0-9A-Za-z.]+)?$' | sort -V | tail -n 1)
test -x "$dir/bin/node"
sudo tar -xzf ${REMOTE_ARCHIVE} -C "$dir" --no-same-owner
sudo chmod -R a+rX,go-w "$dir/libexec"
rm -f ${REMOTE_ARCHIVE}
echo "runner: updated $dir"`
  await run('sprite', ['exec', '-s', spriteName, '--no-stdin', '--file', `${archive}:${REMOTE_ARCHIVE}`, '--', 'sh', '-c', install])

  const service = `/v1/sprites/${encodeURIComponent(spriteName)}/services/solus`
  await run('sprite', ['api', `${service}/stop`, '--', '-sS', '-X', 'POST'], { quiet: true })
  await run('sprite', ['api', `${service}/start?duration=1s`, '--', '-sS', '-X', 'POST'], { quiet: true })
  console.log(`runner: restarted the solus service on ${spriteName}`)
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (!existsSync(join(repoRoot, 'node_modules'))) throw new Error('Run bun install first')

  const workDir = join(tmpdir(), `solus-push-dev-${process.pid}`)
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const started = Date.now()
  try {
    const [archive, spriteName] = await Promise.all([buildArchive(options, workDir), resolveSprite(options.sprite)])
    console.log(`Built in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    await pushRunner(archive, spriteName)
    console.log(`Pushed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
