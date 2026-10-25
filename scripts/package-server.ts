import { SERVER_UPDATE_PROTOCOL, SERVER_STORAGE_EPOCH } from '../packages/contracts/src/server-update'
import { createHash } from 'crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { once } from 'events'

const NODE_VERSION = '24.18.0'
const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64'])

interface Target {
  platform: 'darwin' | 'linux' | 'win32'
  arch: 'x64' | 'arm64'
  headless: boolean
}

const repoRoot = resolve(import.meta.dir, '..')

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2))
  const targetName = `${target.platform}-${target.arch}`
  if (!SUPPORTED_TARGETS.has(targetName)) throw new Error(`Unsupported server target: ${targetName}`)
  // The zip comes from Windows' own tar (bsdtar), and npm runs through the
  // downloaded node.exe. A CI runner on Windows packages this target.
  if (target.platform === 'win32' && process.platform !== 'win32') {
    throw new Error('Package the win32-x64 server on Windows.')
  }

  const releaseDir = join(repoRoot, 'release')
  mkdirSync(releaseDir, { recursive: true })

  const workDir = join(tmpdir(), `solus-server-package-${targetName}-${process.pid}`)
  const staging = join(workDir, 'solus-server')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  try {
    copyClient(staging, target.headless)
    await installNodeRuntime(target, staging)
    await buildHeadless(staging)
    copyBundledPlugins(staging)
    copyPreviewBrowserDriver(staging)
    await installFileFinder(target, staging, workDir)
    writeLaunchers(staging, target.platform)
    if (target.platform === 'linux') copyManagedBoot(staging)
    writeNativeNote(staging)
    mkdirSync(join(staging, 'docs'), { recursive: true })
    cpSync(join(repoRoot, 'docs', 'linux-browser.md'), join(staging, 'docs', 'linux-browser.md'))
    writeFileSync(join(staging, 'server-release.json'), JSON.stringify({
      version: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version,
      protocol: SERVER_UPDATE_PROTOCOL,
      storage: createHash('sha256').update(String(SERVER_STORAGE_EPOCH)).update(readFileSync(join(repoRoot, 'packages/server/src/db/migrations.ts'))).digest('hex'),
    }))

    const out = join(releaseDir, `solus-server-${target.headless ? 'headless-' : ''}${targetName}.${target.platform === 'win32' ? 'zip' : 'tar.gz'}`)
    rmSync(out, { force: true })
    // The zip lists the top-level names, not `.`, so no entry starts with `./`.
    if (target.platform === 'win32') await run(windowsTar(), ['-a', '-c', '-f', out, '-C', staging, ...readdirSync(staging)])
    else await run('tar', ['--no-xattrs', '-czf', out, '-C', staging, '.'])
    writeSha256Sums(releaseDir)
    console.log(`Wrote ${out}`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

export function parseTarget(args: string[]): Target {
  let platform = normalizePlatform(process.platform)
  let arch = normalizeArch(process.arch)
  let headless = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--headless') headless = true
    else if (arg === '--platform') platform = normalizePlatform(takeValue(args, ++i, arg))
    else if (arg.startsWith('--platform=')) platform = normalizePlatform(arg.slice('--platform='.length))
    else if (arg === '--arch') arch = normalizeArch(takeValue(args, ++i, arg))
    else if (arg.startsWith('--arch=')) arch = normalizeArch(arg.slice('--arch='.length))
    else throw new Error(`Unknown package-server option: ${arg}`)
  }
  // docs/plans/windows.md §6: Solus builds and tests win32-x64 only.
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error(`Solus builds the Windows server for x64 only; Windows on ARM (win32-${arch}) is not supported.`)
  }
  return { platform, arch, headless }
}

