import type { HostApi } from "@solus/client-core/host-api"
import { hostPathBaseName, joinHostPath } from '@solus/contracts/host-path'
import { safeProjectDirName } from '@solus/contracts/project-folder-name'
import type { DirectoryEntry, GithubPublishRepositoryResult, SetupGithubRepo } from '@solus/contracts/types'

/** The last segment of a host path: `~/projects` reads as `projects`, `~` as your home folder. */
export function folderNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '~' || trimmed === '') return 'your home folder'
  return hostPathBaseName(trimmed) || trimmed
}

/** The quiet line under "Project name": where the host puts the new folder. */
export function newProjectLocationText(name: string, projectsFolder: string, hostLabel: string): string {
  return name.trim()
    ? `Creates ${joinHostPath(projectsFolder, safeProjectDirName(name))} on ${hostLabel}`
    : `Goes in ${projectsFolder} on ${hostLabel}`
}

const OWNER_REPO = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/

/**
 * What "Clone from a URL" sends to the host, or null when nothing is typed.
 * `owner/repo` means GitHub; anything else goes as typed and the host decides
 * whether it can clone it.
 */
export function cloneUrlFromInput(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const ownerRepo = OWNER_REPO.exec(value)
  if (ownerRepo && ownerRepo[1] !== '.' && ownerRepo[1] !== '..') {
    const repo = ownerRepo[2]!.endsWith('.git') ? ownerRepo[2] : `${ownerRepo[2]}.git`
    return `https://github.com/${ownerRepo[1]}/${repo}`
  }
  return value
}

/** Keep the repository folder name while browsing clone destinations on any host. */
export function cloneDestinationPath(parent: string, remoteUrl: string): string {
  const remotePath = remoteUrl.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const name = remotePath.split(/[/:]/).at(-1)?.replace(/\.git$/, '') || 'project'
  return joinHostPath(parent, safeProjectDirName(name))
}

/** A partial publish must keep its created local folder available for retry. */
export function publishProjectFailure(result: GithubPublishRepositoryResult): string | null {
  if (result.repository.status === 'failed') return result.repository.error
  if (result.remote.status === 'failed') return result.remote.error
  if (result.push.status === 'failed') return result.push.error
  return result.success ? null : 'The project was created locally, but GitHub publishing did not finish.'
}

/** Only folders can be a project. */
export function folderEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return entries.filter((entry) => entry.isDir)
}

export function matchingRepos(repos: SetupGithubRepo[], query: string): SetupGithubRepo[] {
  const needle = query.trim().toLowerCase()
  return needle ? repos.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : repos
}

/** The host validates and resolves the path; remembering it is best effort. */
export async function openExistingProjectFolder(api: Pick<HostApi, 'listDirectory' | 'trackRecentProject'>, path: string): Promise<string> {
  const result = await api.listDirectory(path.trim(), false, true)
  if (result.error) throw new Error(result.error)
  if (!result.currentPath) throw new Error('The host did not return a project folder.')
  void api.trackRecentProject(result.currentPath).catch(() => undefined)
  return result.currentPath
}
