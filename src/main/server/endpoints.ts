import { networkInterfaces } from 'os'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { createLogger } from '../logger'
import type { DiscoveredServer } from '../../shared/types'

const log = createLogger('main', 'endpoints')

const TAILSCALE_PATHS = ['/usr/local/bin/tailscale', '/usr/bin/tailscale', '/opt/homebrew/bin/tailscale']
const DEFAULT_DISCOVERY_PORT = parseInt(process.env.SOLUS_PORT ?? '') || 3000
const DISCOVERY_PROBE_TIMEOUT_MS = 1500
const DISCOVERY_CONCURRENCY = 8

export interface ReachableEndpoint {
  /** "loopback" | "lan" | "tailnet" */
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
  Online?: unknown
  HostName?: unknown
  DNSName?: unknown
  TailscaleIPs?: unknown
}

interface DiscoveryProbeTarget {
  host: string
  port: number
  name: string
}

/**
 * Enumerates network interfaces the server is reachable on, given the bind
 * address and port. Loopback always shown first; LAN interfaces follow if the
 * server isn't bound to 127.0.0.1; Tailnet endpoints appear when `tailscaled`
 * is running.
 */
export function listReachableEndpoints(bindHost: string, port: number): ReachableEndpoint[] {
  const out: ReachableEndpoint[] = [
    { kind: 'loopback', label: 'Localhost', host: '127.0.0.1', port },
  ]

  // If bound to loopback only, LAN/Tailnet are unreachable from outside.
  if (bindHost === '127.0.0.1') return out

  const ifaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      out.push({
        kind: 'lan',
        label: `${name} (${addr.address})`,
        host: addr.address,
        port,
      })
    }
  }

  const tailnet = detectTailscaleEndpoint(port)
  if (tailnet) out.push(tailnet)

  return out
}

export async function discoverTailnetServers(opts: {
  boundPort: number
  ownInstallationId: string
  fetchImpl?: typeof fetch
}): Promise<DiscoveredServer[]> {
  const status = readTailscaleStatus()
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

export function parseTailscalePeerCandidates(status: unknown): TailnetPeerCandidate[] {
  const peers = (status as { Peer?: unknown } | null)?.Peer
  if (!peers || typeof peers !== 'object') return []

  const out: TailnetPeerCandidate[] = []
  const seen = new Set<string>()
  for (const peer of Object.values(peers as Record<string, TailscaleStatusPeer>)) {
    if (peer?.Online !== true) continue
    const ip = Array.isArray(peer.TailscaleIPs)
      ? peer.TailscaleIPs.find((value): value is string => typeof value === 'string' && /^\d+\./.test(value))
      : null
    if (!ip || seen.has(ip)) continue
    seen.add(ip)
    const name = typeof peer.HostName === 'string' && peer.HostName
      ? peer.HostName
      : typeof peer.DNSName === 'string' && peer.DNSName
        ? peer.DNSName.replace(/\.$/, '')
        : ip
    out.push({ host: ip, name })
  }
  return out
}

function findTailscaleBin(): string | null {
  for (const p of TAILSCALE_PATHS) {
    if (existsSync(p)) return p
  }
  return null
}

function readTailscaleStatus(): unknown | null {
  const bin = findTailscaleBin()
  if (!bin) return null

  try {
    return JSON.parse(execFileSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 1500 }))
  } catch (err) {
    log.debug(`tailscale not reachable: ${err}`)
    return null
  }
}

function detectTailscaleEndpoint(port: number): ReachableEndpoint | null {
  const parsed = readTailscaleStatus()
  const ip = (parsed as { Self?: { TailscaleIPs?: unknown } } | null)?.Self?.TailscaleIPs
  if (Array.isArray(ip)) {
    const ipv4 = ip.find((s): s is string => typeof s === 'string' && /^\d+\./.test(s))
    if (ipv4) return { kind: 'tailnet', label: `Tailnet (${ipv4})`, host: ipv4, port }
  }
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
    const body = await res.json().catch(() => null) as {
      installationId?: unknown
      claimable?: unknown
      name?: unknown
    } | null
    if (!body || typeof body.installationId !== 'string' || body.installationId === ownInstallationId) return null
    return {
      host: target.host,
      port: target.port,
      name: typeof body.name === 'string' && body.name ? body.name : target.name,
      installationId: body.installationId,
      claimable: body.claimable === true,
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
  const out: R[] = new Array(items.length)
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
