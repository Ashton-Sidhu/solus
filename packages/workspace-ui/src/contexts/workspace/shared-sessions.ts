import type { ResourceRole } from '@solus/contracts/sharing'
import type { SessionRecord } from '@solus/contracts/types'
import { shareRoleLabel } from '@solus/client-core/notifications/presentation'

/**
 * Another person's session in the reader's list (docs/plans/shared-with-you.md).
 * The host answers `owner` only to the session's owner, so any other role names
 * a session that the reader does not own.
 */
export interface SessionShare {
  /** The person key of the session's owner. */
  ownerKey: string
  role: ResourceRole
  /** Who shared it with the reader directly; null when only an organization
   *  entry or a link gives the reader access. */
  sharedBy: string | null
  /** When a direct share last gave the reader access or a higher role, in ms. */
  grantedAt: number | null
  lastActivityAt: number
}

/** The share a listed record stands for, or undefined for the reader's own
 *  session and for a host that sends no role. */
export function sessionShareOf(
  record: Pick<SessionRecord, 'ownerKey' | 'role' | 'sharedBy' | 'grantedAt' | 'lastActivityAt'>,
): SessionShare | undefined {
  if (!record.role || record.role === 'owner' || record.role === 'none') return undefined
  return {
    ownerKey: record.ownerKey,
    role: record.role,
    sharedBy: record.sharedBy ?? null,
    grantedAt: record.grantedAt ?? null,
    lastActivityAt: record.lastActivityAt,
  }
}

/** The role as a row reads it: "Can edit". */
export function shareRoleText(role: ResourceRole): string {
  return role === 'owner' || role === 'none' ? '' : shareRoleLabel(role)
}

/** Rows of Shared with you go newest grant first; a session that no direct
 *  share gave goes by its last activity. */
export function shareSortAt(share: SessionShare): number {
  return share.grantedAt ?? share.lastActivityAt
}

/** What one list read granted, and the mark for the next read. */
export interface NewGrants<T> {
  granted: T[]
  seenUntil: number
}

/** A toast or a notice: a title, and the detail under it. */
export interface ShareNotice {
  message: string
  description?: string
}

/**
 * The grants one list read shows for the first time. `seenUntil` is the latest
 * grant this client already told the reader about on that host; it starts at
 * the time the client started, so the first read after a start does not toast
 * every share the reader got while it was closed. The notifications hub keeps
 * those.
 */
export function newGrants<T extends { share?: SessionShare }>(
  listed: readonly T[],
  seenUntil: number,
): NewGrants<T> {
  let latest = seenUntil
  const granted = listed.filter((session) => {
    const grantedAt = session.share?.grantedAt
    if (grantedAt == null || grantedAt <= seenUntil) return false
    latest = Math.max(latest, grantedAt)
    return true
  })
  return { granted, seenUntil: latest }
}

/** A shared session the reader has not opened since its latest grant. */
export function isUnopenedShare(share: SessionShare | undefined, openedGrantAt: number | undefined): boolean {
  if (share?.grantedAt == null) return false
  return openedGrantAt === undefined || openedGrantAt < share.grantedAt
}

/** The toast a new direct share shows. */
export function shareToast(ownerName: string | null, title: string | null, role: ResourceRole): ShareNotice {
  const named = title ?? 'a session'
  return {
    message: ownerName ? `${ownerName} shared ${named} with you` : `${named} was shared with you`,
    description: shareRoleText(role),
  }
}

/**
 * Why a session that this client knew as shared does not open
 * (docs/plans/shared-with-you.md §4.5). The notice names the session, never
 * the host. A host that does not answer is a different state from a host that
 * refuses the reader.
 */
export function unopenableSessionNotice(input: {
  isHostConnected: boolean
  ownerName: string | null
  title: string | null
}): ShareNotice {
  if (!input.isHostConnected) {
    return { message: input.ownerName ? `${input.ownerName}'s computer is offline` : "The owner's computer is offline" }
  }
  const description = input.ownerName && input.title
    ? `${input.ownerName} owns ${input.title}. Ask them to share it with you.`
    : 'Ask its owner to share it with you.'
  return { message: "You don't have access to this session", description }
}
