import { userInfo } from 'os'
import { parseUserKey, userKey, type User, type UserId } from '@solus/contracts/user'
import type { HostUserSettings } from './settings'

/**
 * The host's own user (plans/012-user-actor-and-activity.md U4): the owner, a
 * `local` user minted once. Its key never changes (plans/031 D1): a link to the
 * owner's account adds the account's name and email, and the cloud boundary
 * names the account; no row is rewritten.
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
  return current ? { kind: 'local', localId: current.localId } : null
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

/**
 * The account a person key names at the cloud boundary (plans/031 D4): the host's
 * user is the account the host is linked to, null while it is not; any other key
 * names its own account, or none.
 */
export function cloudAccountOf(key: string): string | null {
  if (isHostUserKey(key)) return current?.account?.accountId ?? null
  const id = parseUserKey(key)
  return id.kind === 'account' ? id.accountId : null
}

/**
 * The key a person has on this host (plans/031 D4, inbound): the account the host
 * is linked to is the host's user; any other key is itself. A client that picked
 * the owner from an organization's directory names them by their account id, and
 * a row from the cloud does too: stored as it came, nothing on the host would
 * know it as the owner.
 */
export function hostKeyOf(key: string): string {
  return current?.account && key === current.account.accountId ? hostUserKey() : key
}

/**
 * The person key a reader is shown (plans/031 D4, outbound). The host's owner
 * knows themselves by their key here; anyone else knows the owner by the account
 * the host is linked to, as the organization's directory names them.
 */
export function keyForReader(key: string, isOwnerReading: boolean): string {
  return isOwnerReading || !isHostUserKey(key) ? key : cloudAccountOf(key) ?? key
}

/** A person key as it goes to the cloud: the host's user is the linked account. */
export function cloudKeyOf(key: string): string {
  return isHostUserKey(key) ? cloudAccountOf(key) ?? key : key
}

/** A person's id as the cloud knows them: the host's user is the linked account. */
export function cloudUserIdOf(id: UserId): UserId {
  const accountId = isHostUserKey(userKey(id)) ? current?.account?.accountId : undefined
  return accountId ? { kind: 'account', accountId } : id
}
