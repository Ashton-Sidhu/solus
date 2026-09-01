import { join } from 'path'
import { createLogger, flushLogs } from './logger'
import type { BootCore } from './boot-core'
import type { ReachableEndpoint } from './server/endpoints'

const log = createLogger('main', 'standalone')

interface StandaloneArgs {
  dataDir?: string
  host?: string
  port?: number
}

function parsePort(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid SOLUS_PORT: ${value}`)
  }
  return port
}

function parseArgs(argv: string[]): StandaloneArgs {
  const out: StandaloneArgs = {
    host: process.env.SOLUS_HOST || undefined,
    port: parsePort(process.env.SOLUS_PORT),
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--data-dir') {
      const value = argv[++i]
      if (!value) throw new Error('--data-dir requires a path')
      out.dataDir = value
      continue
    }
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length)
      if (!value) throw new Error('--data-dir requires a path')
      out.dataDir = value
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return out
}

function bestEndpoint(endpoints: ReachableEndpoint[]): ReachableEndpoint {
  return endpoints.find((e) => e.kind === 'tailnet') ??
    endpoints.find((e) => e.kind === 'lan') ??
    endpoints[0]
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function printClaimBlock(baseUrl: string, code: string, expiresAt: number, fingerprint: string): void {
  const ttlMinutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000))
  process.stdout.write([
    '',
    'Solus server is unclaimed.',
    `Claim URL: ${baseUrl}/claim`,
    `Code: ${code}`,
    `Fingerprint: ${fingerprint}`,
    `Expires in: ${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}`,
    '',
  ].join('\n'))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dataDir) process.env.SOLUS_DATA_DIR = args.dataDir

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

  const endpoint = bestEndpoint(listReachableEndpoints(core.booted.host, core.booted.port))
  const baseUrl = `http://${hostForUrl(endpoint.host)}:${endpoint.port}`
  process.stdout.write(`Solus server reachable at ${baseUrl}\n`)

  const claimWindow = auth.getActiveClaimWindow() ?? auth.ensureClaimWindow()
  if (claimWindow) {
    printClaimBlock(baseUrl, claimWindow.code, claimWindow.expiresAt, auth.getServerFingerprint())
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
      await core.shutdown()
      flushLogs()
      process.exit(0)
    } catch (err) {
      log.error(`standalone shutdown failed: ${err}`)
      flushLogs()
      process.exit(1)
    }
  }

  process.once('SIGINT', (signal) => void shutdown(signal))
  process.once('SIGTERM', (signal) => void shutdown(signal))
}

main().catch((err) => {
  log.error(`standalone boot failed: ${err?.message ?? err}`)
  flushLogs()
  process.exit(1)
})
