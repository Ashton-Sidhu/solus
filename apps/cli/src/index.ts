import { superviseServer } from './lib/server-supervisor'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { createAdminHeaders, readSigningKey } from './lib/admin-auth'
import { connectHost, connectStatus, disconnectHost, removeOrganization } from './lib/connect'
import { describeConnection, onboard, type OnboardingDeps, type Provider } from './lib/onboarding'
import { isInteractive, terminalPrompter } from './lib/prompts'
import { renderQrAscii } from './lib/qr'
import { defaultDataDir, defaultRuntimeDir, isProcessAlive, localConnectHost, readLockFile, runtimePaths, type RuntimePaths, type ServerLock } from './lib/runtime'
import { runUpdate } from './lib/remote-update-client'
import { runSetup, serviceEnvFor } from './lib/setup'
import { reportStatus } from './lib/status'
import { restartService, serviceStatus, startService, stopService, uninstallService } from './lib/service'
import { bestEndpoint, extractGitCredentialAction, formatPairBlock, hostForUrl, parseFlags, parsePort } from '@solus/contracts/entrypoint'
import packageJson from '../../../package.json'

interface CommonOptions {
  dataDir: string
}

interface StartOptions extends CommonOptions {
  host?: string
  port?: string
}

interface SetupOptions extends CommonOptions {
  /** A link code from Solus; links the server, or attaches it to an organization, once the service is healthy. */
  link?: string
  /** The account plane to sign in to when no code names one; the default is Solus Cloud. */
  cloudUrl?: string
}

interface ConnectCommandOptions extends CommonOptions {
  code?: string
  cloudUrl?: string
  noOpen: boolean
}

interface LogsOptions extends CommonOptions {
  lines: number
}

interface AuthSessionCreateOptions extends CommonOptions {
  json: boolean
  deviceLabel?: string
}

interface GitCredentialOptions extends CommonOptions {
  delegationDeviceId?: string
  memberHome?: boolean
}

interface ChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

function waitForExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
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
    case 'pair':
      await pair(parseCommonOptions(rest))
      return
    case 'connect':
      await connect(rest)
      return
    case 'auth':
      await auth(rest)
      return
    case 'git-credential':
      await gitCredential(rest)
      return
    case 'update':
      await update(parseCommonOptions(rest))
      return
    case 'setup':
      await setup(parseSetupOptions(rest))
      return
    case 'status':
      await status(parseCommonOptions(rest))
      return
    case 'service':
      await service(rest)
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

function printHelp(): void {
  console.log(`solus ${packageJson.version}

Usage:
  solus setup [--data-dir PATH] [--link CODE] [--cloud-url URL]
  solus start [--data-dir PATH] [--host HOST] [--port PORT]
  solus status [--data-dir PATH]
  solus service <start|stop|restart|uninstall|status> [--data-dir PATH]
  solus logs [--data-dir PATH] [--lines N]
  solus pair [--data-dir PATH]
  solus connect [--data-dir PATH] [--code CODE] [--cloud-url URL] [--no-open]
  solus connect status [--data-dir PATH] [--json]
  solus connect remove ORGANIZATION_ID [--data-dir PATH]
  solus connect unlink [--data-dir PATH]
  solus auth session create --json [--device-label LABEL] [--data-dir PATH]
  solus git-credential <get|store|erase> [--data-dir PATH] [--delegation DEVICE_ID | --member-home]
  solus update [--data-dir PATH]
  solus --version
  solus --help`)
}

/**
 * One command from a fresh install to a ready server (plans/009-organization-vms.md
 * §5): start the service, then connect it — a link code decides by itself; a
 * terminal asks how the server will be used and offers provider sign-in; without
 * either, the pairing details are printed. Running it again resumes: the service
 * install is idempotent and a linked server is not linked twice.
 */
async function setup(opts: SetupOptions): Promise<void> {
  const paths = runtimePaths(opts.dataDir)
  await runSetup(paths, (line) => console.log(line))
  console.log('')
  await withOnboarding(paths, (deps) => onboard({ dataDir: opts.dataDir, cloudUrl: opts.cloudUrl, link: opts.link, mode: 'setup' }, deps))
}

async function withOnboarding(paths: RuntimePaths, run: (deps: OnboardingDeps) => Promise<void>): Promise<void> {
  const prompter = isInteractive() ? terminalPrompter() : null
  try {
    await run({
      prompter,
      log: (line) => console.log(line),
      connect: connectHost,
      status: connectStatus,
      pairLines: () => pairLines(paths),
      setUpProvider,
    })
  } finally {
    prompter?.close()
  }
}

