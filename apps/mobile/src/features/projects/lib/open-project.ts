import { safeProjectDirName } from '@solus/contracts/project-folder-name'
import type { DirectoryEntry, SetupGithubRepo } from '@solus/contracts/types'

/** The last segment of a host path: `~/projects` reads as `projects`, `~` as your home folder. */
export function folderNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '~' || trimmed === '') return 'your home folder'
  return trimmed.split(/[\\/]/).pop() || trimmed
}

/** The quiet line under "Project name": where the host puts the new folder. */
export function newProjectLocationText(name: string, projectsFolderName: string, hostLabel: string): string {
  return name.trim()
    ? `Creates the folder ${safeProjectDirName(name)} in ${projectsFolderName} on ${hostLabel}`
    : `Creates a folder in ${projectsFolderName} on ${hostLabel}`
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

/** Only folders can be a project. */
export function folderEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return entries.filter((entry) => entry.isDir)
}

export function matchingRepos(repos: SetupGithubRepo[], query: string): SetupGithubRepo[] {
  const needle = query.trim().toLowerCase()
  return needle ? repos.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : repos
}
