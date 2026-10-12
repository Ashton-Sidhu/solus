import { z } from 'zod'
import type { DiscoveredServer, HostOperatingSystem } from './types'

/**
 * The LAN discovery wire protocol, shared by the server (which answers and
 * scans from desktop) and the mobile app (which scans from the phone). A
 * scanner sends a query to UDP port 34117; every Solus host that hears it
 * answers the sender with its HTTP port, name, and installation id.
 */
export const DISCOVERY_PORT = 34117
export const DISCOVERY_WINDOW_MS = 900
const DISCOVERY_PROTOCOL = 'solus-discovery'
const DISCOVERY_VERSION = 1

export interface DiscoveryQuery {
  protocol: typeof DISCOVERY_PROTOCOL
  version: typeof DISCOVERY_VERSION
  type: 'query'
  nonce: string
}

export interface DiscoveryResponse {
  protocol: typeof DISCOVERY_PROTOCOL
  version: typeof DISCOVERY_VERSION
  type: 'response'
  nonce: string
  port: number
  name: string
  installationId: string
  os?: HostOperatingSystem
}

export type DiscoveryMessage = DiscoveryQuery | DiscoveryResponse

const discoveryNonceSchema = z.string().regex(/^[a-f0-9]{24}$/)
const discoveryMessageSchema = z.discriminatedUnion('type', [
  z.object({
    protocol: z.literal(DISCOVERY_PROTOCOL),
    version: z.literal(DISCOVERY_VERSION),
    type: z.literal('query'),
    nonce: discoveryNonceSchema,
  }).strict(),
  z.object({
    protocol: z.literal(DISCOVERY_PROTOCOL),
    version: z.literal(DISCOVERY_VERSION),
    type: z.literal('response'),
    nonce: discoveryNonceSchema,
    port: z.number().int().min(1).max(65_535),
    installationId: z.string().min(1),
    name: z.string().min(1),
    os: z.enum(['macos', 'windows', 'linux']).optional(),
  }).strict(),
])

export function parseLanDiscoveryMessage(text: string): DiscoveryMessage | null {
  try {
    return discoveryMessageSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

/** A new nonce: 12 random bytes as hex, which the schema requires. */
export function discoveryNonce(randomByte: () => number = () => Math.floor(Math.random() * 256)): string {
  return Array.from({ length: 12 }, () => randomByte().toString(16).padStart(2, '0')).join('')
}

export function discoveryQuery(nonce: string): DiscoveryQuery {
  return { protocol: DISCOVERY_PROTOCOL, version: DISCOVERY_VERSION, type: 'query', nonce }
}

export function discoveryResponse(
  nonce: string,
  host: { port: number; name: string; installationId: string; os?: HostOperatingSystem },
): DiscoveryResponse {
  return { protocol: DISCOVERY_PROTOCOL, version: DISCOVERY_VERSION, type: 'response', nonce, ...host }
}

/**
 * The hosts that answered one scan, from the raw datagrams: only responses to
 * this scan's nonce, never the scanner's own host, and each installation once.
 */
export function discoveredServersFrom(
  packets: ReadonlyArray<{ address: string; text: string }>,
  nonce: string,
  ownInstallationId?: string,
): DiscoveredServer[] {
  const found = new Map<string, DiscoveredServer>()
  for (const packet of packets) {
    const message = parseLanDiscoveryMessage(packet.text)
    if (message?.type !== 'response' || message.nonce !== nonce) continue
    if (message.installationId === ownInstallationId || found.has(message.installationId)) continue
    found.set(message.installationId, {
      host: packet.address,
      port: message.port,
      name: message.name,
      installationId: message.installationId,
      os: message.os,
      source: 'lan',
    })
  }
  return [...found.values()]
}

export interface Ipv4Interface {
  address: string
  netmask: string
}

/** The limited broadcast and each interface's subnet broadcast. */
export function lanBroadcastAddresses(interfaces: readonly Ipv4Interface[]): string[] {
  const addresses = new Set(['255.255.255.255'])
  for (const entry of interfaces) {
    const address = ipv4ToInt(entry.address)
    const netmask = ipv4ToInt(entry.netmask)
    if (address === null || netmask === null) continue
    addresses.add(intToIpv4((address & netmask) | (~netmask >>> 0)))
  }
  return [...addresses]
}

/**
 * Every other address in each interface's /24. iOS drops broadcast datagrams
 * unless Apple grants the multicast entitlement, but it sends unicast to the
 * local network, and a host answers a query from any sender. A wider subnet is
 * swept only in its own /24, which keeps a scan to a few hundred datagrams.
 */
export function lanSweepAddresses(interfaces: readonly Ipv4Interface[]): string[] {
  const addresses = new Set<string>()
  for (const entry of interfaces) {
    const address = ipv4ToInt(entry.address)
    const netmask = ipv4ToInt(entry.netmask)
    if (address === null || netmask === null) continue
    // A contiguous mask's prefix length is the count of its leading ones.
    const prefix = Math.max(24, Math.clz32(~netmask >>> 0))
    if (prefix > 30) continue
    const hostBits = 32 - prefix
    const network = (address >>> hostBits) << hostBits >>> 0
    const count = 2 ** hostBits
    for (let offset = 1; offset < count - 1; offset++) {
      const candidate = (network + offset) >>> 0
      if (candidate !== address) addresses.add(intToIpv4(candidate))
    }
  }
  return [...addresses]
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0)
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.')
}
