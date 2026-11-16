import { execFile } from 'child_process'
import { connect } from 'net'
import { z } from 'zod'
import { findTailscaleBin, readTailscaleStatus, type TailscaleStatus } from '../transport/endpoints'
import type { TailscaleServeStatus } from '@solus/contracts/host-api'
import type { HostRoute } from '@solus/contracts/host-routes'
import { getServerSettings } from './settings'
import { getInstallationId } from '../admission/auth'
import { setOwnMagicDnsName } from '../transport/web-page-requests'

export type ServeCommand = (args: string[]) => Promise<string>

const serveConfigSchema = z.object({
  TCP: z.record(z.string(), z.object({ TCPForward: z.string().optional() })).optional(),
  Web: z.record(z.string(), z.object({ Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional() })).optional(),
})
const serveStatusSchema = serveConfigSchema.extend({
  Services: z.record(z.string(), serveConfigSchema).optional(),
  Foreground: z.record(z.string(), serveConfigSchema).optional(),
}).nullable()

function targetsThisPort(proxy: string | undefined, localPort: number): boolean {
  if (!proxy) return false
  try {
    const url = new URL(/^\d+$/.test(proxy) ? `http://127.0.0.1:${proxy}` : /^[a-z]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port) === localPort
  } catch { return false }
}

