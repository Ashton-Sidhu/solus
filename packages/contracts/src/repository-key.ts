/**
 * Project identity (docs/plans/project-model.md §1). A project is a Git
 * repository, named by its repository key: the lowercase `host/path` of its
 * primary remote, such as `github.com/acme/web`. A folder with no remote is a
 * local-only project, named by its host and path. The server and every client
 * compute keys here, so two machines agree on what one repository is called.
 */

/** A remote's URL reduced to `host/path`, lowercase, without `.git`. SSH,
 *  HTTPS, and SCP (`git@host:owner/repo`) forms of one repository give one
 *  key. The whole path is kept, so GitLab subgroups stay distinct. Null for a
 *  URL with no host or no owner segment, such as a local path remote. */
export function repositoryKeyFromRemoteUrl(remoteUrl: string): string | null {
  const normalized = remoteUrl.trim().replace(/\/+$/g, '').replace(/\.git$/i, '').toLowerCase()
  if (!normalized) return null

  if (/^(?:ssh|https?|git):\/\//.test(normalized)) {
    try {
      const url = new URL(normalized)
      const path = url.pathname.split('/').filter((segment) => segment.length > 0).join('/')
      return url.hostname && path.includes('/') ? `${url.hostname}/${path}` : null
    } catch {
      return null
    }
  }

  const scp = /^[a-z0-9._-]+@([^:/\s]+):\/?([^/\s]+(?:\/[^/\s]+)+)$/.exec(normalized)
  return scp ? `${scp[1]}/${scp[2]}` : null
}

/** The remote that names the repository: `upstream` for a fork, then
 *  `origin`, then the first remote by name. The push remote is a property of
 *  the checkout and plays no part here. */
export function primaryRemoteUrl(remotes: ReadonlyMap<string, string>): string | null {
  for (const name of ['upstream', 'origin']) {
    const url = remotes.get(name)
    if (url) return url
  }
  const [first] = [...remotes.keys()].sort((a, b) => a.localeCompare(b))
  return first ? remotes.get(first) ?? null : null
}

/** The fetch URL of every remote in `git remote -v` output. */
export function parseRemoteFetchUrls(gitRemoteVerbose: string): Map<string, string> {
  const remotes = new Map<string, string>()
  for (const line of gitRemoteVerbose.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    if (match) remotes.set(match[1], match[2])
  }
  return remotes
}

/** The key of a folder with no remote: it is its host's alone. */
export function localProjectKey(serverId: string, path: string): string {
  return `${serverId}:${path}`
}

/** Whether a project key names a repository rather than a path or a
 *  local-only folder. A repository key has no leading slash and no colon. */
export function isRepositoryKey(projectKey: string): boolean {
  return !projectKey.startsWith('/') && !projectKey.startsWith('~') && !projectKey.includes(':')
}
