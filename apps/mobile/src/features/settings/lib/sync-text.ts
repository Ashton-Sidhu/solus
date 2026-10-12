import type { PersonalSettingKey, PersonalSettingsDocument } from '@solus/contracts/settings'
import type { DocumentSyncStatus } from '@solus/client-core/document-sync'

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

/** What a sync line is about: the personal settings, or the agent profile (plans/020). */
export interface SyncSubject {
  /** After "your": "settings", "agent profile". */
  noun: string
  plural: boolean
  /** The conflict unit: "setting", "entry". */
  unit: string
}

export const SETTINGS_SUBJECT: SyncSubject = { noun: 'settings', plural: true, unit: 'setting' }
export const AGENT_PROFILE_SUBJECT: SyncSubject = { noun: 'agent profile', plural: false, unit: 'entry' }

/** The parts of a sync status the line reads, whatever document it syncs. */
type SyncStatusView = Pick<DocumentSyncStatus<object, string>, 'state' | 'lastSyncedAt' | 'error' | 'stoppedReason'> & { pendingKeys: readonly string[] }

/** The sentences that differ by subject, so the status line below reads one way. */
function subjectText({ noun, plural, unit }: SyncSubject) {
  const stays = `Your ${noun} ${plural ? 'stay' : 'stays'} on this device.`
  return {
    noun,
    unit,
    signedOut: `Sign in to Solus Cloud to sync your ${noun}. ${plural ? 'They work' : 'It works'} on this device without it.`,
    cleared: `${plural ? `Synced ${noun} were` : `The synced ${noun} was`} cleared on another device, so sync is off here. ${stays} Turn sync on to start again.`,
    off: `${stays} Turn sync on to share ${plural ? 'them' : 'it'} with your other devices.`,
  }
}

/** The line under the sync switch: what is happening now, in plain words. */
export function syncStatusDetail(status: SyncStatusView, formatTime: (epochMs: number) => string, subject: SyncSubject): string {
  const last = status.lastSyncedAt === null ? null : `Last synced ${formatTime(status.lastSyncedAt)}.`
  const { noun, unit, signedOut, cleared, off } = subjectText(subject)
  switch (status.state) {
    case 'signed-out': return signedOut
    case 'off': return status.stoppedReason === 'generation-changed' ? cleared : off
    case 'loading': return `Reading your synced ${noun}…`
    case 'synced': return last ?? 'Synced.'
    case 'pending': return `${countText(status.pendingKeys.length)} waiting to send. ${last ?? ''}`.trim()
    case 'offline': return `Offline. ${status.pendingKeys.length ? `${countText(status.pendingKeys.length)} will send when you are back online.` : ''} ${last ?? ''}`.replace(/\s+/g, ' ').trim()
    case 'conflict': return `This device and your synced ${noun} changed the same ${unit}. Choose which to keep below.`
    case 'error': return `Not synced: ${status.error?.message ?? status.error?.code ?? 'unknown error'}. ${last ?? ''}`.trim()
  }
}

function countText(count: number): string {
  return count === 1 ? '1 change' : `${count} changes`
}
