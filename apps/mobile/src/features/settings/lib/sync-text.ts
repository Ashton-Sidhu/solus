import type { PersonalSettingKey, PersonalSettingsDocument } from '@solus/contracts/settings'
import type { DocumentSyncState } from '@solus/client-core/document-sync'

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

/** The account's status as the sync screen reads it: the worse state of the two documents, and their counts. */
export interface AccountSyncView {
  state: DocumentSyncState
  lastSyncedAt: number | null
  pendingCount: number
  conflictCount: number
  error: { code: string; message: string | null } | null
}

/** The line under the account's status: what is happening now, in plain words. */
export function accountSyncDetail(status: AccountSyncView, formatTime: (epochMs: number) => string): string {
  const last = status.lastSyncedAt === null ? null : `Last synced ${formatTime(status.lastSyncedAt)}.`
  switch (status.state) {
    case 'signed-out': return 'Sign in to Solus Cloud and your settings and agent profile sync between your devices and the hosts you work on. They work on this device without it.'
    case 'loading': return 'Reading your account…'
    case 'synced': return last ?? 'Synced.'
    case 'pending': return `${countText(status.pendingCount)} waiting to send. ${last ?? ''}`.trim()
    case 'offline': return `Offline. ${status.pendingCount ? `${countText(status.pendingCount)} will send when you are back online.` : ''} ${last ?? ''}`.replace(/\s+/g, ' ').trim()
    case 'conflict': return `This device and your account changed the same ${status.conflictCount === 1 ? 'thing' : `${status.conflictCount} things`}. Choose which to keep below.`
    case 'error': return `Not synced: ${status.error?.message ?? status.error?.code ?? 'unknown error'}. ${last ?? ''}`.trim()
  }
}

function countText(count: number): string {
  return count === 1 ? '1 change' : `${count} changes`
}
