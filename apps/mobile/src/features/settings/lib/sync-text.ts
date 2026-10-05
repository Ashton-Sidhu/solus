import type { PersonalSettingKey, PersonalSettingsDocument } from '@solus/contracts/settings'
import type { SettingsSyncStatus } from '@solus/client-core/settings-sync'

/** Words for a sync conflict row: which setting, and each side's value. */

/** `defaultPermissionMode` → "Default permission mode". */
export function settingKeyLabel(key: PersonalSettingKey): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** One side of a conflict, short. An absent key is the default. */
export function settingValueText(document: PersonalSettingsDocument, key: PersonalSettingKey): string {
  if (!Object.hasOwn(document, key)) return 'Default'
  const text = JSON.stringify(document[key])
  if (text === 'true') return 'On'
  if (text === 'false') return 'Off'
  if (text === 'null') return 'None'
  if (text === '""') return 'Empty'
  const plain = text.replace(/^"|"$/g, '')
  return plain.length > 60 ? `${plain.slice(0, 57)}…` : plain
}

/** The line under the sync switch: what is happening now, in plain words. */
export function syncStatusDetail(status: SettingsSyncStatus, formatTime: (epochMs: number) => string): string {
  const last = status.lastSyncedAt === null ? null : `Last synced ${formatTime(status.lastSyncedAt)}.`
  switch (status.state) {
    case 'signed-out': return 'Sign in to Solus Cloud to sync your settings. They work on this device without it.'
    case 'off': return status.stoppedReason === 'generation-changed'
      ? 'Synced settings were cleared on another device, so sync is off here. Your settings stay on this device. Turn sync on to start again.'
      : 'Your settings stay on this device. Turn sync on to share them with your other devices.'
    case 'loading': return 'Reading your synced settings…'
    case 'synced': return last ?? 'Synced.'
    case 'pending': return `${countText(status.pendingKeys.length)} waiting to send. ${last ?? ''}`.trim()
    case 'offline': return `Offline. ${status.pendingKeys.length ? `${countText(status.pendingKeys.length)} will send when you are back online.` : ''} ${last ?? ''}`.replace(/\s+/g, ' ').trim()
    case 'conflict': return 'This device and your synced settings changed the same setting. Choose which to keep below.'
    case 'error': return `Not synced: ${status.error?.message ?? status.error?.code ?? 'unknown error'}. ${last ?? ''}`.trim()
  }
}

function countText(count: number): string {
  return count === 1 ? '1 change' : `${count} changes`
}
