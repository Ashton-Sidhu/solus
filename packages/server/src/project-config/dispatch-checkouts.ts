import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { DispatchHistoryRoot } from '@solus/contracts/types'
import { repositoryKeyFromRemoteUrl } from '@solus/contracts/repository-key'
import { git, runAsync } from '../git/exec'
import { listProjectWorktrees } from '../git/worktree-manager'
import { hostCategory } from '../host/host-category'
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
 * Whose delegated credential a dispatch acts with: the key it is stored under,
 * and the one a clone's git config names. On a Solus-provisioned machine it is
 * the member, whatever device asks (plan 004 item 8). Elsewhere it is the
 * paired device. Which folder the clone is in is the projects folder's choice.
 */
export function dispatchCheckoutOwnerKey(principal: Principal, deviceId: string): string {
  return hostCategory() === 'managed' && principal.kind === 'org-member' ? principal.userId : deviceId
}

/** The repository the `origin` of a checkout names, or null for a folder that is not one. */
function originRepoKeyOf(path: string): string | null {
  try {
    const url = git(['-C', path, 'config', '--get', 'remote.origin.url'], path)
    return url ? repositoryKeyFromRemoteUrl(url)?.toLowerCase() ?? null : null
  } catch {
    return null
  }
}

/** Names tried after `<repo>`: `<repo>-2` up to this. */
const MAX_NAME_SUFFIX = 50

/** The folder names a checkout of `repoKey` may have, in lower case and in the order they are tried. */
function candidateNames(repoKey: string): string[] {
  const name = repoKey.split('/').at(-1)!
  return [name, ...Array.from({ length: MAX_NAME_SUFFIX - 1 }, (_, index) => `${name}-${index + 2}`)]
}

/** The projects folder's entries by their lower-case name. A repository name
 *  ignores case, and a person's own `Hello-World` is the `hello-world` a
 *  client names, also on a file system that keeps case. */
function entriesByLowerName(projectsRoot: string): Map<string, string> {
  try {
    return new Map(readdirSync(projectsRoot).map((name) => [name.toLowerCase(), name]))
  } catch {
    return new Map()
  }
}

/**
 * The checkout of `repoKey` the caller already has in their projects folder: a
 * folder named for the repository whose `origin` is that repository. Null when
 * there is none.
 */
export function existingDispatchCheckout(projectsRoot: string, repoKey: string): string | null {
  const key = normalizeDispatchRepoKey(repoKey)
  const entries = entriesByLowerName(projectsRoot)
  for (const name of candidateNames(key)) {
    const entry = entries.get(name)
    if (!entry) return null
    const path = join(projectsRoot, entry)
    if (originRepoKeyOf(path) === key) return path
  }
  return null
}

/**
 * The folder a dispatch of `repoKey` works in: the checkout the caller has
 * (`existingDispatchCheckout`), else the first free name in their projects
 * folder — `<repo>`, then `<repo>-2` and on — the way `git clone` names one.
 * A folder that holds anything else is never used.
 */
export function dispatchCheckoutPath(projectsRoot: string, repoKey: string): string {
  const existing = existingDispatchCheckout(projectsRoot, repoKey)
  if (existing) return existing
  const entries = entriesByLowerName(projectsRoot)
  const freeName = candidateNames(normalizeDispatchRepoKey(repoKey)).find((name) => !entries.has(name))
  const free = freeName ? join(projectsRoot, freeName) : null
  if (!free) throw new Error(`Every folder name for ${repoKey} in ${projectsRoot} is taken.`)
  return free
}

/** Local git config of a clone Solus made for a dispatch. */
export const DISPATCH_CLONE_CONFIG_KEY = 'solus.dispatchClone'
/** Local git config naming whose delegated credential the clone acts with. */
export const DELEGATION_OWNER_CONFIG_KEY = 'solus.delegationOwner'

function localConfig(cwd: string, key: string): string | null {
  try {
    return git(['-C', cwd, 'config', '--get', key], cwd) || null
  } catch {
    return null
  }
}

/** Solus made this clone, so it may write the delegated helper and identity into it. */
export function isDispatchClone(cwd: string): boolean {
  return localConfig(cwd, DISPATCH_CLONE_CONFIG_KEY) === 'true'
}

/**
 * Whose delegated credential a checkout acts with, or null for an ordinary
 * project. The clone's git config names it, and linked worktrees share that
 * config, so they resolve to the same owner.
 */
export async function dispatchCheckoutOwnerKeyOf(cwd: string): Promise<string | null> {
  if (!existsSync(cwd)) return null
  // Asked on every GitHub call from a checkout, so it must not block the host.
  const ownerKey = await runAsync('git', ['-C', cwd, 'config', '--get', DELEGATION_OWNER_CONFIG_KEY], cwd).catch(() => '')
  return ownerKey && SAFE_PATH_SEGMENT.test(ownerKey) ? ownerKey : null
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

/** The checkouts a dispatch of each repository would use, without listing any
 *  other folder of the caller's. A root matches when its `origin` is the
 *  requested repository, so GitLab subgroups match too. */
export function resolveDispatchHistoryRoots(projectsRoot: string, repoKeys: string[]): DispatchHistoryRoot[] {
  return [...new Set(repoKeys.map(normalizeDispatchRepoKey))].flatMap((repoKey) => {
    const path = existingDispatchCheckout(projectsRoot, repoKey)
    return path ? [{ repoKey, path }] : []
  })
}
