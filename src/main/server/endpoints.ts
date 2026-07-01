import { networkInterfaces } from 'os'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { createLogger } from '../logger'

const log = createLogger('main', 'endpoints')

const TAILSCALE_PATHS = ['/usr/local/bin/tailscale', '/usr/bin/tailscale', '/opt/homebrew/bin/tailscale']

export interface ReachableEndpoint {
  /** "loopback" | "lan" | "tailnet" */
  kind: 'loopback' | 'lan' | 'tailnet'
  /** Human-readable label, e.g. "Localhost", "Wi-Fi (192.168.1.42)", "Tailnet (100.x.y.z)". */
  label: string
  host: string
  port: number
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

function findTailscaleBin(): string | null {
  for (const p of TAILSCALE_PATHS) {
    if (existsSync(p)) return p
  }
  return null
}

function detectTailscaleEndpoint(port: number): ReachableEndpoint | null {
  const bin = findTailscaleBin()
  if (!bin) return null

  try {
    const json = execFileSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 1500 })
    const parsed = JSON.parse(json)
    const ip = parsed?.Self?.TailscaleIPs?.find((s: string) => /^\d+\./.test(s))
    if (ip) {
      return { kind: 'tailnet', label: `Tailnet (${ip})`, host: ip, port }
    }
  } catch (err) {
    log.debug(`tailscale not reachable: ${err}`)
  }
  return null
}
