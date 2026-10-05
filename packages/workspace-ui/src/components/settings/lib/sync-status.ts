import type { SettingConflict, SettingsSyncStatus } from '@solus/client-core/settings-sync'
import type { PersonalSettingKey, PersonalSettingsDocument } from '@solus/contracts/settings'
import { z } from 'zod'

/** The words for the person's sync state (plans/018 §5). An optimistic edit never reads as synced. */
export function syncStateLabel(status: SettingsSyncStatus): string {
  switch (status.state) {
    case 'signed-out': return 'Signed out'
    case 'off': return 'Off on this device'
    case 'loading': return 'Checking your account…'
    case 'synced': return 'Synced'
    case 'pending': return status.pendingKeys.length === 1 ? '1 change waiting to sync' : `${status.pendingKeys.length} changes waiting to sync`
    case 'offline': return 'Offline. Changes sync when you reconnect.'
    case 'conflict': return status.conflicts.length === 1 ? '1 setting changed on two devices' : `${status.conflicts.length} settings changed on two devices`
    case 'error': return status.error?.message ?? 'Sync stopped. Solus tries again later.'
  }
}

/** Sync is on for this device and account: a state the engine only reaches while enabled. */
export function isSyncOn(status: SettingsSyncStatus): boolean {
  return status.state === 'synced' || status.state === 'pending' || status.state === 'offline' || status.state === 'conflict' || status.state === 'error'
}

/** Readable names for the keys a conflict or a warning lists. */
const KEY_LABELS = new Map<PersonalSettingKey, string>([
  ['themeMode', 'Theme'],
  ['activeAgent', 'Default agent'],
  ['defaultPermissionMode', 'Default permission mode'],
  ['notifications', 'Notifications'],
  ['modelRouting', 'Model routing'],
  ['defaultModels', 'Default models'],
  ['modelOptionsByProvider', 'Model options'],
  ['extraInstructions', 'Custom instructions'],
  ['modelInstructions', 'Model instructions'],
  ['savedLenses', 'Saved review lenses'],
  ['fontFamily', 'Interface font'],
  ['fontSize', 'Interface font size'],
  ['codeFontFamily', 'Code font'],
  ['codeFontSize', 'Code font size'],
  ['leadInstructions', 'Lead instructions'],
  ['agentTaskLifecyclePolicy', 'Task lifecycle control'],
  ['textGenerationModel', 'Text-generation model'],
  ['sourceControlWriting', 'Source control writing style'],
  ['worktreeBranchNaming', 'Branch names'],
])

export function settingKeyLabel(key: PersonalSettingKey): string {
  return KEY_LABELS.get(key) ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (first) => first.toUpperCase())
}

/** How a scalar reads; a structured value reads as changed. */
const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

/** One side of a conflict, short: the value, or "Default" when that side reset it. */
export function conflictSideText(side: PersonalSettingsDocument, key: PersonalSettingKey): string {
  if (!Object.hasOwn(side, key)) return 'Default'
  const scalar = scalarSchema.safeParse(side[key])
  if (!scalar.success) return 'Changed'
  const value = scalar.data
  if (value === null) return 'Off'
  const text = String(value)
  if (text === '') return 'Empty'
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

export function conflictRows(conflicts: readonly SettingConflict[]): Array<{ key: PersonalSettingKey; label: string; mine: string; theirs: string }> {
  return conflicts.map((conflict) => ({
    key: conflict.key,
    label: settingKeyLabel(conflict.key),
    mine: conflictSideText(conflict.mine, conflict.key),
    theirs: conflictSideText(conflict.theirs, conflict.key),
  }))
}
