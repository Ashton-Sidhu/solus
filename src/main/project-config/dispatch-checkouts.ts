import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { SOLUS_REMOTE_DISPATCH_DIR, type DispatchHistoryRoot } from '../../shared/types'
import { resolveRepoRef } from '../git/git-helpers'
import { listProjectWorktrees } from '../git/worktree-manager'

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

/** A dispatch checkout belongs to one paired device and one repository. */
export function dispatchCheckoutPath(projectsRoot: string, deviceId: string, repoKey: string): string {
  if (!SAFE_PATH_SEGMENT.test(deviceId) || deviceId.includes('..')) {
    throw new Error('The paired device cannot be used as a dispatch checkout path.')
  }
  return join(projectsRoot, SOLUS_REMOTE_DISPATCH_DIR, deviceId, ...normalizeDispatchRepoKey(repoKey).split('/'))
}

/** Validate an exact existing worktree against the device-scoped dispatch
 * checkout. The base checkout is excluded: dispatched agents stay isolated. */
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

/** Resolve exact roots without enumerating any other paired device's namespace. */
export async function resolveDispatchHistoryRoots(
  projectsRoot: string,
  deviceId: string,
  repoKeys: string[],
): Promise<DispatchHistoryRoot[]> {
  const normalizedKeys = [...new Set(repoKeys.map(normalizeDispatchRepoKey))]
  const roots = await Promise.all(normalizedKeys.map(async (repoKey): Promise<DispatchHistoryRoot | null> => {
    const path = dispatchCheckoutPath(projectsRoot, deviceId, repoKey)
    if (!existsSync(path)) return null
    const repo = await resolveRepoRef(path)
    if (!repo) return null
    const actualRepoKey = normalizeDispatchRepoKey(`${repo.host}/${repo.owner}/${repo.repo}`)
    return actualRepoKey === repoKey ? { repoKey, path } : null
  }))
  return roots.filter((root): root is DispatchHistoryRoot => root !== null)
}
