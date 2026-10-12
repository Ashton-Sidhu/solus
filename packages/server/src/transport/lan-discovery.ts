import { createSocket, type RemoteInfo, type Socket } from 'dgram'
import { randomBytes } from 'crypto'
import { networkInterfaces } from 'os'
import { createLogger } from '../logger'
import type { DiscoveredServer } from '@solus/contracts/types'
import {
  DISCOVERY_PORT,
  DISCOVERY_WINDOW_MS,
  discoveredServersFrom,
  discoveryQuery,
  discoveryResponse,
  lanBroadcastAddresses,
  parseLanDiscoveryMessage,
  type DiscoveryQuery,
  type Ipv4Interface,
} from '@solus/contracts/lan-discovery'
import { hostOperatingSystem } from '../platform/host-operating-system'

/** A managed host's boot (packaging/managed-host) and the workspace service have no local network to announce themselves on. */
export function isLanDiscoveryDisabled(
  env: { SOLUS_TEST_MODE?: string; SOLUS_NO_LAN_DISCOVERY?: string; SOLUS_API?: string } = process.env,
): boolean {
  return env.SOLUS_TEST_MODE === '1' || env.SOLUS_NO_LAN_DISCOVERY === '1' || env.SOLUS_API === '1'
}

const log = createLogger('main', 'lan-discovery')

export interface LanDiscoveryAdvertisement {
  port: number
  name: string
  installationId: string
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
  const pending = new Map<string, Array<{ address: string; text: string }>>()

  socket.on('message', (packet, remote) => {
    const text = packet.toString('utf8')
    const message = parseLanDiscoveryMessage(text)
    if (!message) return

    if (message.type === 'query') {
      respondToQuery(socket, message, remote, getAdvertisement())
      return
    }

    pending.get(message.nonce)?.push({ address: remote.address, text })
  })
  socket.on('error', (err) => log.warn('lan_discovery_socket_error', { error: err.message }))

  await bindSocket(socket)
  socket.setBroadcast(true)

  return {
    discoverServers: async () => {
      const nonce = randomBytes(12).toString('hex')
      const packets: Array<{ address: string; text: string }> = []
      pending.set(nonce, packets)
      try {
        const packet = Buffer.from(JSON.stringify(discoveryQuery(nonce)))
        await Promise.allSettled(lanBroadcastAddresses(lanInterfaces()).map((address) => send(socket, packet, address)))
        await new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_WINDOW_MS))
        return discoveredServersFrom(packets, nonce, getAdvertisement().installationId)
      } finally {
        pending.delete(nonce)
      }
    },
    close: () => closeSocket(socket),
  }
}

function respondToQuery(
  socket: Socket,
  query: DiscoveryQuery,
  remote: RemoteInfo,
  advertisement: LanDiscoveryAdvertisement,
): void {
  if (!advertisement.isReachable) return
  const response = discoveryResponse(query.nonce, {
    port: advertisement.port,
    name: advertisement.name,
    installationId: advertisement.installationId,
    os: hostOperatingSystem(),
  })
  void send(socket, Buffer.from(JSON.stringify(response)), remote.address, remote.port).catch((err) => {
    log.debug('lan_discovery_response_failed', { error: err instanceof Error ? err.message : String(err) })
  })
}

function lanInterfaces(): Ipv4Interface[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
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
