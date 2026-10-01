import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { SOLUS_REMOTE_DISPATCH_DIR, type DispatchHistoryRoot } from '@solus/contracts/types'
import { resolveRepositoryKey } from '../git/git-helpers'
import { listProjectWorktrees } from '../git/worktree-manager'
import { hostCategory } from '../host/host-category'
import { memberUserIdOf, recordedMemberFolder } from '../host/member-folders'
import type { Principal } from '../admission/principal'

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Canonical repository identity used to match the same checkout across hosts. */
export function normalizeDispatchRepoKey(repoKey: string): string {
  const parts = repoKey
    .trim()
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 3) throw new Error('The repository key must name a host, owner, and repository.')
  for (const part of parts) {
    if (!SAFE_PATH_SEGMENT.test(part) || part.includes('..')) {
      throw new Error('The repository key cannot be used as a dispatch checkout path.')
    }
  }
  return parts.join('/').toLowerCase()
}

/**
 * Who owns a caller's dispatch checkouts: the key of the checkout path and of
 * its delegated credential. On a Solus-provisioned machine it is the member, so
 * each member has one clone per repository, whatever device asks (plan 004
 * item 8). Elsewhere it is the paired device, as before.
 */
export function dispatchCheckoutOwnerKey(principal: Principal, deviceId: string): string {
  return hostCategory() === 'managed' && principal.kind === 'org-member' ? principal.userId : deviceId
}

/** A dispatch checkout belongs to one owner (`dispatchCheckoutOwnerKey`) and one repository. A member's folder is their name. */
export function dispatchCheckoutPath(projectsRoot: string, ownerKey: string, repoKey: string): string {
  if (!SAFE_PATH_SEGMENT.test(ownerKey) || ownerKey.includes('..')) {
    throw new Error('The checkout owner cannot be used as a dispatch checkout path.')
  }
  return join(projectsRoot, SOLUS_REMOTE_DISPATCH_DIR, recordedMemberFolder(ownerKey), ...normalizeDispatchRepoKey(repoKey).split('/'))
}

/**
 * The inverse: the owner key a path belongs to, or null for an ordinary
 * project. Lives beside `dispatchCheckoutPath` so the two change together —
 * this is the layout read back, not a guess about it. Linked worktrees under
 * the checkout keep the segment, so they resolve to the same owner.
 */
export function dispatchCheckoutOwnerKeyOf(cwd: string): string | null {
  const marker = `/${SOLUS_REMOTE_DISPATCH_DIR}/`
  const markerIndex = cwd.indexOf(marker)
  if (markerIndex === -1) return null
  const ownerKey = cwd.slice(markerIndex + marker.length).split('/')[0]
  return ownerKey && SAFE_PATH_SEGMENT.test(ownerKey) ? memberUserIdOf(ownerKey) : null
}

/** Validate an exact existing worktree against the owner's dispatch
 * checkout. The base checkout is not a linked worktree: a session works there
 * by naming no worktree at all. */
export function resolveDispatchWorktree(
  checkoutPath: string,
  worktreePath?: string,
): string {
  if (!worktreePath) return checkoutPath
  let selectedPath: string
  try {
    selectedPath = realpathSync(worktreePath)
  } catch {
    throw new Error('The selected worktree is not part of this dispatch checkout.')
  }
  const basePath = realpathSync(checkoutPath)
  const worktree = listProjectWorktrees(checkoutPath).find((entry) => {
    try {
      const entryPath = realpathSync(entry.path)
      return entryPath !== basePath && entryPath === selectedPath
    } catch {
      return false
    }
  })
  if (!worktree) throw new Error('The selected worktree is not part of this dispatch checkout.')
  return worktree.path
}

/** Resolve exact roots without enumerating any other owner's namespace.
 *  A root matches when the repository key of its checkout (§1 rule) is the
 *  requested key. A dispatch clone has only its clone source as a remote, so
 *  the full path is compared, and GitLab subgroups match. */
export async function resolveDispatchHistoryRoots(
  projectsRoot: string,
  ownerKey: string,
  repoKeys: string[],
): Promise<DispatchHistoryRoot[]> {
  const normalizedKeys = [...new Set(repoKeys.map(normalizeDispatchRepoKey))]
  const roots = await Promise.all(normalizedKeys.map(async (repoKey): Promise<DispatchHistoryRoot | null> => {
    const path = dispatchCheckoutPath(projectsRoot, ownerKey, repoKey)
    if (!existsSync(path)) return null
    return await resolveRepositoryKey(path) === repoKey ? { repoKey, path } : null
  }))
  return roots.filter((root): root is DispatchHistoryRoot => root !== null)
}
