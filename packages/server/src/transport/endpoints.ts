import { networkInterfaces, type NetworkInterfaceInfo } from 'os'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { win32 } from 'path'
import { createLogger } from '../logger'
import { findOnPath, getCliPath } from '../cli-env'
import type { DiscoveredServer } from '@solus/contracts/types'
import { z } from 'zod'
import type { HostRoute } from '@solus/contracts/host-routes'

const log = createLogger('main', 'endpoints')

// `tailscale status` on Windows can take seconds: the CLI is slow to start there, and a kill on timeout goes through `taskkill` (as in T3 Code).
const TAILSCALE_STATUS_TIMEOUT_MS = process.platform === 'win32' ? 5_000 : 1_500
const DEFAULT_DISCOVERY_PORT = parseInt(process.env.SOLUS_PORT ?? '') || 3000
const DISCOVERY_PROBE_TIMEOUT_MS = 1500
const DISCOVERY_CONCURRENCY = 8
const TAILSCALE_STATUS_TTL_MS = 5_000
const TAILSCALE_STATUS_MAX_BYTES = 4 * 1024 * 1024

let tailscaleStatusCache: { value: TailscaleStatus | null; expiresAt: number } | null = null
let tailscaleStatusPending: Promise<TailscaleStatus | null> | null = null

export interface ReachableEndpoint {
  kind: 'loopback' | 'lan' | 'tailnet'
  /** Human-readable label, e.g. "Localhost", "Wi-Fi (192.168.1.42)", "Tailnet (100.x.y.z)". */
  label: string
  host: string
  port: number
}

export interface TailnetPeerCandidate {
  host: string
  name: string
}

interface TailscaleStatusPeer {
  Online?: boolean
  HostName?: string
  DNSName?: string
  TailscaleIPs?: string[]
}

interface TailscaleStatus {
  Peer?: Record<string, TailscaleStatusPeer>
  Self?: { TailscaleIPs?: string[] }
}

const tailscaleStatusPeerSchema = z.object({
  Online: z.boolean().optional(),
  HostName: z.string().optional(),
  DNSName: z.string().optional(),
  TailscaleIPs: z.array(z.string()).optional(),
})
const tailscaleStatusSchema = z.object({
  Peer: z.record(z.string(), tailscaleStatusPeerSchema).optional(),
  Self: z.object({ TailscaleIPs: z.array(z.string()).optional() }).optional(),
})
const discoveredHealthSchema = z.object({
  installationId: z.string(),
  name: z.string().optional(),
  os: z.enum(['macos', 'windows', 'linux']).optional(),
})

interface DiscoveryProbeTarget {
  host: string
  port: number
  name: string
}

/**
 * Bridges, tunnels, VPNs, and VM or container networks. Other devices on the
 * LAN usually cannot reach their addresses: macOS keeps a manual address on the
 * Thunderbolt Bridge (`bridge0`) when nothing is connected, and `utun`, `awdl`,
 * `llw`, and `anpi` are tunnels and Apple peer links. Host bridges such as
 * `br0` or `vmbr0` often hold the real LAN address, so they are not here
 * (as in T3 Code #18085).
 */
const HOST_ONLY_INTERFACE =
  /^(bridge\d|utun|ipsec|ppp|tun|tap|wg|docker|br-|veth|virbr|vmnet|vboxnet|VirtualBox|VMware|awdl|llw|anpi)/

/**
 * The external IPv4 addresses of this machine, real LAN interfaces first and
 * host-only interfaces last. Each group keeps the operating system's order.
 */
export function lanAddressesInReachOrder(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): { name: string; address: string }[] {
  const lan: { name: string; address: string }[] = []
  const hostOnly: { name: string; address: string }[] = []
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      ;(HOST_ONLY_INTERFACE.test(name) ? hostOnly : lan).push({ name, address: addr.address })
    }
  }
  return [...lan, ...hostOnly]
}

const ENDPOINT_REACH = { tailnet: 0, lan: 1, loopback: 2 } satisfies Record<ReachableEndpoint['kind'], number>

/**
 * The routes another machine can reach this host at, the widest reach first
 * (docs/plans/host-routes.md D2). Loopback is never one. A listener bound to
 * loopback serves no other machine, so it advertises none.
 */
export async function advertisedRoutes(bindHost: string, port: number): Promise<HostRoute[]> {
  return (await listReachableEndpoints(bindHost, port))
    .filter((endpoint) => endpoint.kind !== 'loopback')
    .sort((a, b) => ENDPOINT_REACH[a.kind] - ENDPOINT_REACH[b.kind])
    .map((endpoint): HostRoute => ({ kind: endpoint.kind === 'tailnet' ? 'tailnet' : 'lan', url: `http://${endpoint.host}:${endpoint.port}` }))
}

/**
 * Enumerates network interfaces the server is reachable on, given the bind
 * address and port. Loopback always shown first; LAN interfaces follow if the
 * server isn't bound to 127.0.0.1; Tailnet endpoints appear when `tailscaled`
 * is running.
 */
export async function listReachableEndpoints(bindHost: string, port: number): Promise<ReachableEndpoint[]> {
  const out: ReachableEndpoint[] = [
    { kind: 'loopback', label: 'Localhost', host: '127.0.0.1', port },
  ]

  // If bound to loopback only, LAN/Tailnet are unreachable from outside.
  if (bindHost === '127.0.0.1') return out

  for (const { name, address } of lanAddressesInReachOrder(networkInterfaces())) {
    out.push({ kind: 'lan', label: `${name} (${address})`, host: address, port })
  }

  const tailnet = await detectTailscaleEndpoint(port)
  if (tailnet) out.push(tailnet)

  return out
}

