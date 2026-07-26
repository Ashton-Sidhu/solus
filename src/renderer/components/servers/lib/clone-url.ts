import type { CloneProtocol } from '../../../../shared/types'

/**
 * What the one omnibox in the New project dialog does with what you typed. It
 * mirrors the forms `validateCloneUrl` accepts on the server so the dialog can
 * react as you type; the server stays authoritative about what it will clone.
 */
export type CloneIntent =
  /** Nothing typed — show the host's repos and recent folders. */
  | { kind: 'empty' }
  /** A folder on the host: open it rather than cloning anything. */
  | { kind: 'path'; path: string }
  /** `owner/repo`, resolved against the code host. */
  | { kind: 'owner-repo'; owner: string; repo: string; cloneUrl: string; repoName: string }
  /** A complete clone URL, pasted. */
  | { kind: 'clone-url'; cloneUrl: string; repoName: string; protocol: CloneProtocol }
  /** Free text — filter the host's repository list. */
  | { kind: 'search'; query: string }

const OWNER_REPO_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
const SCP_LIKE_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+?)(?:\.git)?$/

/** Repo URLs are copied out of a browser as often as out of a clone box. */
function withGitSuffix(repoPath: string): string {
  return repoPath.endsWith('.git') ? repoPath : `${repoPath}.git`
}

export function repoNameFromPath(repoPath: string): string {
  const last = repoPath.replace(/\.git$/i, '').split('/').filter(Boolean).pop()
  return last || 'project'
}

function looksLikePath(value: string): boolean {
  return value === '~' || value.startsWith('/') || value.startsWith('~/') || value.startsWith('./') || value.startsWith('../')
}

export function classifyCloneInput(raw: string): CloneIntent {
  const value = raw.trim()
  if (!value) return { kind: 'empty' }
  if (looksLikePath(value)) return { kind: 'path', path: value }

  const scp = SCP_LIKE_RE.exec(value)
  if (scp && scp[3].includes('/')) {
    const cloneUrl = `${scp[1]}@${scp[2]}:${withGitSuffix(scp[3])}`
    return { kind: 'clone-url', cloneUrl, repoName: repoNameFromPath(scp[3]), protocol: 'ssh' }
  }

  if (/^(https|ssh):\/\//.test(value)) {
    try {
      const url = new URL(value)
      const repoPath = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
      if (repoPath.includes('/')) {
        const protocol: CloneProtocol = url.protocol === 'ssh:' ? 'ssh' : 'https'
        const cloneUrl = `${url.protocol}//${url.host}/${withGitSuffix(repoPath)}`
        return { kind: 'clone-url', cloneUrl, repoName: repoNameFromPath(repoPath), protocol }
      }
    } catch {
      // Falls through to a plain search — an unparseable URL is still a filter.
    }
  }

  const ownerRepo = OWNER_REPO_RE.exec(value)
  if (ownerRepo) {
    const [, owner, repo] = ownerRepo
    return {
      kind: 'owner-repo',
      owner,
      repo: repo.replace(/\.git$/i, ''),
      cloneUrl: `https://github.com/${owner}/${withGitSuffix(repo)}`,
      repoName: repoNameFromPath(repo),
    }
  }

  return { kind: 'search', query: value }
}

/**
 * Retargets a clone URL at the chosen protocol, so the toggle in the dialog
 * changes what would actually run rather than just a label.
 */
export function cloneUrlForProtocol(cloneUrl: string, protocol: CloneProtocol): string {
  const scp = SCP_LIKE_RE.exec(cloneUrl)
  if (scp) {
    const repoPath = withGitSuffix(scp[3])
    return protocol === 'ssh' ? `${scp[1]}@${scp[2]}:${repoPath}` : `https://${scp[2]}/${repoPath}`
  }
  try {
    const url = new URL(cloneUrl)
    const repoPath = withGitSuffix(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
    return protocol === 'ssh' ? `git@${url.host}:${repoPath}` : `https://${url.host}/${repoPath}`
  } catch {
    return cloneUrl
  }
}

/** The clone URL an intent commits to, or null when there is nothing to clone. */
export function cloneUrlForIntent(intent: CloneIntent, protocol: CloneProtocol): string | null {
  if (intent.kind === 'owner-repo' || intent.kind === 'clone-url') {
    return cloneUrlForProtocol(intent.cloneUrl, protocol)
  }
  return null
}

/** Subsequence match, so "solsh" still finds "solus-sh/solus". */
export function matchesRepoQuery(fullName: string, query: string): boolean {
  const haystack = fullName.toLowerCase()
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  let cursor = 0
  for (const char of needle) {
    cursor = haystack.indexOf(char, cursor)
    if (cursor === -1) return false
    cursor++
  }
  return true
}
