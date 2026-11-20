import type { PairedDevice } from '@solus/contracts/host-api'
import { relativeTime } from '../../../lib/relative-time'

/** The line under a paired device on the Access tab: revoked, connected now, or when the host last saw it. */
export function pairedDeviceDetail(device: PairedDevice, isConnected: boolean, now = Date.now()): string {
  if (device.revokedAt !== null) return `Revoked ${relativeTime(device.revokedAt, now)}`
  const seen = isConnected ? 'Connected now' : `Last seen ${relativeTime(device.lastSeenAt, now)}`
  return `${seen} · paired ${relativeTime(device.pairedAt, now)}`
}