function normalizePlatform(value: string): Target['platform'] {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
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

async function installNodeRuntime(target: Target, staging: string): Promise<void> {
  const binDir = join(staging, 'bin')
  mkdirSync(binDir, { recursive: true })
  if (target.platform === 'win32') return installWindowsNodeRuntime(staging)

  const nodeName = `node-v${NODE_VERSION}-${target.platform}-${target.arch}`
  const archive = await downloadNodeArchive(staging, `${nodeName}.tar.gz`)
  await run('tar', ['-xzf', archive, '-C', binDir, '--strip-components=2', `${nodeName}/bin/node`])
  chmodSync(join(binDir, 'node'), 0o755)
}

/** The verified Node archive for `name`, written beside the staging folder. */
async function downloadNodeArchive(staging: string, name: string): Promise<string> {
  const baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`
  const shasums = await fetchText(`${baseUrl}/SHASUMS256.txt`)
  const expected = shasums.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === name)?.[0]
  if (!expected) throw new Error(`Node SHASUMS256.txt did not contain ${name}`)
  const data = await fetchBytes(`${baseUrl}/${name}`)
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== expected) throw new Error(`Node runtime checksum mismatch for ${name}`)
  const archive = join(dirname(staging), name)
  writeFileSync(archive, data)
  return archive
}

/**
 * Windows Node is a zip with `node.exe` at its root. npm from the same zip
 * goes to the work folder: `installFileFinder` runs it through this node.exe,
 * because `npm` on a Windows PATH is a `.cmd` shim that spawn cannot start
 * without a shell.
 */
async function installWindowsNodeRuntime(staging: string): Promise<void> {
  const nodeName = `node-v${NODE_VERSION}-win-x64`
  const archive = await downloadNodeArchive(staging, `${nodeName}.zip`)
  await run(windowsTar(), ['-xf', archive, '-C', join(staging, 'bin'), '--strip-components=1', `${nodeName}/node.exe`])
  await run(windowsTar(), ['-xf', archive, '-C', dirname(staging), '--strip-components=1', `${nodeName}/node_modules/npm`])
}

/** Windows' own bsdtar, which reads and writes zip. Git's GNU tar can come first on PATH and cannot. */
function windowsTar(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
}

/**
 * The server bundle and the migrations it reads beside itself
 * (packages/server/src/db/migration-files.ts) are one unit: a bundle laid over an
 * older release with that release's `drizzle` folder runs its new queries against
 * the old schema, and the column a migration adds never exists.
 */
export async function buildServerBundle(staging: string): Promise<void> {
  const outdir = join(staging, 'libexec', 'server')
  mkdirSync(outdir, { recursive: true })
  await bundleServerEntry(join(repoRoot, 'apps', 'standalone-server', 'src', 'index.ts'), join(outdir, 'standalone.js'))
  const drizzle = join(outdir, 'drizzle')
  rmSync(drizzle, { recursive: true, force: true })
  cpSync(join(repoRoot, 'packages', 'server', 'drizzle'), drizzle, { recursive: true })
}

/** Compile the standalone runtime and CLI from source without Electron or a client build. */
export async function buildHeadless(staging: string): Promise<void> {
  await buildServerBundle(staging)
  await buildCliBundle(staging)
}

/** One self-contained CommonJS file for Node; the cloud application bundles the record service the same way (scripts/build-record-service.ts). */
export async function bundleServerEntry(entry: string, outfile: string): Promise<void> {
  await run(esbuildBin(), [
    entry,
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--log-level=warning',
    '--define:import.meta.url=__filename',
    `--define:process.env.SOLUS_GOOGLE_CLIENT_ID=${JSON.stringify(process.env.SOLUS_GOOGLE_CLIENT_ID ?? '')}`,
    `--define:process.env.SOLUS_GOOGLE_CLIENT_SECRET=${JSON.stringify(process.env.SOLUS_GOOGLE_CLIENT_SECRET ?? '')}`,
    `--define:process.env.SOLUS_GITHUB_CLIENT_ID=${JSON.stringify(process.env.SOLUS_GITHUB_CLIENT_ID ?? '')}`,
    `--define:process.env.SOLUS_ATLASSIAN_CLIENT_ID=${JSON.stringify(process.env.SOLUS_ATLASSIAN_CLIENT_ID ?? '')}`,
    `--define:process.env.SOLUS_ATLASSIAN_CLIENT_SECRET=${JSON.stringify(process.env.SOLUS_ATLASSIAN_CLIENT_SECRET ?? '')}`,
    `--outfile=${outfile}`,
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

export function copyClient(staging: string, headless: boolean, clientDir = join(repoRoot, 'dist', 'client')): void {
  if (headless) return
  if (!existsSync(join(clientDir, 'index.html'))) {
    throw new Error('Web client build missing. Run "bun run build:client" first, or package with --headless.')
  }
  cpSync(clientDir, join(staging, 'libexec', 'client'), { recursive: true })
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
 * outside the install directory so a redeploy does not discard them. Without
 * the matching browser binary, opening a browser page fails at launch.
 */
function copyPreviewBrowserDriver(staging: string): void {
  const source = join(repoRoot, 'node_modules', 'playwright-core')
  if (!existsSync(source)) {
    throw new Error('playwright-core is not installed; the preview host cannot be packaged without it.')
  }
  cpSync(source, join(staging, 'libexec', 'server', 'node_modules', 'playwright-core'), { recursive: true })
}

/**
 * Ship the file finder, which the bundle keeps external, for the release target.
 *
 * Its native library comes in a package per platform, and the repo holds only
 * the one for the machine that packages the release. So npm fetches the
 * target's packages, at the versions this repo locks, and they land beside the
 * bundle as `playwright-core` does. A Linux release targets glibc. The
 * repo's patch to `@ff-labs/fff-node` only resolves paths inside an Electron
 * `app.asar`, so the standalone server does not need it.
 */
async function installFileFinder(target: Target, staging: string, workDir: string): Promise<void> {
  const installDir = join(workDir, 'file-finder')
  mkdirSync(installDir, { recursive: true })
  writeFileSync(join(installDir, 'package.json'), '{ "private": true }\n')
  const packages = ['@ff-labs/fff-node', 'ffi-rs'].map((name) =>
    `${name}@${JSON.parse(readFileSync(join(repoRoot, 'node_modules', name, 'package.json'), 'utf8')).version}`)
  const npm = target.platform === 'win32'
    ? { command: join(staging, 'bin', 'node.exe'), args: [join(workDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')] }
    : { command: 'npm', args: [] }
  await run(npm.command, [
    ...npm.args,
    'install', '--prefix', installDir,
    '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev',
    `--os=${target.platform}`, `--cpu=${target.arch}`,
    ...(target.platform === 'linux' ? ['--libc=glibc'] : []),
    ...packages,
  ])
  cpSync(join(installDir, 'node_modules'), join(staging, 'libexec', 'server', 'node_modules'), { recursive: true })
}

/** The server links these into the state dir on boot, so they must ship where
 *  bundledResourcesDir() looks: `$SOLUS_INSTALL_DIR/resources`. */
function copyBundledPlugins(staging: string): void {
  cpSync(join(repoRoot, 'resources', 'plugins'), join(staging, 'resources', 'plugins'), { recursive: true })
}

export function writeLaunchers(staging: string, platform: Target['platform']): void {
  const binDir = join(staging, 'bin')
  mkdirSync(binDir, { recursive: true })
  if (platform === 'win32') return writeWindowsLaunchers(binDir)
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
case "\${1-}" in
  auth|git-credential) exec "$ROOT/bin/node" "$ROOT/libexec/server/standalone.js" "$@" ;;
  *) exec "$ROOT/bin/node" "$ROOT/libexec/cli/solus.js" start "$@" ;;
esac
`)
}

