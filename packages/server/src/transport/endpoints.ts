import { networkInterfaces, type NetworkInterfaceInfo } from 'os'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { win32 } from 'path'
import { createLogger } from '../logger'
import { findOnPath, getCliPath } from '../cli-env'
import type { DiscoveredServer } from '@solus/contracts/types'
import { z } from 'zod'
import type { HostRoute } from '@solus/contracts/host-routes'
import { hostCategory } from '../host/host-category'
import { isCloudMachine } from '../host/cloud-machine'
import { DEFAULT_DESKTOP_SERVER_PORT, DEFAULT_SERVER_PORT } from '@solus/contracts/types'

const log = createLogger('main', 'endpoints')

// `tailscale status` on Windows can take seconds: the CLI is slow to start there, and a kill on timeout goes through `taskkill` (as in T3 Code).
const TAILSCALE_STATUS_TIMEOUT_MS = process.platform === 'win32' ? 5_000 : 1_500
const DISCOVERY_PORTS = [DEFAULT_SERVER_PORT, DEFAULT_DESKTOP_SERVER_PORT, Number.parseInt(process.env.SOLUS_PORT ?? '', 10)].filter(
  (port) => Number.isInteger(port) && port > 0 && port <= 65535,
)
const DISCOVERY_PROBE_TIMEOUT_MS = 1500
const DISCOVERY_CONCURRENCY = 8
const TAILSCALE_STATUS_TTL_MS = 5_000
const TAILSCALE_STATUS_MAX_BYTES = 4 * 1024 * 1024

let tailscaleStatusCache: { value: TailscaleStatus | null; expiresAt: number } | null = null
let tailscaleStatusPending: Promise<TailscaleStatus | null> | null = null
let lastReadTailscaleStatus: TailscaleStatus | null = null

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
  ExitNode?: boolean
  HostName?: string
  DNSName?: string
  TailscaleIPs?: string[]
  UserID?: number
  ShareeNode?: boolean
}

interface TailscaleStatus {
  Peer?: Record<string, TailscaleStatusPeer>
  Self?: { TailscaleIPs?: string[]; UserID?: number; DNSName?: string }
  ExitNodeStatus?: object | null
}

const tailscaleStatusPeerSchema = z.object({
  Online: z.boolean().optional(),
  ExitNode: z.boolean().optional(),
  HostName: z.string().optional(),
  DNSName: z.string().optional(),
  TailscaleIPs: z.array(z.string()).optional(),
  UserID: z.number().optional(),
  ShareeNode: z.boolean().optional(),
})
const tailscaleStatusSchema = z.object({
  Peer: z.record(z.string(), tailscaleStatusPeerSchema).optional(),
  Self: z.object({ TailscaleIPs: z.array(z.string()).optional(), UserID: z.number().optional(), DNSName: z.string().optional() }).optional(),
  ExitNodeStatus: z.object({}).nullish(),
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
  // A managed host's internal cloud network is not reachable from its clients.
  // The account directory supplies its tunnel route.
  if (hostCategory() === 'managed') return []
  const routes = (await listReachableEndpoints(bindHost, port))
    .filter((endpoint) => endpoint.kind !== 'loopback')
    .sort((a, b) => ENDPOINT_REACH[a.kind] - ENDPOINT_REACH[b.kind])
    .map((endpoint): HostRoute => ({ kind: endpoint.kind === 'tailnet' ? 'tailnet' : 'lan', url: `http://${endpoint.host}:${endpoint.port}` }))
  return cloudRoutes(routes, await isCloudMachine())
}

/** Keep current routes when a cloud machine has no tailnet path yet. */
export function cloudRoutes(routes: HostRoute[], isCloud: boolean): HostRoute[] {
  if (!isCloud || !routes.some((route) => route.kind === 'tailnet')) return routes
  return routes.filter((route) => route.kind === 'tailnet')
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
  if (tailnet) {
    // Pairing reads this endpoint list too. Cloud-private interfaces cannot be reached by clients.
    if (await isCloudMachine()) return [out[0], tailnet]
    out.push(tailnet)
  }

  return out
}

export async function discoverTailnetServers(opts: {
  boundPort: number
  ownInstallationId: string
  fetchImpl?: typeof fetch
  status?: TailscaleStatus
}): Promise<DiscoveredServer[]> {
  const status = opts.status ?? await readTailscaleStatus()
  if (!status) return []

  const candidates = parseTailscalePeerCandidates(status)
  const targets = discoveryProbeTargets(candidates, [...new Set([...DISCOVERY_PORTS, opts.boundPort])])
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
    const name = peer.DNSName?.split('.')[0] || peer.HostName?.trim() || ip
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
  return findOnPath('tailscale', getCliPath())
}

/** The exit node this machine sends its traffic through; null when none is on or Tailscale is absent. */
export async function readTailscaleExitNode(): Promise<{ name: string | null } | null> {
  const status = await readTailscaleStatus()
  if (!status?.ExitNodeStatus) return null
  const peer = Object.values(status.Peer ?? {}).find((candidate) => candidate.ExitNode === true)
  // The DNS label is the tailnet machine name; HostName is the OS name and ignores renames.
  return { name: peer?.DNSName?.split('.')[0] || peer?.HostName?.trim() || null }
}

export async function readTailscaleStatus(): Promise<TailscaleStatus | null> {
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
  }).then((read) => {
    if (read) lastReadTailscaleStatus = read
    const value = read ?? statusWhileAddressHeld(lastReadTailscaleStatus, networkInterfaces())
    tailscaleStatusCache = { value, expiresAt: Date.now() + TAILSCALE_STATUS_TTL_MS }
    return value
  }).finally(() => {
    tailscaleStatusPending = null
  })

  return tailscaleStatusPending
}

