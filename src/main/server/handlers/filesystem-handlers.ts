import { dirname, join } from 'path'
import { mkdir, readdir, readFile, stat } from 'fs/promises'
import type { CreateDirectoryResult, DirectoryEntry, DirectoryListResult } from '../../../shared/types'
import { listProjects } from '../../project-config/projects-manifest'
import type { SolusServer } from '../server'
import { expandHome } from './lib/host-path'

/**
 * Filesystem browsing, registered unconditionally so a `--headless` host can
 * still be browsed from a paired client. Anything needing an Electron window
 * (the native folder dialog) stays in `file-handlers.ts`.
 */

/** Browsing an unfamiliar host stays legible only while annotating stays cheap. */
const MAX_ANNOTATED_ENTRIES = 200

/** `ref: refs/heads/main` -> `main`; a detached HEAD holds a bare sha and has no branch. */
export function branchFromGitHead(head: string): string | undefined {
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim())
  return match ? match[1].trim() : undefined
}

/**
 * Marks which folders are checkouts and which Solus already knows, so browsing
 * a machine you've never seen isn't a list of bare names. Best-effort: an entry
 * that can't be read keeps its plain form rather than failing the listing.
 */
async function annotateEntries(entries: DirectoryEntry[]): Promise<void> {
  const projectPaths = new Set((await listProjects().catch(() => [])).map((project) => project.path))
  await Promise.all(entries.slice(0, MAX_ANNOTATED_ENTRIES).map(async (entry) => {
    if (!entry.isDir) return
    if (projectPaths.has(entry.path)) entry.isProject = true
    const gitPath = join(entry.path, '.git')
    const isRepo = await stat(gitPath).then(() => true).catch(() => false)
    if (!isRepo) return
    entry.isRepo = true
    // A linked worktree's `.git` is a file pointing elsewhere; only a real
    // checkout has a HEAD to read here, and a missing branch is not an error.
    const head = await readFile(join(gitPath, 'HEAD'), 'utf-8').catch(() => null)
    if (head) entry.branch = branchFromGitHead(head)
  }))
}

export function sortDirEntries(entries: { name: string; isDir: boolean }[]) {
  return entries.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function friendlyFsError(error: unknown, fallback: string): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') return 'You don’t have permission to open this folder.'
  if (code === 'ENOENT') return 'This folder no longer exists.'
  if (code === 'ENOTDIR') return 'This location is not a folder.'
  return fallback
}

export function registerFilesystemHandlers(server: SolusServer): void {
  server.register('listDirectory', async (args) => {
    const [rawPath, showHidden, annotate] = args as [string, boolean | undefined, boolean | undefined]
    const resolved = expandHome(rawPath)
    const parent = dirname(resolved)

    try {
      const dirents = await readdir(resolved, { withFileTypes: true })
      const raw = await Promise.all(dirents.map(async (entry) => ({
        name: entry.name,
        isDir: entry.isDirectory() || (
          entry.isSymbolicLink()
          && await stat(join(resolved, entry.name)).then(target => target.isDirectory()).catch(() => false)
        ),
      })))
      const filtered = showHidden ? raw : raw.filter(e => !e.name.startsWith('.'))
      const sorted = sortDirEntries(filtered)
      const entries: DirectoryEntry[] = sorted.map(e => ({ name: e.name, isDir: e.isDir, path: join(resolved, e.name) }))
      if (annotate) await annotateEntries(entries)
      return {
        entries,
        parentPath: parent === resolved ? null : parent,
        currentPath: resolved,
        error: null,
      } satisfies DirectoryListResult
    } catch (error) {
      return {
        entries: [],
        parentPath: parent === resolved ? null : parent,
        currentPath: resolved,
        error: friendlyFsError(error, 'Couldn’t open this folder.'),
      } satisfies DirectoryListResult
    }
  })

  server.register('createDirectory', async (args) => {
    const [rawPath] = args as [string]
    const resolved = expandHome(rawPath)

    try {
      await mkdir(resolved, { recursive: true })
      return { path: resolved, error: null } satisfies CreateDirectoryResult
    } catch (error) {
      return {
        path: resolved,
        error: friendlyFsError(error, 'Couldn’t create this folder.'),
      } satisfies CreateDirectoryResult
    }
  })
}
