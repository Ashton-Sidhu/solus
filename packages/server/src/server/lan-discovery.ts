import { createSocket, type RemoteInfo, type Socket } from 'dgram'
import { randomBytes } from 'crypto'
import { hostname, networkInterfaces } from 'os'
import { createLogger } from '../logger'
import type { DiscoveredServer } from '@solus/contracts/types'
import { z } from 'zod'
import { hostOperatingSystem } from '../platform/host-operating-system'

export function isLanDiscoveryDisabled(
  env: { SOLUS_TEST_MODE?: string; SOLUS_NO_LAN_DISCOVERY?: string } = process.env,
): boolean {
  return env.SOLUS_TEST_MODE === '1' || env.SOLUS_NO_LAN_DISCOVERY === '1'
}

const log = createLogger('main', 'lan-discovery')

const DISCOVERY_PORT = 34117
const DISCOVERY_PROTOCOL = 'solus-discovery'
const DISCOVERY_VERSION = 1
const DISCOVERY_WINDOW_MS = 900

interface DiscoveryQuery {
  protocol: typeof DISCOVERY_PROTOCOL
  version: typeof DISCOVERY_VERSION
  type: 'query'
  nonce: string
}

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
    claimable: z.boolean(),
    os: z.enum(['macos', 'windows', 'linux']).optional(),
  }).strict(),
])

interface DiscoveryResponse {
  protocol: typeof DISCOVERY_PROTOCOL
  version: typeof DISCOVERY_VERSION
  type: 'response'
  nonce: string
  port: number
  name: string
  installationId: string
  claimable: boolean
  os?: DiscoveredServer['os']
}

type DiscoveryMessage = DiscoveryQuery | DiscoveryResponse

export interface LanDiscoveryAdvertisement {
  port: number
  installationId: string
  claimable: boolean
  isReachable: boolean
}

export interface LanDiscoveryService {
  discoverServers(): Promise<DiscoveredServer[]>
  close(): Promise<void>
}

export async function startLanDiscoveryService(
  getAdvertisement: () => LanDiscoveryAdvertisement,
): Promise<LanDiscoveryService> {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  const pending = new Map<string, Map<string, DiscoveredServer>>()

  socket.on('message', (packet, remote) => {
    const message = parseLanDiscoveryMessage(packet)
    if (!message) return

    if (message.type === 'query') {
      respondToQuery(socket, message, remote, getAdvertisement())
      return
    }

    const found = pending.get(message.nonce)
    if (!found) return
    if (message.installationId === getAdvertisement().installationId) return
    const server: DiscoveredServer = {
      host: remote.address,
      port: message.port,
      name: message.name,
      installationId: message.installationId,
      claimable: message.claimable,
      os: message.os,
      source: 'lan',
    }
    if (!found.has(server.installationId)) found.set(server.installationId, server)
  })
  socket.on('error', (err) => log.warn('lan_discovery_socket_error', { error: err.message }))

  await bindSocket(socket)
  socket.setBroadcast(true)

  return {
    discoverServers: async () => {
      const nonce = randomBytes(12).toString('hex')
      const found = new Map<string, DiscoveredServer>()
      pending.set(nonce, found)
      try {
        const query: DiscoveryQuery = {
          protocol: DISCOVERY_PROTOCOL,
          version: DISCOVERY_VERSION,
          type: 'query',
          nonce,
        }
        const packet = Buffer.from(JSON.stringify(query))
        await Promise.allSettled(lanBroadcastAddresses().map((address) => send(socket, packet, address)))
        await new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_WINDOW_MS))
        return [...found.values()]
      } finally {
        pending.delete(nonce)
      }
    },
    close: () => closeSocket(socket),
  }
}

export function parseLanDiscoveryMessage(packet: Buffer): DiscoveryMessage | null {
  try {
    return discoveryMessageSchema.parse(JSON.parse(packet.toString('utf8')))
  } catch {
    return null
  }
}

function respondToQuery(
  socket: Socket,
  query: DiscoveryQuery,
  remote: RemoteInfo,
  advertisement: LanDiscoveryAdvertisement,
): void {
  if (!advertisement.isReachable) return
  const response: DiscoveryResponse = {
    protocol: DISCOVERY_PROTOCOL,
    version: DISCOVERY_VERSION,
    type: 'response',
    nonce: query.nonce,
    port: advertisement.port,
    name: hostname() || 'Solus Server',
    installationId: advertisement.installationId,
    claimable: advertisement.claimable,
    os: hostOperatingSystem(),
  }
  void send(socket, Buffer.from(JSON.stringify(response)), remote.address, remote.port).catch((err) => {
    log.debug('lan_discovery_response_failed', { error: err instanceof Error ? err.message : String(err) })
  })
}

function lanBroadcastAddresses(): string[] {
  const addresses = new Set(['255.255.255.255'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const address = ipv4ToInt(entry.address)
      const netmask = ipv4ToInt(entry.netmask)
      if (address === null || netmask === null) continue
      addresses.add(intToIpv4((address & netmask) | (~netmask >>> 0)))
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

function bindSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      socket.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      socket.off('error', onError)
      resolve()
    }
    socket.once('error', onError)
    socket.once('listening', onListening)
    socket.bind(DISCOVERY_PORT, '0.0.0.0')
  })
}

function send(socket: Socket, packet: Buffer, address: string, port = DISCOVERY_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, port, address, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.close(() => resolve())
  })
}