function otherRootLoopbackTarget(raw: string, servePort: number): { host: string; port: number } | null {
  const parsed = serveStatusSchema.safeParse(JSON.parse(raw))
  if (!parsed.success || !parsed.data) return null
  for (const [hostPort, site] of Object.entries(parsed.data.Web ?? {})) {
    if (Number(hostPort.slice(hostPort.lastIndexOf(':') + 1)) !== servePort) continue
    const proxy = site.Handlers?.['/']?.Proxy
    if (!proxy) continue
    try {
      const target = new URL(/^\d+$/.test(proxy) ? `http://127.0.0.1:${proxy}` : /^[a-z]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`)
      if (['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) return { host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) }
    } catch { /* An unknown target remains another owner's mapping. */ }
  }
  return null
}

async function hasListener(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.setTimeout(500)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

interface ServeMapping { port: number; mount: string; owner?: string; foreground?: boolean }

function mappingsToPort(raw: string, localPort: number): ServeMapping[] {
  const parsed = serveStatusSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('Tailscale Serve status is invalid.')
  const mappings: ServeMapping[] = []
  const collect = (config: z.infer<typeof serveConfigSchema>, owner?: string, foreground?: boolean) => {
    for (const [hostPort, site] of Object.entries(config.Web ?? {})) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    for (const [mount, handler] of Object.entries(site.Handlers ?? {})) {
      if (targetsThisPort(handler.Proxy, localPort)) mappings.push({ port, mount, owner, foreground })
    }
    }
  }
  if (parsed.data) {
    collect(parsed.data)
    for (const [owner, config] of Object.entries(parsed.data.Services ?? {})) collect(config, owner)
    for (const config of Object.values(parsed.data.Foreground ?? {})) collect(config, undefined, true)
  }
  return mappings
}

export function serveError(error: string, platform = process.platform): string {
  if (/not logged in|logged out|needs? login/i.test(error)) return 'Sign in to Tailscale, then try again.'
  if (/not running|stopped|failed to connect to local tailscale|connection refused/i.test(error)) return 'Start Tailscale, then try again.'
  if (/https|certificate/i.test(error) && /disabled|enable|not enabled/i.test(error)) return 'Enable HTTPS certificates at https://login.tailscale.com/admin/dns, then try again.'
  if (/permission denied|access denied|must be root|operation not permitted/i.test(error)) return platform === 'linux'
    ? 'Run `sudo tailscale set --operator=$USER`, then try again.'
    : 'Tailscale did not allow this user to change Serve. Check Tailscale permissions.'
  if (/doesn.t support connecting to remote destinations/i.test(error)) return 'This Tailscale install cannot proxy this target. Set the target to 127.0.0.1.'
  return 'Tailscale Serve did not start. Check `tailscale serve status` and try again.'
}

export function serveUrl(name: string, port: number): string {
  return `https://${name.replace(/\.$/, '')}${port === 443 ? '' : `:${port}`}`
}

/** Root handlers only. A path or a TCP forward on the port is another owner's mapping. */
export function serveOwnership(raw: string, servePort: number, localPort: number): 'none' | 'ours' | 'other' {
  const parsed = serveStatusSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error('Tailscale Serve status is invalid.')
  const status = parsed.data
  if (!status) return 'none'
  if (status.TCP?.[String(servePort)]?.TCPForward) return 'other'
  let found = false
  for (const [hostPort, site] of Object.entries(status.Web ?? {})) {
    if (Number(hostPort.slice(hostPort.lastIndexOf(':') + 1)) !== servePort) continue
    const root = site.Handlers?.['/']
    if (!root) continue
    found = true
    if (!targetsThisPort(root.Proxy, localPort)) return 'other'
  }
  if (found) return 'ours'
  for (const config of [...Object.values(status.Services ?? {}), ...Object.values(status.Foreground ?? {})]) {
    if (config.TCP?.[String(servePort)]?.TCPForward) return 'other'
    if (Object.entries(config.Web ?? {}).some(([hostPort, site]) => Number(hostPort.slice(hostPort.lastIndexOf(':') + 1)) === servePort && site.Handlers?.['/'])) return 'other'
  }
  return 'none'
}

export function serveMappingsToPort(raw: string, localPort: number): number[] {
  return mappingsToPort(raw, localPort).map((mapping) => mapping.port)
}

export const systemServeCommand: ServeCommand = async (args) => {
  const executable = findTailscaleBin()
  if (!executable) throw new Error('Install the Tailscale CLI, then try again.')
  return new Promise((resolve, reject) => execFile(executable, args, {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  }, (error, stdout, stderr) => error ? reject(new Error(serveError(stderr || error.message))) : resolve(stdout)))
}

export class TailscaleServe {
  private madePort: number | null = null
  private repairTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly command: ServeCommand = systemServeCommand, private readonly fetchImpl: typeof fetch = fetch,
    private readonly readStatus: () => Promise<TailscaleStatus | null> = readTailscaleStatus,
    private readonly listenerExists: (host: string, port: number) => Promise<boolean> = hasListener) {}

  async status(enabled: boolean, port: number, localPort: number): Promise<TailscaleServeStatus> {
    const status = await this.readStatus()
    if (!enabled) return { enabled, port, state: 'off', url: status?.Self?.DNSName ? serveUrl(status.Self.DNSName, port) : null, error: null }
    if (!status || (status.BackendState && status.BackendState !== 'Running')) return { enabled, port, state: 'error', url: null, error: 'Start and sign in to Tailscale, then try again.' }
    const name = status.Self?.DNSName?.replace(/\.$/, '')
    if (!name) return { enabled, port, state: 'error', url: null, error: 'Enable MagicDNS in Tailscale, then try again.' }
    setOwnMagicDnsName(name)
    if (status.Self?.CapMap && !Object.hasOwn(status.Self.CapMap, 'https')) return { enabled, port, state: 'error', url: null, error: serveError('HTTPS certificates disabled') }
    const url = serveUrl(name, port)
    try {
      const raw = await this.command(['serve', 'status', '--json'])
      let owner = serveOwnership(raw, port, localPort)
      if (owner === 'other') {
        const target = otherRootLoopbackTarget(raw, port)
        if (target && !(await this.listenerExists(target.host, target.port))) owner = 'none'
      }
      return { enabled, port, state: owner === 'ours' ? 'active' : owner === 'other' ? 'other' : 'ready', url, error: owner === 'other' ? 'Another service uses this HTTPS port.' : null }
    } catch (error) {
      return { enabled, port, state: 'error', url, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async enable(port: number, localPort: number): Promise<TailscaleServeStatus> {
    const current = await this.status(true, port, localPort)
    if (current.state === 'error' || current.state === 'other') throw new Error(current.error ?? 'Tailscale Serve is unavailable.')
    if (current.state !== 'active') {
      await this.command(['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${localPort}`])
      this.madePort = port
    }
    const next = await this.status(true, port, localPort)
    if (next.state !== 'active') throw new Error(next.error ?? 'Tailscale Serve did not start.')
    this.madePort = port
    return next
  }

  async disable(port: number, localPort: number): Promise<void> {
    const raw = await this.command(['serve', 'status', '--json'])
    if (serveOwnership(raw, port, localPort) === 'ours') await this.command(['serve', `--https=${port}`, '--set-path=/', 'off'])
    if (this.madePort === port) this.madePort = null
    this.stopRepair()
  }

  async probe(url: string, installationId: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2500) })
      if (!response.ok) return false
      const health = z.object({ installationId: z.string() }).safeParse(await response.json())
      return health.success && health.data.installationId === installationId
    } catch { return false }
  }

  startRepair(port: number, localPort: number, onChanged?: (status: TailscaleServeStatus) => void): void {
    this.stopRepair()
    let lastState: TailscaleServeStatus['state'] = 'active'
    let lastError: string | null = null
    this.repairTimer = setInterval(() => {
      void (async () => {
        let status = await this.status(true, port, localPort)
        if (status.state === 'ready') {
          try { status = await this.enable(port, localPort) }
          catch { status = await this.status(true, port, localPort) }
        }
        if (status.state !== lastState || status.error !== lastError) onChanged?.(status)
        lastState = status.state
        lastError = status.error
      })().catch(() => { /* A later check retries. */ })
    }, 30_000)
    this.repairTimer.unref?.()
  }

  stopRepair(): void {
    if (this.repairTimer) clearInterval(this.repairTimer)
    this.repairTimer = null
  }

  async shutdown(localPort: number): Promise<void> {
    this.stopRepair()
    if (this.madePort !== null) await this.disable(this.madePort, localPort)
  }

  /** Called before bind when policy forbids remote access. */
  async removeMappingsToPort(localPort: number): Promise<void> {
    let raw: string
    try { raw = await this.command(['serve', 'status', '--json']) }
    catch (error) {
      if (/Install the Tailscale CLI|Start Tailscale|Sign in to Tailscale/.test(String(error))) return
      throw error
    }
    for (const mapping of mappingsToPort(raw, localPort)) {
      if (mapping.foreground) continue
      await this.command(['serve', ...(mapping.owner ? [`--service=${mapping.owner}`] : []), `--https=${mapping.port}`, `--set-path=${mapping.mount}`, 'off'])
    }
    const remaining = mappingsToPort(await this.command(['serve', 'status', '--json']), localPort)
    if (remaining.length) throw new Error(`A Tailscale Serve mapping still publishes this host. Run \`tailscale serve --https=${remaining[0].port} --set-path=${remaining[0].mount} off\`, then try again.`)
  }
}

export async function advertisedServeRoute(localPort: number): Promise<HostRoute | null> {
  const setting = getServerSettings().tailscaleServe
  if (!setting.enabled) return null
  const serve = new TailscaleServe()
  const status = await serve.status(true, setting.port, localPort)
  if (status.state !== 'active' || !status.url) return null
  return verifiedServeRoute(status, await serve.probe(status.url, getInstallationId()))
}

export function verifiedServeRoute(status: TailscaleServeStatus, matchesInstallation: boolean): HostRoute | null {
  return status.state === 'active' && status.url && matchesInstallation ? { kind: 'tailnet', url: status.url } : null
}
