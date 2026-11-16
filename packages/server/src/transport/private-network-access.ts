import type { RemoteAccessMode } from '@solus/contracts/host-api'
import { isPrivateLanAddress } from './trusted-requesters'
import { isLoopbackAddress } from './websocket'
import { createLogger } from '../logger'

const log = createLogger('main', 'private-network-access')

/** An address from the socket, never a forwarded header. */
export function allowsRemoteAddress(mode: RemoteAccessMode, address: string | undefined): boolean {
  if (mode !== 'private') return true
  if (!address) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  if (isLoopbackAddress(normalized) || isPrivateLanAddress(normalized)) return true
  const parts = normalized.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
}

/** One count per minute for HTTP and socket refusals, even during a flood. */
export function remoteAddressAdmission(mode: () => RemoteAccessMode): (address: string | undefined) => boolean {
  let refused = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  return (address) => {
    if (allowsRemoteAddress(mode(), address)) return true
    refused++
    if (!timer) {
      timer = setTimeout(() => {
        log.info('private_network_requests_refused', { count: refused })
        refused = 0
        timer = null
      }, 60_000)
      timer.unref?.()
    }
    return false
  }
}
