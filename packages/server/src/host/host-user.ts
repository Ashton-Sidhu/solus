import { userInfo } from 'os'
import { userKey, type User, type UserId } from '@solus/contracts/user'
import type { HostUserSettings } from './settings'

/**
 * The host's own user (plans/012-user-actor-and-activity.md U4): the owner of a
 * host with no account is a `local` user minted once; a linked host's owner is
 * their account. `host-user-rows.ts` moves the rows when that changes.
 *
 * The Solus API has no host user: it never calls `useHostUser`.
 */

/**
 * The key rows written before plan 012 stage 1 held for the host's owner, and a
 * guest link shared then still names as its sharer. It is also the host's key
 * where there is no host user (the Solus API, tests).
 */
const LEGACY_HOST_OWNER_KEY = 'host-owner'

let current: HostUserSettings | null = null

/** What host settings hold for the host's user; null where there is none. */
export function currentHostUser(): HostUserSettings | null {
  return current
}

/** Set at boot from host settings; null forgets it (tests). */
export function useHostUser(settings: HostUserSettings | null): void {
  current = settings
}

export function hostUserId(): UserId | null {
  if (!current) return null
  return current.account ? { kind: 'account', accountId: current.account.accountId } : { kind: 'local', localId: current.localId }
}

export function hostUser(): User | null {
  const id = hostUserId()
  if (!id || !current) return null
  if (!current.account) return { id, displayName: localDisplayName() }
  const user: User = { id, displayName: current.account.displayName ?? current.account.email ?? localDisplayName() }
  if (current.account.email) user.email = current.account.email
  return user
}

/** The key the host's user is stored under. The legacy key where there is no host user. */
export function hostUserKey(): string {
  const id = hostUserId()
  return id ? userKey(id) : LEGACY_HOST_OWNER_KEY
}

/** Whether a stored key names the host's user: its current key, or the legacy sentinel a row may still hold. */
export function isHostUserKey(key: string): boolean {
  return key === LEGACY_HOST_OWNER_KEY || key === hostUserKey()
}

function localDisplayName(): string {
  try {
    return userInfo().username || 'Host owner'
  } catch {
    return 'Host owner'
  }
}