/**
 * The last status read, while a network interface on this machine still holds its
 * Tailscale address; otherwise null. A failed `tailscale status` does not mean
 * Tailscale stopped: the CLI also fails when no local port is free. Without this,
 * one failed read drops the tailnet from the pairing link and the routes, and
 * stops trusting the host's own tailnet.
 */
export function statusWhileAddressHeld<T extends { Self?: { TailscaleIPs?: string[] } }>(
  lastRead: T | null,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): T | null {
  const ownAddresses = lastRead?.Self?.TailscaleIPs ?? []
  const isHeld = Object.values(interfaces).some((addrs) => addrs?.some((addr) => ownAddresses.includes(addr.address)))
  return isHeld ? lastRead : null
}

async function detectTailscaleEndpoint(port: number): Promise<ReachableEndpoint | null> {
  return tailnetEndpointFromStatus(await readTailscaleStatus(), port)
    ?? tailnetEndpointFromInterfaces(networkInterfaces(), port)
}

/** A paired CGNAT IPv4 and Tailscale ULA on one interface identifies this machine's address. */
export function tailnetEndpointFromInterfaces(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port: number): ReachableEndpoint | null {
  for (const addrs of Object.values(interfaces)) {
    if (!addrs?.some((addr) => addr.family === 'IPv6' && /^fd7a:115c:a1e0:/i.test(addr.address))) continue
    const ipv4 = addrs.find((addr) => addr.family === 'IPv4' && isTailscaleIpv4(addr.address))?.address
    if (ipv4) return { kind: 'tailnet', label: `Tailnet (${ipv4})`, host: ipv4, port }
  }
  return null
}

function isTailscaleIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
}

/**
 * Trust this machine and the owner's own devices. Shared-in and foreign peers
 * still need to pair, even when they can reach this machine on the tailnet.
 */
export async function tailnetAddresses(): Promise<Set<string>> {
  return tailnetAddressesFromStatus(await readTailscaleStatus())
}

export function tailnetAddressesFromStatus<T>(value: T): Set<string> {
  const parsed = tailscaleStatusSchema.safeParse(value)
  const out = new Set<string>()
  if (!parsed.success) return out
  const status = parsed.data
  for (const address of status.Self?.TailscaleIPs ?? []) out.add(address)
  for (const peer of Object.values(status.Peer ?? {})) {
    if (status.Self?.UserID === undefined || peer.UserID !== status.Self.UserID || peer.ShareeNode) continue
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