/** The provider's own sign-in, in this terminal, as the account the service runs as. */
function setUpProvider(provider: Provider): Promise<boolean> {
  const [command, args] = provider === 'claude-code' ? ['claude', ['auth', 'login']] as const : ['codex', ['login', '--device-auth']] as const
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: 'inherit' })
    child.once('error', (error) => {
      console.log(`${command} is not installed on this server (${error.message}). Install it, then run \`${command} ${args.join(' ')}\`.`)
      resolve(false)
    })
    child.once('exit', (code) => resolve(code === 0))
  })
}

async function status(opts: CommonOptions): Promise<void> {
  await reportStatus(runtimePaths(opts.dataDir), (line) => console.log(line))
}

async function service(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args
  const paths = runtimePaths(parseCommonOptions(rest).dataDir)
  const env = serviceEnvFor(paths)
  switch (subcommand) {
    case 'start':
      startService(env)
      console.log('Solus service started.')
      return
    case 'stop':
      stopService(env)
      console.log('Solus service stopped.')
      return
    case 'restart':
      restartService(env)
      console.log('Solus service restarted.')
      return
    case 'uninstall':
      uninstallService(env)
      console.log(`Solus service removed. Data in ${paths.dataDir} was kept.`)
      return
    case 'status': {
      const svc = serviceStatus(env)
      console.log(`Service: ${svc.installed ? (svc.active ? 'active' : svc.enabled ? 'enabled, not running' : 'installed, disabled') : 'not installed'}`)
      if (svc.detail) console.log(`  ${svc.detail}`)
      return
    }
    default:
      throw new Error('Unknown service command. Expected: solus service <start|stop|restart|uninstall|status>')
  }
}

/** The linking steps of `solus setup`, for a server that is already running. */
async function connect(args: string[]): Promise<void> {
  const subcommand = args[0]
  if (subcommand === 'status') {
    const opts = parseConnectStatusOptions(args.slice(1))
    const status = await connectStatus(opts.dataDir)
    console.log(opts.json ? JSON.stringify(status) : describeConnection(status).join('\n'))
    return
  }
  if (subcommand === 'unlink') {
    const dataDir = parseCommonOptions(args.slice(1)).dataDir
    const link = await disconnectHost(dataDir)
    console.log(link.linked
      ? describeConnection(await connectStatus(dataDir)).join('\n')
      : 'Solus: not linked. New work on this server stays here again; organization records stay in their Solus API.')
    return
  }
  if (subcommand === 'remove') {
    const organizationId = args[1]
    if (!organizationId || organizationId.startsWith('-')) throw new Error('Usage: solus connect remove ORGANIZATION_ID')
    const dataDir = parseCommonOptions(args.slice(2)).dataDir
    const standing = await removeOrganization(dataDir, organizationId)
    console.log(describeConnection({ link: (await connectStatus(dataDir)).link, standing }).join('\n'))
    return
  }
  if (subcommand && !subcommand.startsWith('-')) {
    throw new Error('Unknown connect command. Expected: solus connect, status, remove, or unlink')
  }
  const opts = parseConnectOptions(args)
  await withOnboarding(runtimePaths(opts.dataDir), (deps) => onboard({ dataDir: opts.dataDir, cloudUrl: opts.cloudUrl, link: opts.code, noOpen: opts.noOpen, mode: 'connect' }, deps))
}

async function start(opts: StartOptions): Promise<void> {
  const paths = runtimePaths(opts.dataDir)
  mkdirSync(paths.dataDir, { recursive: true })
  mkdirSync(dirname(paths.logFile), { recursive: true })

  process.exitCode = await superviseServer({ runtimeDir: defaultRuntimeDir(), dataDir: opts.dataDir, env: serverEnv(opts) })
}


async function logs(opts: LogsOptions): Promise<void> {
  const paths = runtimePaths(opts.dataDir)
  if (!existsSync(paths.logFile)) {
    console.log(`No log file yet: ${paths.logFile}`)
    return
  }
  const child = spawn('tail', ['-n', String(opts.lines), '-f', paths.logFile], { stdio: 'inherit' })
  const { code } = await waitForExit(child)
  process.exitCode = code ?? 1
}

async function pair(opts: CommonOptions): Promise<void> {
  console.log((await pairLines(runtimePaths(opts.dataDir))).join('\n'))
}

