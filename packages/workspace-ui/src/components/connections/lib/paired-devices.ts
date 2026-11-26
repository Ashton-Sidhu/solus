import type { AppAccess, PairedDevice } from '@solus/contracts/host-api'
import { relativeTime } from '../../../lib/relative-time'

const APP_ACCESS_LABELS = {
  read: 'Read',
  write: 'Read and write',
  full: 'Full',
} satisfies Record<AppAccess, string>

/** The access an outside app was given, as the paired devices list names it. */
export function appAccessLabel(access: AppAccess): string {
  return APP_ACCESS_LABELS[access]
}

/** The line under a paired device on the Access tab: an app's access, then revoked, connected now, or when the host last saw it. */
export function pairedDeviceDetail(device: PairedDevice, isConnected: boolean, now = Date.now()): string {
  const access = device.app ? `${appAccessLabel(device.app.access)} access · ` : ''
  if (device.revokedAt !== null) return `${access}Revoked ${relativeTime(device.revokedAt, now)}`
  const seen = isConnected ? 'Connected now' : `Last seen ${relativeTime(device.lastSeenAt, now)}`
  return `${access}${seen} · paired ${relativeTime(device.pairedAt, now)}`
}
