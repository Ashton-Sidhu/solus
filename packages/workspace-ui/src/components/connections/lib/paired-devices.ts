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
export function hasAppConnected(device: PairedDevice): boolean {
  return device.lastSeenAt > device.pairedAt
}

/** The confirmation of "Disconnect all apps". */
export function revokeAllAppsQuestion(count: number, hostName: string): string {
  return `Disconnect ${count === 1 ? 'the connected app' : `all ${count} connected apps`}? ${count === 1 ? 'It loses' : 'They lose'} access to ${hostName} at once, and must sign in again.`
}

/** The devices on Sharing & access: paired devices that are not outside apps and still have access. Apps are in the directory. */
export function devicesWithAccess(devices: readonly PairedDevice[]): PairedDevice[] {
  return devices.filter((device) => !device.app && device.revokedAt === null)
}

/** A device whose label names a phone or a tablet shows a phone icon; any other shows a computer. */
export function isPhoneLabel(label: string): boolean {
  return /\b(iphone|ipad|android|phone|pixel|galaxy|tablet)\b/i.test(label)
}
