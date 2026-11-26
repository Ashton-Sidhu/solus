import type { PermissionMode } from '@solus/contracts/types'
import { DEFAULT_EXECUTION_PREFERENCES, type ExecutionPreferences } from '@solus/contracts/settings'

/** Auto and accept-edits are different policies, not adjacent levels. A child
 * can keep the parent's policy or take a clearly stricter one. */
export function childPermissionMode(parent: PermissionMode, requested: PermissionMode = parent): PermissionMode {
  if (requested === parent || requested === 'plan' || parent === 'full-access') return requested
  if (requested === 'supervised' && parent !== 'plan') return requested
  throw new Error(`A child cannot change permissions from ${parent} to ${requested}. Only the user can grant more access.`)
}

/** The mode of a new session that no session starts (an outside app's, or another
 *  host's): the mode asked for, else the person's default lowered to the policy's
 *  ceiling. A mode asked for above the ceiling is refused where the provider starts. */
export function rootPermissionMode(
  policy: { clampMode(mode: PermissionMode): PermissionMode },
  requested: PermissionMode | undefined,
  preferences: Pick<ExecutionPreferences, 'defaultPermissionMode'> | undefined,
): PermissionMode {
  return requested ?? policy.clampMode(preferences?.defaultPermissionMode ?? DEFAULT_EXECUTION_PREFERENCES.defaultPermissionMode)
}