/**
 * The `.cmd` forms of the two launchers above. `%~dp0` is this file's folder.
 * `setlocal` keeps SOLUS_INSTALL_DIR out of the caller's console. There is no
 * `chcp 65001`: it changes the code page of the whole console after the
 * launcher ends, and Node writes UTF-8 to a pipe and Unicode to a console
 * without it. CRLF, because cmd.exe misreads labels in a file with LF only.
 */
function writeWindowsLaunchers(binDir: string): void {
  const head = [
    '@echo off',
    'setlocal',
    'for %%I in ("%~dp0..") do set "SOLUS_INSTALL_DIR=%%~fI"',
  ]
  const node = '"%SOLUS_INSTALL_DIR%\\bin\\node.exe"'
  writeFileSync(join(binDir, 'solus.cmd'), crlf([
    ...head,
    `${node} "%SOLUS_INSTALL_DIR%\\libexec\\cli\\solus.js" %*`,
    'exit /b %ERRORLEVEL%',
  ]))
  writeFileSync(join(binDir, 'solus-server.cmd'), crlf([
    ...head,
    'if "%~1"=="auth" goto server',
    'if "%~1"=="git-credential" goto server',
    `${node} "%SOLUS_INSTALL_DIR%\\libexec\\cli\\solus.js" start %*`,
    'exit /b %ERRORLEVEL%',
    ':server',
    `${node} "%SOLUS_INSTALL_DIR%\\libexec\\server\\standalone.js" %*`,
    'exit /b %ERRORLEVEL%',
  ]))
}

