import { createHash } from 'crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { once } from 'events'

const NODE_VERSION = '24.18.0'
const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'linux-x64', 'linux-arm64'])

interface Target {
  platform: 'darwin' | 'linux'
  arch: 'x64' | 'arm64'
}

const repoRoot = resolve(import.meta.dir, '..')

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2))
  const targetName = `${target.platform}-${target.arch}`
  if (!SUPPORTED_TARGETS.has(targetName)) throw new Error(`Unsupported server target: ${targetName}`)

  assertBuildExists()

  const releaseDir = join(repoRoot, 'release')
  mkdirSync(releaseDir, { recursive: true })

  const workDir = join(tmpdir(), `solus-server-package-${targetName}-${process.pid}`)
  const staging = join(workDir, 'solus-server')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  try {
    await installNodeRuntime(target, staging)
    await buildServerBundle(staging)
    await buildCliBundle(staging)
    copyClient(staging)
    copyBundledPlugins(staging)
    copyPreviewBrowserDriver(staging)
    writeLaunchers(staging)
    writeNativeNote(staging)

    const out = join(releaseDir, `solus-server-${targetName}.tar.gz`)
    rmSync(out, { force: true })
    await run('tar', ['--no-xattrs', '-czf', out, '-C', staging, '.'])
    writeSha256Sums(releaseDir)
    console.log(`Wrote ${out}`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function parseTarget(args: string[]): Target {
  let platform = normalizePlatform(process.platform)
  let arch = normalizeArch(process.arch)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--platform') platform = normalizePlatform(takeValue(args, ++i, arg))
    else if (arg.startsWith('--platform=')) platform = normalizePlatform(arg.slice('--platform='.length))
    else if (arg === '--arch') arch = normalizeArch(takeValue(args, ++i, arg))
    else if (arg.startsWith('--arch=')) arch = normalizeArch(arg.slice('--arch='.length))
    else throw new Error(`Unknown package-server option: ${arg}`)
  }
  return { platform, arch }
}

function normalizePlatform(value: string): Target['platform'] {
  if (value === 'darwin' || value === 'linux') return value
  throw new Error(`Unsupported --platform: ${value}`)
}

function normalizeArch(value: string): Target['arch'] {
  if (value === 'x64' || value === 'arm64') return value
  if (value === 'amd64') return 'x64'
  if (value === 'aarch64') return 'arm64'
  throw new Error(`Unsupported --arch: ${value}`)
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function assertBuildExists(): void {
  const missing = [
    join(repoRoot, 'dist', 'main', 'standalone.js'),
    join(repoRoot, 'dist', 'client', 'index.html'),
  ].filter((file) => !existsSync(file))
  if (missing.length > 0) {
    throw new Error(`Build output missing. Run "bun run build" first.\n${missing.join('\n')}`)
  }
}

async function installNodeRuntime(target: Target, staging: string): Promise<void> {
  const binDir = join(staging, 'bin')
  mkdirSync(binDir, { recursive: true })

  const nodeName = `node-v${NODE_VERSION}-${target.platform}-${target.arch}`
  const tarName = `${nodeName}.tar.gz`
  const baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`
  const shasums = await fetchText(`${baseUrl}/SHASUMS256.txt`)
  const expected = shasums.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === tarName)?.[0]
  if (!expected) throw new Error(`Node SHASUMS256.txt did not contain ${tarName}`)

  const archive = join(dirname(staging), tarName)
  const data = await fetchBytes(`${baseUrl}/${tarName}`)
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== expected) throw new Error(`Node runtime checksum mismatch for ${tarName}`)
  writeFileSync(archive, data)

  await run('tar', ['-xzf', archive, '-C', binDir, '--strip-components=2', `${nodeName}/bin/node`])
  chmodSync(join(binDir, 'node'), 0o755)
}

async function buildServerBundle(staging: string): Promise<void> {
  const outdir = join(staging, 'libexec', 'server')
  mkdirSync(outdir, { recursive: true })
  await run(esbuildBin(), [
    join(repoRoot, 'apps', 'standalone-server', 'src', 'index.ts'),
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--log-level=warning',
    '--define:import.meta.url=__filename',
    `--define:process.env.SOLUS_GOOGLE_CLIENT_ID=${JSON.stringify(process.env.SOLUS_GOOGLE_CLIENT_ID ?? '')}`,
    `--define:process.env.SOLUS_GOOGLE_CLIENT_SECRET=${JSON.stringify(process.env.SOLUS_GOOGLE_CLIENT_SECRET ?? '')}`,
    `--define:process.env.SOLUS_GITHUB_CLIENT_ID=${JSON.stringify(process.env.SOLUS_GITHUB_CLIENT_ID ?? '')}`,
    `--outfile=${join(outdir, 'standalone.js')}`,
    '--external:electron',
    '--external:electron-updater',
    '--external:@ff-labs/fff-node',
    '--external:onnxruntime-node',
    // Optional: the preview host resolves it at runtime, and a server installed
    // without it simply reports that it cannot render a preview page.
    '--external:playwright-core',
    '--external:*.node',
  ])
}

async function buildCliBundle(staging: string): Promise<void> {
  const outdir = join(staging, 'libexec', 'cli')
  mkdirSync(outdir, { recursive: true })
  await run(esbuildBin(), [
    join(repoRoot, 'apps', 'cli', 'src', 'index.ts'),
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--log-level=warning',
    `--outfile=${join(outdir, 'solus.js')}`,
  ])
}

function copyClient(staging: string): void {
  cpSync(join(repoRoot, 'dist', 'client'), join(staging, 'libexec', 'client'), { recursive: true })
}

/**
 * Ship the preview host's browser driver with the server.
 *
 * Preview is a feature of the standalone server, so the code that renders a
 * preview page belongs in the release rather than being something an operator
 * has to remember to install. It is copied rather than bundled because
 * `playwright-core` resolves its own files and spawns its own processes at
 * runtime — esbuild would flatten it into something that cannot find itself,
 * which is why the server bundle keeps it external.
 *
 * It lands beside the bundle so Node's ordinary upward `node_modules` lookup
 * from `libexec/server/standalone.js` finds it with no path configuration.
 *
 * The browser binaries are deliberately *not* here: they are ~170 MB per
 * platform, they are downloaded for the host that will run them, and they live
 * outside the install directory so a redeploy does not discard them. A machine
 * without them logs `preview_playwright_absent` and every other feature works.
 */
function copyPreviewBrowserDriver(staging: string): void {
  const source = join(repoRoot, 'node_modules', 'playwright-core')
  if (!existsSync(source)) {
    throw new Error('playwright-core is not installed; the preview host cannot be packaged without it.')
  }
  cpSync(source, join(staging, 'libexec', 'server', 'node_modules', 'playwright-core'), { recursive: true })
}

/** The server links these into the state dir on boot, so they must ship where
 *  bundledResourcesDir() looks: `$SOLUS_INSTALL_DIR/resources`. */
function copyBundledPlugins(staging: string): void {
  cpSync(join(repoRoot, 'resources', 'plugins'), join(staging, 'resources', 'plugins'), { recursive: true })
}

function writeLaunchers(staging: string): void {
  const binDir = join(staging, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeExecutable(join(binDir, 'solus'), `#!/usr/bin/env sh
set -eu
SELF="$0"
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
SELF_DIR=$(CDPATH= cd "$(dirname "$SELF")" && pwd)
ROOT=$(CDPATH= cd "$SELF_DIR/.." && pwd)
export SOLUS_INSTALL_DIR="$ROOT"
exec "$ROOT/bin/node" "$ROOT/libexec/cli/solus.js" "$@"
`)
  writeExecutable(join(binDir, 'solus-server'), `#!/usr/bin/env sh
set -eu
SELF="$0"
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
SELF_DIR=$(CDPATH= cd "$(dirname "$SELF")" && pwd)
ROOT=$(CDPATH= cd "$SELF_DIR/.." && pwd)
export SOLUS_INSTALL_DIR="$ROOT"
exec "$ROOT/bin/node" "$ROOT/libexec/server/standalone.js" "$@"
`)
}

function writeNativeNote(staging: string): void {
  const nativeDir = join(staging, 'libexec', 'native')
  mkdirSync(nativeDir, { recursive: true })
  writeFileSync(join(nativeDir, 'README.txt'), [
    'Optional native modules are intentionally not bundled.',
    '',
    '@ff-labs/fff-node and onnxruntime-node are externalized from the server bundle.',
    'Their platform-specific loaders are not trivially copyable across release targets.',
    'Features that depend on them degrade through existing capability checks.',
    '',
    'playwright-core IS shipped, at libexec/server/node_modules/playwright-core,',
    'because the preview host is a feature of this server. Its browser binaries are',
    'not: install them once per machine with',
    '',
    '  node /opt/solus/libexec/server/node_modules/playwright-core/cli.js install --with-deps chromium',
    '',
    'They land outside the install directory, so a redeploy keeps them.',
    '',
  ].join('\n'))
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o755 })
  chmodSync(file, 0o755)
}

function writeSha256Sums(releaseDir: string): void {
  const lines = readdirSync(releaseDir)
    .filter((name) => /^solus-server-.+\.tar\.gz$/.test(name))
    .sort()
    .map((name) => {
      const hash = createHash('sha256').update(readFileSync(join(releaseDir, name))).digest('hex')
      return `${hash}  ${name}`
    })
  writeFileSync(join(releaseDir, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`)
  return response.text()
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: 'inherit' })
  // SAFETY: Node emits `exit` with `(code, signal)`; the first element is the exit code
  // or null when the child was killed by a signal.
  const [code] = await once(child, 'exit') as [number | null]
  if (code !== 0) throw new Error(`${command} exited with status ${code}`)
}

function esbuildBin(): string {
  const bin = join(repoRoot, 'node_modules', '.bin', 'esbuild')
  if (!existsSync(bin)) throw new Error('esbuild binary not found; run bun install first')
  return bin
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
