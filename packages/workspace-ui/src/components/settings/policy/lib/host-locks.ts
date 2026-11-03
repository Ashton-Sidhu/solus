import { hostKeyLock } from '@solus/client-core/policy'
import { policySourceLabel, type ManagedHostKey, type PolicySet } from '@solus/contracts/policy'
import type { ManagedSettingNote } from './managed-setting-note'

/** How each machine-wide key reads in "<Label> is managed by <source>." */
const HOST_KEY_LABELS = {
  remoteAccess: 'Remote access',
  trustLocalNetwork: 'Local network trust',
  cloudTunnel: 'The Solus Cloud link',
  analyticsEnabled: 'Analytics',
  otel: 'OpenTelemetry export',
  archivedAutomationRetentionDays: 'Archived automation retention',
  unfiledRecordingRetentionDays: 'Unfiled recording retention',
  solusTools: 'Solus tools',
  continueSessionsAfterHostRestart: 'Continuing sessions after a restart',
  updates: 'Solus updates',
} satisfies Record<ManagedHostKey, string>

/**
 * A host key the MDM policy or the host-owning organization locks, as the note
 * under its row (plans/030 §6.6). A host lock holds for all work on the host,
 * so the control is always inert. Undefined when the person decides.
 */
export function hostLockNote(set: PolicySet, key: ManagedHostKey): ManagedSettingNote | undefined {
  const lock = hostKeyLock(set, key, HOST_KEY_LABELS[key])
  return lock ? { lockedEverywhere: true, lines: [lock.message] } : undefined
}

/** Pairing follows `remoteAccess: false`: no pair codes, no pair links. */
export function pairingLockNote(set: PolicySet): ManagedSettingNote | undefined {
  const lock = hostKeyLock(set, 'remoteAccess', 'Pairing')
  return lock && lock.value === false ? { lockedEverywhere: true, lines: [lock.message] } : undefined
}

/** The Solus tools a policy sets on this host: only the tools it names are locked. */
export function solusToolsLock(set: PolicySet): { message: string; lockedTools: ReadonlySet<string> } | undefined {
  const lock = hostKeyLock(set, 'solusTools', HOST_KEY_LABELS.solusTools)
  if (!lock) return undefined
  const lockedTools = new Set(Object.keys(lock.value))
  const count = lockedTools.size === 1 ? '1 Solus tool is' : `${lockedTools.size} Solus tools are`
  return { message: `${count} managed by ${policySourceLabel(lock.source)}.`, lockedTools }
}