export async function discoverTailnetServers(opts: {
  boundPort: number
  ownInstallationId: string
  fetchImpl?: typeof fetch
}): Promise<DiscoveredServer[]> {
  const status = await readTailscaleStatus()
  if (!status) return []

  const candidates = parseTailscalePeerCandidates(status)
  const targets = discoveryProbeTargets(candidates, [DEFAULT_DISCOVERY_PORT, opts.boundPort])
  const fetchImpl = opts.fetchImpl ?? fetch
  const found = await mapWithConcurrency(targets, DISCOVERY_CONCURRENCY, (target) =>
    probeDiscoveredServer(target, opts.ownInstallationId, fetchImpl),
  )

  const byInstallation = new Map<string, DiscoveredServer>()
  for (const server of found) {
    if (!server) continue
    if (!byInstallation.has(server.installationId)) byInstallation.set(server.installationId, server)
  }
  return [...byInstallation.values()]
}

export function parseTailscalePeerCandidates<T>(status: T): TailnetPeerCandidate[] {
  const parsed = tailscaleStatusSchema.safeParse(status)
  const peers = parsed.success ? parsed.data.Peer : undefined
  if (!peers) return []

  const out: TailnetPeerCandidate[] = []
  const seen = new Set<string>()
  for (const peer of Object.values(peers)) {
    if (peer?.Online !== true) continue
    const ip = peer.TailscaleIPs?.find((value) => /^\d+\./.test(value)) ?? null
    if (!ip || seen.has(ip)) continue
    seen.add(ip)
    const name = peer.HostName
      ? peer.HostName
      : peer.DNSName
        ? peer.DNSName.replace(/\.$/, '')
        : ip
    out.push({ host: ip, name })
  }
  return out
}

/** The fixed places Tailscale installs its CLI on each platform. */
export function tailscaleInstallPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') return [win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
  return ['/usr/local/bin/tailscale', '/usr/bin/tailscale', '/opt/homebrew/bin/tailscale']
}

function findTailscaleBin(): string | null {
  for (const p of tailscaleInstallPaths(process.platform, process.env)) {
    if (existsSync(p)) return p
  }
  // A Windows install in another folder, or a scoop or winget shim, is on PATH.
  return process.platform === 'win32' ? findOnPath('tailscale', getCliPath()) : null
}

async function readTailscaleStatus(): Promise<TailscaleStatus | null> {
  const now = Date.now()
  if (tailscaleStatusCache && tailscaleStatusCache.expiresAt > now) return tailscaleStatusCache.value
  if (tailscaleStatusPending) return tailscaleStatusPending

  const bin = findTailscaleBin()
  if (!bin) return null

  tailscaleStatusPending = new Promise<TailscaleStatus | null>((resolve) => {
    execFile(
      bin,
      ['status', '--json'],
      { encoding: 'utf8', timeout: TAILSCALE_STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: TAILSCALE_STATUS_MAX_BYTES },
      (error, stdout) => {
        if (error) {
          log.debug('tailscale_not_reachable', { error: error.message })
          resolve(null)
          return
        }
        try {
          resolve(tailscaleStatusSchema.parse(JSON.parse(stdout)))
        } catch (parseError) {
          log.debug('tailscale_status_invalid', {
            error: parseError instanceof Error ? parseError.message : String(parseError),
          })
          resolve(null)
        }
      },
    )
  }).then((value) => {
    tailscaleStatusCache = { value, expiresAt: Date.now() + TAILSCALE_STATUS_TTL_MS }
    return value
  }).finally(() => {
    tailscaleStatusPending = null
  })

  return tailscaleStatusPending
}

async function detectTailscaleEndpoint(port: number): Promise<ReachableEndpoint | null> {
  return tailnetEndpointFromStatus(await readTailscaleStatus(), port)
}

/**
 * Every address on this machine's tailnet — its own and its peers'. Membership
 * in the user's tailnet is what "trusted network" means for requester auth:
 * these devices already share a private, identity-checked network.
 */
export async function tailnetAddresses(): Promise<Set<string>> {
  const status = await readTailscaleStatus()
  const out = new Set<string>()
  if (!status) return out
  for (const address of status.Self?.TailscaleIPs ?? []) out.add(address)
  for (const peer of Object.values(status.Peer ?? {})) {
    for (const address of peer.TailscaleIPs ?? []) out.add(address)
  }
  return out
}

export function tailnetEndpointFromStatus<T>(value: T, port: number): ReachableEndpoint | null {
  const parsed = tailscaleStatusSchema.safeParse(value)
  const ipv4 = parsed.success
    ? parsed.data.Self?.TailscaleIPs?.find((address) => /^\d+\./.test(address))
    : undefined
  if (ipv4) return { kind: 'tailnet', label: `Tailnet (${ipv4})`, host: ipv4, port }
  return null
}

function discoveryProbeTargets(candidates: TailnetPeerCandidate[], ports: number[]): DiscoveryProbeTarget[] {
  const out: DiscoveryProbeTarget[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    for (const port of ports) {
      const key = `${candidate.host}:${port}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ host: candidate.host, port, name: candidate.name })
    }
  }
  return out
}

async function probeDiscoveredServer(
  target: DiscoveryProbeTarget,
  ownInstallationId: string,
  fetchImpl: typeof fetch,
): Promise<DiscoveredServer | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_PROBE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`http://${target.host}:${target.port}/health`, { signal: controller.signal })
    if (!res.ok) return null
    const parsed = discoveredHealthSchema.safeParse(await res.json().catch(() => null))
    if (!parsed.success || parsed.data.installationId === ownInstallationId) return null
    const body = parsed.data
    return {
      host: target.host,
      port: target.port,
      name: body.name || target.name,
      installationId: body.installationId,
      os: body.os,
      source: 'tailnet',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await mapper(items[index])
    }
  })
  await Promise.all(workers)
  return out
}
