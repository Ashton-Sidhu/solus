import type { LaunchLock } from '@solus/client-core/policy'
import type { ManagedSettingNote } from './managed-setting-note'

/** The provider instance editor's rows that a launch lock can own (plans/030 §6.4). */
export interface LaunchLockNotes {
  binaryPath?: ManagedSettingNote
  homePaths?: ManagedSettingNote
  launchArgs?: ManagedSettingNote
  /** The whole Variables row; under a ceiling only. */
  environment?: ManagedSettingNote
  /** Names of pinned variables, whose rows are read-only; the person's others stay editable. */
  pinnedVariables: readonly string[]
}

/** The first locked row carries the message; the others are locked without repeating it. */
export function launchLockNotes(lock: LaunchLock | null): LaunchLockNotes {
  if (!lock) return { pinnedVariables: [] }
  let said = false
  const note = (locked: boolean): ManagedSettingNote | undefined => {
    if (!locked) return undefined
    const lines = said ? [] : [lock.message]
    said = true
    return { lockedEverywhere: true, lines }
  }
  const pinnedVariables = lock.all ? [] : lock.environment
  return {
    binaryPath: note(lock.all || lock.binaryPath),
    homePaths: note(lock.all),
    launchArgs: note(lock.all || lock.launchArgs),
    environment: lock.all
      ? note(true)
      : pinnedVariables.length > 0 ? { lockedEverywhere: false, lines: [`${said ? '' : `${lock.message} `}Pinned variables: ${pinnedVariables.join(', ')}.`] } : undefined,
    pinnedVariables,
  }
}
