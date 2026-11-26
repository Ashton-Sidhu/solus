import type { AppAccess, PairedDevice } from '@solus/contracts/host-api'
import { OUTSIDE_APP_NAMES } from '@solus/contracts/outside-apps'
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

/** The line under a paired device on Sharing & access: an app's access, then revoked, connected now, or when the host last saw it. */
export function pairedDeviceDetail(device: PairedDevice, isConnected: boolean, now = Date.now()): string {
  const access = device.app ? `${appAccessLabel(device.app.access)} access · ` : ''
  if (device.revokedAt !== null) return `${access}Revoked ${relativeTime(device.revokedAt, now)}`
  const seen = device.app
    ? hasAppConnected(device) ? `Last connected ${relativeTime(device.lastSeenAt, now)}` : 'Not connected yet'
    : isConnected ? 'Connected now' : `Last seen ${relativeTime(device.lastSeenAt, now)}`
  return `${access}${seen} · paired ${relativeTime(device.pairedAt, now)}`
}

/**
 * An app called the host after its sign-in. The host writes `lastSeenAt` when
 * it admits a token, at most once a minute, and the sign-in writes it as
 * `pairedAt`; so an app reads as not connected for its first minute.
 */
function hasAppConnected(device: PairedDevice): boolean {
  return device.lastSeenAt > device.pairedAt
}

/** How long after its last call an app shows as active. An app calls over HTTP and keeps no connection, so this is the nearest to "connected now". */
export const APP_ACTIVE_MS = 5 * 60_000

/** An app's status dot: green while it was used in the last five minutes. */
export function isAppActive(device: PairedDevice, now = Date.now()): boolean {
  return device.revokedAt === null && hasAppConnected(device) && now - device.lastSeenAt < APP_ACTIVE_MS
}

/** The apps "Revoke all apps" ends: every outside app that is not revoked. Devices stay. */
export function revocableAppIds(devices: readonly PairedDevice[]): string[] {
  return devices.filter((device) => device.app && device.revokedAt === null).map((device) => device.deviceId)
}

/** The confirmation of "Revoke all apps". */
export function revokeAllAppsQuestion(count: number, hostName: string): string {
  return `Revoke ${count === 1 ? 'the connected app' : `all ${count} connected apps`}? ${count === 1 ? 'It loses' : 'They lose'} access to ${hostName} at once, and must sign in again.`
}

/** The app a paired row is, by name, beside its label: Claude, ChatGPT, Cursor. Null for a device, and for an app on the person's computer or one Solus cannot name, whose label already says what it is. */
export function pairedDeviceAppName(device: PairedDevice): string | null {
  const appId = device.app?.appId
  return appId && appId !== 'local' && appId !== 'other' ? OUTSIDE_APP_NAMES[appId] : null
}
