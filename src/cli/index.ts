import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { once } from 'events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { createAdminHeaders, readSigningKey } from './lib/admin-auth'
import { renderQrAscii } from './lib/qr'
import { defaultDataDir, isProcessAlive, localConnectHost, readLockFile, runtimePaths, type ServerLock } from './lib/runtime'
import { bestEndpoint, formatClaimBlock, hostForUrl, parseFlags, parsePort } from '../shared/entrypoint'
import packageJson from '../../package.json'

const DEFAULT_RELEASE_REPO = process.env.SOLUS_RELEASE_REPO || 'Ashton-Sidhu/solus'

interface CommonOptions {
  dataDir: string
}

interface StartOptions extends CommonOptions {
  host?: string
  port?: string
}

interface LogsOptions extends CommonOptions {
  lines: number
}

interface UpdateOptions {
  repo: string
}

interface AuthSessionCreateOptions extends CommonOptions {
  json: boolean
  deviceLabel?: string
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    printHelp()
    return
  }
  if (command === '--version' || command === '-v') {
    console.log(packageJson.version)
    return
  }

  switch (command) {
    case 'start':
      await start(parseStartOptions(rest))
      return
    case 'logs':
      await logs(parseLogsOptions(rest))
      return
    case 'claim':
      await claim(parseCommonOptions(rest))
      return
    case 'auth':
      await auth(rest)
      return
    case 'git-credential':
      await gitCredential(rest)
      return
    case 'update':
      await update(parseUpdateOptions(rest))
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

function printHelp(): void {
  console.log(`solus ${packageJson.version}

Usage:
  solus start [--data-dir PATH] [--host HOST] [--port PORT]
  solus logs [--data-dir PATH] [--lines N]
  solus claim [--data-dir PATH]
  solus auth session create --json [--device-label LABEL] [--data-dir PATH]
  solus git-credential <get|store|erase> [--data-dir PATH]
  solus update [--repo OWNER/REPO]
  solus --version
  solus --help`)
}

async function start(opts: StartOptions): Promise<void> {
  const paths = runtimePaths(opts.dataDir)
  mkdirSync(paths.dataDir, { recursive: true })
  mkdirSync(dirname(paths.logFile), { recursive: true })

  const child = spawn(paths.nodePath, [paths.serverEntry, '--data-dir', paths.dataDir], {
    env: serverEnv(opts),
    stdio: 'inherit',
  })
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  if (signal) process.exitCode = 1
  else process.exitCode = code ?? 1
}


async function logs(opts: LogsOptions): Promise<void> {
  const paths = runtimePaths(opts.dataDir)
  if (!existsSync(paths.logFile)) {
    console.log(`No log file yet: ${paths.logFile}`)
    return
  }
  const child = spawn('tail', ['-n', String(opts.lines), '-f', paths.logFile], { stdio: 'inherit' })
  const [code] = await once(child, 'exit') as [number | null]
  process.exitCode = code ?? 1
}

async function claim(opts: CommonOptions): Promise<void> {
  const paths = runtimePaths(opts.dataDir)
  const lock = readLockFile(paths.lockFile)
  if (!lock || !isProcessAlive(lock.pid)) throw new Error('Solus server is not running')

  const signingKey = readSigningKey(paths.dataDir)
  if (!signingKey) throw new Error(`No server signing key found at ${join(paths.dataDir, 'server-keys.json')}`)

  const response = await fetch(`${serverBaseUrl(lock)}/claim/open`, {
    method: 'POST',
    headers: createAdminHeaders(signingKey),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`Could not open claim window: ${body?.error ?? response.statusText}`)
  }

  const endpoint = bestEndpoint(Array.isArray(body.endpoints) ? body.endpoints : []) ?? {
    host: localConnectHost(lock.host),
    port: lock.port,
  }
  const baseUrl = `http://${hostForUrl(endpoint.host)}:${endpoint.port}`
  const claimUrl = `${baseUrl}/pair#claim=${body.code}`
  console.log([
    'Solus server claim',
    ...formatClaimBlock(claimUrl, body.code, Number(body.expiresAt), body.fingerprint),
    '',
    renderQrAscii(claimUrl),
  ].join('\n'))
}

async function auth(args: string[]): Promise<void> {
  if (args[0] !== 'session' || args[1] !== 'create') {
    throw new Error('Unknown auth command. Expected: solus auth session create')
  }
  const opts = parseAuthSessionCreateOptions(args.slice(2))
  const paths = runtimePaths(opts.dataDir)
  const childArgs = [
    paths.serverEntry,
    'auth', 'session', 'create',
    '--data-dir', opts.dataDir,
    ...(opts.json ? ['--json'] : []),
    ...(opts.deviceLabel ? ['--device-label', opts.deviceLabel] : []),
  ]
  const child = spawn(paths.nodePath, childArgs, { stdio: 'inherit' })
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  if (signal) process.exitCode = 1
  else process.exitCode = code ?? 1
}

/**
 * Git's credential helper contract: the action is argv[1], the request arrives
 * on stdin and the answer goes to stdout. Both are inherited straight through to
 * the server entry, which is where the keyring lives.
 */
async function gitCredential(args: string[]): Promise<void> {
  const [action, ...rest] = args
  if (action !== 'get' && action !== 'store' && action !== 'erase') {
    throw new Error('Unknown git-credential action. Expected: solus git-credential <get|store|erase>')
  }
  const opts = parseCommonOptions(rest)
  const paths = runtimePaths(opts.dataDir)
  const child = spawn(
    paths.nodePath,
    [paths.serverEntry, 'git-credential', action, '--data-dir', opts.dataDir],
    { stdio: 'inherit' },
  )
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  if (signal) process.exitCode = 1
  else process.exitCode = code ?? 1
}

async function update(opts: UpdateOptions): Promise<void> {
  const paths = runtimePaths()
  if (isBrewManaged(paths.installDir)) {
    console.log('This Solus install appears to be managed by Homebrew. Run: brew upgrade solus')
    return
  }
  if (!isTarballInstall(paths.installDir)) {
    throw new Error('Self-update is only supported from the server tarball install')
  }

  const release = await getLatestRelease(opts.repo)
  const latest = normalizeVersion(release.tag_name)
  const current = normalizeVersion(packageJson.version)
  if (compareVersions(latest, current) <= 0) {
    console.log(`Solus ${packageJson.version} is up to date`)
    return
  }

  const target = artifactTarget()
  const artifactName = `solus-server-${target}.tar.gz`
  const asset = release.assets.find((item) => item.name === artifactName)
  const sums = release.assets.find((item) => item.name === 'SHA256SUMS')
  if (!asset || !sums) throw new Error(`Release ${release.tag_name} is missing ${artifactName} or SHA256SUMS`)

  const tempDir = mkdtempSync(join(tmpdir(), 'solus-update-'))
  try {
    const archive = join(tempDir, artifactName)
    const sumsFile = join(tempDir, 'SHA256SUMS')
    await downloadFile(asset.browser_download_url, archive)
    await downloadFile(sums.browser_download_url, sumsFile)
    verifyArchiveSha256(archive, readFileSync(sumsFile, 'utf-8'), artifactName)

    const nextDir = join(tempDir, 'next')
    mkdirSync(nextDir)
    await run('tar', ['-xzf', archive, '-C', nextDir])

    const backup = `${paths.installDir}.bak-${Date.now()}`
    renameSync(paths.installDir, backup)
    renameSync(nextDir, paths.installDir)
    console.log(`Updated Solus to ${release.tag_name}. Previous install moved to ${basename(backup)}. Restart the server to use the new version.`)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function parseStartOptions(args: string[]): StartOptions {
  const opts: StartOptions = { dataDir: defaultDataDir() }
  parseFlags(args, {
    '--data-dir': { value: (value) => { opts.dataDir = value } },
    '--host': { value: (value) => { opts.host = value } },
    '--port': { value: (value) => { opts.port = String(parsePort(value, '--port')) } },
  }, (arg) => new Error(`Unknown start option: ${arg}`))
  return opts
}

function parseCommonOptions(args: string[]): CommonOptions {
  const opts: CommonOptions = { dataDir: defaultDataDir() }
  parseFlags(args, {
    '--data-dir': { value: (value) => { opts.dataDir = value } },
  }, (arg) => new Error(`Unknown option: ${arg}`))
  return opts
}

function parseAuthSessionCreateOptions(args: string[]): AuthSessionCreateOptions {
  const opts: AuthSessionCreateOptions = { dataDir: defaultDataDir(), json: false }
  parseFlags(args, {
    '--json': { set: () => { opts.json = true } },
    '--data-dir': { value: (value) => { opts.dataDir = value } },
    '--device-label': { value: (value) => { opts.deviceLabel = value } },
  }, (arg) => new Error(`Unknown auth session create option: ${arg}`))
  return opts
}

function parseLogsOptions(args: string[]): LogsOptions {
  const opts: LogsOptions = { dataDir: defaultDataDir(), lines: 100 }
  parseFlags(args, {
    '--data-dir': { value: (value) => { opts.dataDir = value } },
    '--lines': { value: (value) => { opts.lines = parsePositiveInt(value, '--lines') } },
  }, (arg) => new Error(`Unknown logs option: ${arg}`))
  return opts
}

function parseUpdateOptions(args: string[]): UpdateOptions {
  const opts: UpdateOptions = { repo: DEFAULT_RELEASE_REPO }
  parseFlags(args, {
    '--repo': { value: (value) => { opts.repo = value } },
  }, (arg) => new Error(`Unknown update option: ${arg}`))
  return opts
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function serverEnv(opts: StartOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SOLUS_DATA_DIR: opts.dataDir,
    ...(opts.host ? { SOLUS_HOST: opts.host } : {}),
    ...(opts.port ? { SOLUS_PORT: opts.port } : {}),
  }
}

function isBrewManaged(installDir: string): boolean {
  return /\/(?:Cellar|homebrew\/Cellar|linuxbrew\/Cellar)\/solus\//.test(installDir)
}

function isTarballInstall(installDir: string): boolean {
  return existsSync(join(installDir, 'bin', 'node')) &&
    existsSync(join(installDir, 'libexec', 'server', 'standalone.js')) &&
    existsSync(join(installDir, 'libexec', 'cli', 'solus.js'))
}



function serverBaseUrl(lock: ServerLock): string {
  return `http://${hostForUrl(localConnectHost(lock.host))}:${lock.port}`
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

interface GithubRelease {
  tag_name: string
  assets: ReleaseAsset[]
}

async function getLatestRelease(repo: string): Promise<GithubRelease> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `solus-cli/${packageJson.version}`,
    },
  })
  if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status} ${response.statusText}`)
  const body = await response.json() as Partial<GithubRelease>
  if (!body.tag_name || !Array.isArray(body.assets)) throw new Error('GitHub release response was missing tag_name/assets')
  return { tag_name: body.tag_name, assets: body.assets }
}

function artifactTarget(): string {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error(`Unsupported update platform: ${process.platform}`)
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error(`Unsupported update architecture: ${process.arch}`)
  return `${process.platform}-${process.arch}`
}

async function downloadFile(url: string, file: string): Promise<void> {
  const response = await fetch(url, { headers: { 'user-agent': `solus-cli/${packageJson.version}` } })
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  writeFileSync(file, Buffer.from(await response.arrayBuffer()))
}

function verifyArchiveSha256(file: string, sums: string, artifactName: string): void {
  const expected = sums.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === artifactName)?.[0]
  if (!expected) throw new Error(`SHA256SUMS did not contain ${artifactName}`)
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== expected) throw new Error(`Checksum mismatch for ${artifactName}`)
}

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: 'inherit' })
  const [code] = await once(child, 'exit') as [number | null]
  if (code !== 0) throw new Error(`${command} exited with status ${code}`)
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, '')
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part.replace(/\D.*$/, '')))
  const right = b.split('.').map((part) => Number(part.replace(/\D.*$/, '')))
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
