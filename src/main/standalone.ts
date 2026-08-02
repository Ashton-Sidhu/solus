import { join } from 'path'
import { createLogger, flushLogs } from './logger'
import { shutdownAnalytics } from './analytics'
import { coerceGitCredentialAction, runGitCredentialHelper, type GitCredentialAction } from './providers/github/git-credential'
import { bestEndpoint, extractGitCredentialAction, formatClaimBlock, hostForUrl, parseFlags, parsePort } from '../shared/entrypoint'
import type { BootCore } from './boot-core'

const log = createLogger('main', 'standalone')

interface StandaloneArgs {
  command: 'serve' | 'auth-session-create' | 'git-credential'
  dataDir?: string
  host?: string
  port?: number
  json?: boolean
  deviceLabel?: string
  credentialAction?: GitCredentialAction
  delegationDeviceId?: string
}

function parseArgs(argv: string[]): StandaloneArgs {
  const portValue = process.env.SOLUS_PORT
  const out: StandaloneArgs = {
    command: 'serve',
    host: process.env.SOLUS_HOST || undefined,
    port: portValue == null || portValue.trim() === '' ? undefined : parsePort(portValue, 'SOLUS_PORT'),
  }

  if (argv[0] === 'auth' && argv[1] === 'session' && argv[2] === 'create') {
    out.command = 'auth-session-create'
    argv = argv.slice(3)
  } else if (argv[0] === 'git-credential') {
    out.command = 'git-credential'
    // Git appends the operation to the configured helper command, so it can trail flags.
    const extracted = extractGitCredentialAction(argv.slice(1), coerceGitCredentialAction)
    out.credentialAction = extracted.action
    argv = extracted.args
  }

  parseFlags(argv, {
    '--json': { set: () => { out.json = true } },
    '--device-label': {
      value: (value) => {
        if (!value) throw new Error('--device-label requires a value')
        out.deviceLabel = value
      },
    },
    '--data-dir': {
      value: (value) => {
        if (!value) throw new Error('--data-dir requires a path')
        out.dataDir = value
      },
      missingValueMessage: '--data-dir requires a path',
    },
    '--delegation': {
      value: (value) => {
        if (!value) throw new Error('--delegation requires a device ID')
        out.delegationDeviceId = value
      },
      missingValueMessage: '--delegation requires a device ID',
    },
  }, (arg) => new Error(`Unknown argument: ${arg}`))

  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dataDir) process.env.SOLUS_DATA_DIR = args.dataDir

  if (args.command === 'git-credential') {
    await runGitCredentialHelper(args.credentialAction ?? 'get', process.stdin, process.stdout, args.delegationDeviceId)
    return
  }

  if (args.command === 'auth-session-create') {
    const auth = await import('./server/auth')
    const result = auth.issueSshBootstrapCredential((args.deviceLabel ?? 'Solus desktop').slice(0, 64))
    process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `${result.sessionToken}\n`)
    return
  }

  const [{ bootCore }, auth, { listReachableEndpoints }] = await Promise.all([
    import('./boot-core'),
    import('./server/auth'),
    import('./server/endpoints'),
  ])

  const core = await bootCore({
    host: args.host,
    port: args.port,
    staticDir: join(__dirname, '../client'),
  })

  const endpoint = bestEndpoint(await listReachableEndpoints(core.booted.host, core.booted.port))!
  const baseUrl = `http://${hostForUrl(endpoint.host)}:${endpoint.port}`
  process.stdout.write(`Solus server reachable at ${baseUrl}\n`)

  const claimWindow = auth.getActiveClaimWindow() ?? auth.ensureClaimWindow()
  if (claimWindow) {
    process.stdout.write([
      '',
      'Solus server is unclaimed.',
      ...formatClaimBlock(`${baseUrl}/claim`, claimWindow.code, claimWindow.expiresAt, auth.getServerFingerprint()),
      '',
    ].join('\n'))
  }

  installShutdownHandlers(core)
}

function installShutdownHandlers(core: BootCore): void {
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write(`\nReceived ${signal}; shutting down Solus server...\n`)
    try {
      try {
        await core.shutdown()
      } finally {
        await shutdownAnalytics()
      }
      flushLogs()
      process.exit(0)
    } catch (err) {
      log.error('standalone_shutdown_failed', { error: err instanceof Error ? err.message : String(err) })
      flushLogs()
      process.exit(1)
    }
  }

  process.once('SIGINT', (signal) => void shutdown(signal))
  process.once('SIGTERM', (signal) => void shutdown(signal))
}

main().catch((err) => {
  log.error('standalone_boot_failed', { error: String(err?.message ?? err) })
  flushLogs()
  process.exit(1)
})