function crlf(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

/** A managed host's boot on its Sprite (packaging/managed-host/sprite-boot.sh), run from the release it ships in. */
function copyManagedBoot(staging: string): void {
  const managedDir = join(staging, 'libexec', 'managed')
  mkdirSync(managedDir, { recursive: true })
  const boot = join(managedDir, 'sprite-boot.sh')
  cpSync(join(repoRoot, 'packaging', 'managed-host', 'sprite-boot.sh'), boot)
  chmodSync(boot, 0o755)
}

function writeNativeNote(staging: string): void {
  const nativeDir = join(staging, 'libexec', 'native')
  mkdirSync(nativeDir, { recursive: true })
  writeFileSync(join(nativeDir, 'README.txt'), [
    'onnxruntime-node is intentionally not bundled. Its platform-specific loader',
    'is not trivially copyable across release targets, and the features that',
    'depend on it degrade through existing capability checks.',
    '',
    '@ff-labs/fff-node (the file finder) IS shipped, at',
    'libexec/server/node_modules/@ff-labs/fff-node, with the native library for',
    'this release target. A Linux release targets glibc; on a musl host the file',
    'finder does not load and file search returns no results.',
    '',
    'playwright-core IS shipped, at libexec/server/node_modules/playwright-core,',
    'because the browser host is a feature of this server. Its browser binaries are',
    'not. See docs/linux-browser.md for Linux setup. Using your actual install path,',
    'run as the same OS user that runs the Solus service:',
    '',
    '  /opt/solus/bin/node /opt/solus/libexec/server/node_modules/playwright-core/cli.js install --with-deps chromium',
    '',
    'Linux system dependencies require root or sudo. The browser cache belongs to',
    'the service user. Repeat after updates to install the matching browser revision.',
    'Managed cloud images already include the browser and its system dependencies.',
    '',
  ].join('\n'))
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o755 })
  chmodSync(file, 0o755)
}

export function writeSha256Sums(releaseDir: string): void {
  const lines = readdirSync(releaseDir)
    .filter((name) => /^solus-server-.+\.(tar\.gz|zip)$/.test(name))
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
  // Bun links the binary as esbuild.exe on Windows.
  const bin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.exe' : 'esbuild')
  if (!existsSync(bin)) throw new Error('esbuild binary not found; run bun install first')
  return bin
}

// scripts/push-dev.ts imports the bundle step without packaging a release.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
