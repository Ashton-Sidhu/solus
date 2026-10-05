import type { PermissionMode } from '@solus/contracts/types'

/** Auto and accept-edits are different policies, not adjacent levels. A child
 * can keep the parent's policy or take a clearly stricter one. */
export function childPermissionMode(parent: PermissionMode, requested: PermissionMode = parent): PermissionMode {
  if (requested === parent || requested === 'plan' || parent === 'full-access') return requested
  if (requested === 'supervised' && parent !== 'plan') return requested
  throw new Error(`A child cannot change permissions from ${parent} to ${requested}. Only the user can grant more access.`)
}
