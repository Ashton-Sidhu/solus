import { dirname, join } from 'path'
import { mkdir, readdir, readFile, realpath, stat } from 'fs/promises'
import { z } from 'zod'
import type { CreateDirectoryResult, DirectoryEntry, DirectoryListResult, ProjectFilesResult } from '../../../shared/types'
import { listProjects } from '../../project-config/projects-manifest'
import { createLogger } from '../../logger'
import { getFinder } from '../file-finder'
import type { SolusServer } from '../server'
import { expandHome } from './lib/host-path'
import { projectRootForRequest } from './lib/file-preview'

const log = createLogger('main', 'filesystem-handlers')

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

const PROJECT_FILES_MAX_ENTRIES = 25_000

function normalizeFinderRelativePath(input: string): string {
  return input.replaceAll('\\', '/').replace(/\/+$/, '')
}

async function listIndexedProjectFiles(root: string): Promise<ProjectFilesResult> {
  const finder = await getFinder(root)
  if (!finder) {
    return { ok: false, root, error: 'Unable to index project files.' }
  }

  const result = finder.mixedSearch('', { pageSize: PROJECT_FILES_MAX_ENTRIES + 2 })
  if (!result.ok) {
    log.warn('project_files_mixed_search_failed', { root, error: result.error })
    return { ok: false, root, error: result.error }
  }

  const files: string[] = []
  for (const entry of result.value.items) {
    if (entry.type !== 'file') continue
    const relativePath = normalizeFinderRelativePath(entry.item.relativePath)
    if (relativePath) {
      files.push(relativePath)
    }
    if (files.length >= PROJECT_FILES_MAX_ENTRIES) {
      break
    }
  }

  files.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))

  return {
    ok: true,
    root,
    files,
    truncated: result.value.totalMatched > PROJECT_FILES_MAX_ENTRIES,
    source: 'index',
  }
}

const filesystemErrorSchema = z.object({ code: z.string().optional() })

function friendlyFsError(error: Error, fallback: string): string {
  const parsed = filesystemErrorSchema.safeParse(error)
  const code = parsed.success ? parsed.data.code : undefined
  if (code === 'EACCES' || code === 'EPERM') return 'You don’t have permission to open this folder.'
  if (code === 'ENOENT') return 'This folder no longer exists.'
  if (code === 'ENOTDIR') return 'This location is not a folder.'
  return fallback
}

export function registerFilesystemHandlers(server: SolusServer): void {
  server.register('listDirectory', async (args) => {
    const [rawPath, showHidden, annotate] = args
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
        error: error instanceof Error
          ? friendlyFsError(error, 'Couldn’t open this folder.')
          : 'Couldn’t open this folder.',
      } satisfies DirectoryListResult
    }
  })

  server.register('createDirectory', async (args) => {
    const [rawPath] = args
    const resolved = expandHome(rawPath)

    try {
      await mkdir(resolved, { recursive: true })
      return { path: resolved, error: null } satisfies CreateDirectoryResult
    } catch (error) {
      return {
        path: resolved,
        error: error instanceof Error
          ? friendlyFsError(error, 'Couldn’t create this folder.')
          : 'Couldn’t create this folder.',
      } satisfies CreateDirectoryResult
    }
  })

  // Indexed (gitignore-aware) project listing, here rather than in the
  // desktop-only file handlers: the diff heat map and file surfaces need it on
  // a paired headless host too.
  server.register('listProjectFiles', async (args) => {
    const [ctx, request] = args
    const rawRoot = projectRootForRequest(ctx, request?.cwd)
    if (!rawRoot) {
      return { ok: false, error: 'No project directory is available.' } satisfies ProjectFilesResult
    }

    let root: string
    try {
      root = await realpath(rawRoot)
      const rootStat = await stat(root)
      if (!rootStat.isDirectory()) {
        return { ok: false, root, error: 'Project path is not a directory.' } satisfies ProjectFilesResult
      }
    } catch (err) {
      return {
        ok: false,
        root: rawRoot,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ProjectFilesResult
    }

    return await listIndexedProjectFiles(root)
  })
}
