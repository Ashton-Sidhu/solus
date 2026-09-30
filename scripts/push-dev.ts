import { spawn } from 'child_process'
import { once } from 'events'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { buildServerBundle } from './package-server'

/**
 * Pushes the working tree's server and web client to the cloud in seconds,
 * without a release, an image build or a machine restart:
 *
 *   bun run push:dev                  # the runner Sprite and the Solus API
 *   bun run push:dev -- --no-client   # server only: skips the Vite build
 *   bun run push:dev -- --runner      # only the runner Sprite
 *   bun run push:dev -- --api         # only the Solus API
 *
 * It bundles only what changes between commits (libexec/server, its migrations,
 * libexec/client, the Sprite boot script) and extracts it over the installed release:
 *
 * - Runner: the Sprite's release under /opt/solus/releases, then a restart of its
 *   `solus` service. The Sprite's disk keeps the files until a new release installs.
 *   The Sprite is --sprite, $SOLUS_DEV_SPRITE, or the only one `sprite list` shows.
 * - Solus API (Fly app `solus-sh-api`): /opt/solus on the Fly machine, then a
 *   stop of the server, which entrypoint.sh starts again. That needs SOLUS_DEV_RELOAD=1 on the app
 *   (once: `fly secrets set SOLUS_DEV_RELOAD=1 -a solus-sh-api`). The next deploy
 *   or machine restart goes back to the image.
 *
 * Development only: the release the machine reports is unchanged.
 */

const repoRoot = resolve(import.meta.dir, '..')
const API_APP = 'solus-sh-api'
const REMOTE_ARCHIVE = '/tmp/solus-dev.tgz'

interface Options {
  runner: boolean
  api: boolean
  client: boolean
  sprite: string | undefined
  app: string
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
  let runner = false
  let api = false
  let client = true
  let sprite = process.env.SOLUS_DEV_SPRITE
  let app = API_APP
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--runner') runner = true
    else if (arg === '--api') api = true
    else if (arg === '--no-client') client = false
    else if (arg === '--sprite') sprite = args[++i]
    else if (arg === '--app') app = args[++i]
    else throw new Error(`Unknown push-dev option: ${arg}`)
  }
  if (!runner && !api) runner = api = true
  return { runner, api, client, sprite, app }
}

async function buildArchive(options: Options, workDir: string): Promise<string> {
  const staging = join(workDir, 'staging')
  const builds: Promise<unknown>[] = [buildServerBundle(staging)]
  if (options.client) builds.push(run('bun', ['run', 'build:client']))
  await Promise.all(builds)

  cpSync(join(repoRoot, 'packages', 'server', 'drizzle'), join(staging, 'libexec', 'server', 'drizzle'), { recursive: true })
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

async function pushApi(archive: string, app: string): Promise<void> {
  // A unique name: sftp does not overwrite a file that is already there.
  const remote = `/tmp/solus-dev-${Date.now()}.tgz`
  await run('fly', ['ssh', 'sftp', 'put', archive, remote, '-a', app], { quiet: true })
  const install = `set -eu
test -f /run/solus-server.pid || { rm -f ${remote}; echo "api: SOLUS_DEV_RELOAD is not on; run: fly secrets set SOLUS_DEV_RELOAD=1 -a ${app}" >&2; exit 1; }
tar -xzf ${remote} -C /opt/solus --no-same-owner
chmod -R a+rX,go-w /opt/solus/libexec
rm -f ${remote}
kill -TERM "$(cat /run/solus-server.pid)"
echo "api: updated /opt/solus and restarted the server"`
  await run('fly', ['ssh', 'console', '-a', app, '-C', `sh -c '${install.replaceAll("'", `'\\''`)}'`])
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (!existsSync(join(repoRoot, 'node_modules'))) throw new Error('Run bun install first')

  const workDir = join(tmpdir(), `solus-push-dev-${process.pid}`)
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const started = Date.now()
  try {
    const [archive, spriteName] = await Promise.all([
      buildArchive(options, workDir),
      options.runner ? resolveSprite(options.sprite) : Promise.resolve(''),
    ])
    console.log(`Built in ${((Date.now() - started) / 1000).toFixed(1)}s`)

    const pushes: Promise<void>[] = []
    if (options.runner) pushes.push(pushRunner(archive, spriteName))
    if (options.api) pushes.push(pushApi(archive, options.app))
    const results = await Promise.allSettled(pushes)
    const failures = results.filter((result) => result.status === 'rejected')
    for (const failure of failures) console.error(failure.reason instanceof Error ? failure.reason.message : String(failure.reason))
    if (failures.length > 0) process.exit(1)
    console.log(`Pushed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