async function pairLines(paths: RuntimePaths): Promise<string[]> {
  const lock = readLockFile(paths.lockFile)
  if (!lock || !isProcessAlive(lock.pid)) throw new Error('Solus server is not running')

  const signingKey = readSigningKey(paths.dataDir)
  if (!signingKey) throw new Error(`No server signing key found at ${join(paths.dataDir, 'server-keys.json')}`)

  const response = await fetch(`${serverBaseUrl(lock)}/pair/open`, {
    method: 'POST',
    headers: { ...createAdminHeaders(signingKey) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`Could not create pair token: ${body?.error ?? response.statusText}`)
  }

  const endpoint = bestEndpoint(Array.isArray(body.endpoints) ? body.endpoints : []) ?? {
    host: localConnectHost(lock.host),
    port: lock.port,
  }
  const baseUrl = `http://${hostForUrl(endpoint.host)}:${endpoint.port}`
  const pairUrl = `${baseUrl}/pair#token=${body.token}`
  return [
    'Pair a client with this server',
    ...formatPairBlock(pairUrl, body.code, Number(body.expiresAt), body.fingerprint),
    ...(isLoopbackHost(endpoint.host)
      ? ['', 'This address works only on this computer. Run `solus connect` to reach the host from anywhere.']
      : []),
    '',
    renderQrAscii(pairUrl),
    '',
    'Run `solus pair` for a new code.',
  ]
}

function isLoopbackHost(host: string): boolean {
  const bare = hostForUrl(host).replace(/^\[|\]$/g, '')
  return bare === 'localhost' || bare === '::1' || bare.startsWith('127.')
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
  const { code, signal } = await waitForExit(child)
  if (signal) process.exitCode = 1
  else process.exitCode = code ?? 1
}

async function gitCredential(args: string[]): Promise<void> {
  // Git appends the operation to the configured helper command, so it can trail flags.
  const { action, args: optionArgs } = extractGitCredentialAction(args, (value) => {
    if (value === 'get' || value === 'store' || value === 'erase') return value
    throw new Error('Unknown git-credential action. Expected: solus git-credential <get|store|erase>')
  })
  const opts = parseGitCredentialOptions(optionArgs)
  const paths = runtimePaths(opts.dataDir)
  const child = spawn(
    paths.nodePath,
    [
      paths.serverEntry,
      'git-credential', action,
      '--data-dir', opts.dataDir,
      ...(opts.delegationDeviceId ? ['--delegation', opts.delegationDeviceId] : []),
      ...(opts.memberHome ? ['--member-home'] : []),
    ],
    { stdio: 'inherit' },
  )
  const { code, signal } = await waitForExit(child)
  if (signal) process.exitCode = 1
  else process.exitCode = code ?? 1
}

async function update(opts: CommonOptions): Promise<void> {
  await runUpdate(runtimePaths(opts.dataDir), (line) => console.log(line))
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

function parseConnectOptions(args: string[]): ConnectCommandOptions {
  const opts: ConnectCommandOptions = { dataDir: defaultDataDir(), noOpen: false }
  parseFlags(args, {
    '--data-dir': { value: (value) => { opts.dataDir = value } },
    '--cloud-url': { value: (value) => { opts.cloudUrl = value } },
    '--no-open': { set: () => { opts.noOpen = true } },
    '--code': { value: (value) => { opts.code = value.trim() } },
  }, (arg) => new Error(`Unknown connect option: ${arg}`))
  return opts
}

function parseSetupOptions(args: string[]): SetupOptions {
  const opts: SetupOptions = { dataDir: defaultDataDir() }
  parseFlags(args, {
    '--data-dir': { value: (value) => { opts.dataDir = value } },
    '--link': { value: (value) => { opts.link = value.trim() } },
    '--cloud-url': { value: (value) => { opts.cloudUrl = value } },
  }, (arg) => new Error(`Unknown setup option: ${arg}`))
  return opts
}

function parseConnectStatusOptions(args: string[]): CommonOptions & { json: boolean } {
  const opts = { dataDir: defaultDataDir(), json: false }
  parseFlags(args, {
    '--data-dir': { value: (value) => { opts.dataDir = value } },
    '--json': { set: () => { opts.json = true } },
  }, (arg) => new Error(`Unknown connect status option: ${arg}`))
  return opts
}

function parseGitCredentialOptions(args: string[]): GitCredentialOptions {
  const opts: GitCredentialOptions = { dataDir: defaultDataDir() }
  parseFlags(args, {
    '--data-dir': { value: (value) => { opts.dataDir = value } },
    '--delegation': {
      value: (value) => {
        if (!value) throw new Error('--delegation requires a device ID')
        opts.delegationDeviceId = value
      },
      missingValueMessage: '--delegation requires a device ID',
    },
    '--member-home': { set: () => { opts.memberHome = true } },
  }, (arg) => new Error(`Unknown git-credential option: ${arg}`))
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

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function serverEnv(opts: StartOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOLUS_DATA_DIR: opts.dataDir,
  }
  if (opts.host) env.SOLUS_HOST = opts.host
  if (opts.port) env.SOLUS_PORT = opts.port
  return env
}

function serverBaseUrl(lock: ServerLock): string {
  return `http://${hostForUrl(localConnectHost(lock.host))}:${lock.port}`
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
