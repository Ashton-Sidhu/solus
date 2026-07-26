import type { ProjectIdentity, RecentProject } from '../../../../shared/types'

export interface RecentProjectHost {
  id: string
  label: string
  identities: ProjectIdentity[]
}

export interface RecentProjectRow {
  path: string
  folderName: string
  lastOpened: string
  repoKey: string | null
  /** Hosts other than the one these recents came from that hold the same repo. */
  alsoOn: { id: string; label: string }[]
}

export interface RecentProjectRowsOptions {
  /** Recents as the host they were listed from reports them. */
  recents: RecentProject[]
  /** That host's checkouts, which is where a path learns its repo. */
  identities: ProjectIdentity[]
  /** Every other saved host, so a row can say where else the repo lives. */
  otherHosts: RecentProjectHost[]
  limit: number
}

/**
 * Two checkouts of one repository — a base checkout and a session worktree, say
 * — are one entry in a list this short; letting them take two of three slots
 * hides a project the user actually has. Folders with no origin have no repo to
 * be the same as, so they stay distinct by path.
 */
export function recentProjectRows(opts: RecentProjectRowsOptions): RecentProjectRow[] {
  const { recents, identities, otherHosts, limit } = opts
  const repoKeyByPath = new Map(identities.map((identity) => [identity.path, identity.repoKey.toLowerCase()]))
  const rows: RecentProjectRow[] = []
  const rowByRepoKey = new Map<string, RecentProjectRow>()

  for (const recent of recents) {
    if (rows.length >= limit) break
    const repoKey = repoKeyByPath.get(recent.path) ?? null
    // Recents arrive newest-first, so the first path wins the slot.
    if (repoKey && rowByRepoKey.has(repoKey)) continue
    const row: RecentProjectRow = {
      path: recent.path,
      folderName: recent.folderName,
      lastOpened: recent.lastOpened,
      repoKey,
      alsoOn: repoKey ? hostsWithRepo(otherHosts, repoKey) : [],
    }
    rows.push(row)
    if (repoKey) rowByRepoKey.set(repoKey, row)
  }
  return rows
}

/** Naming two hosts is orientation; naming five is a list nobody reads in a 200px row. */
export function alsoOnLabel(alsoOn: { label: string }[]): string {
  if (alsoOn.length === 0) return ''
  if (alsoOn.length > 2) return `Also on ${alsoOn.length} hosts`
  return `Also on ${alsoOn.map((host) => host.label).join(', ')}`
}

export function alsoOnTooltip(alsoOn: { label: string }[]): string {
  return `Also checked out on ${alsoOn.map((host) => host.label).join(', ')}`
}

function hostsWithRepo(hosts: RecentProjectHost[], repoKey: string): { id: string; label: string }[] {
  return hosts
    .filter((host) => host.identities.some((identity) => identity.repoKey.toLowerCase() === repoKey))
    .map((host) => ({ id: host.id, label: host.label }))
}
