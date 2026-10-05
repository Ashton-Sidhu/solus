import { basename, dirname, join, relative as pathRelative, resolve as pathResolve } from 'path'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'fs/promises'
import { z } from 'zod'
import type { CreateDirectoryResult, DirectoryEntry, DirectoryListResult, FileMatch, ProjectContentSearchResult, ProjectFileMutationResult, ProjectFilesResult, WriteFileResult } from '@solus/contracts/types'
import { listProjects } from '../../project-config/projects-manifest'
import { createLogger } from '../../logger'
import { isInsideRoot } from '../../paths'
import { getFinder, refreshFinder } from '../../files/file-finder'
import type { SolusServer } from '../server'
import { browseFileMatches } from '../../files/file-browse'
import { searchProjectContents } from '../../files/content-search'
import { expandHome } from '../../files/host-path'
import { projectRootForRequest, readFilePreview, resolvePreviewPath } from '../../files/file-preview'
import { directoriesHoldingFiles } from '../../files/project-listing'
import { applyProjectFileMutation } from '../../files/project-mutations'
import { applyHostPathMutation } from '../../files/host-path-mutations'

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

function compareProjectPaths(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

async function listIndexedProjectFiles(
  root: string,
  includeEmptyDirectories: boolean,
): Promise<ProjectFilesResult> {
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
  const directories: string[] = []
  for (const entry of result.value.items) {
    const relativePath = normalizeFinderRelativePath(entry.item.relativePath)
    if (!relativePath) continue
    if (entry.type !== 'file') {
      if (includeEmptyDirectories) directories.push(relativePath)
      continue
    }
    files.push(relativePath)
    if (files.length >= PROJECT_FILES_MAX_ENTRIES) {
      break
    }
  }

  files.sort(compareProjectPaths)

  const listing: ProjectFilesResult = {
    ok: true,
    root,
    files,
    truncated: result.value.totalMatched > PROJECT_FILES_MAX_ENTRIES,
    source: 'index',
  }
  if (includeEmptyDirectories) {
    const holders = directoriesHoldingFiles(files)
    listing.emptyDirectories = directories
      .filter(directory => !holders.has(directory))
      .map(directory => `${directory}/`)
      .sort(compareProjectPaths)
  }
  return listing
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

  server.register('mutateHostPath', async (args) => {
    const [mutation] = args
    const result = await applyHostPathMutation(mutation)
    log.info('host_path_mutated', { op: mutation.op, ok: result.ok })
    return result
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

    return await listIndexedProjectFiles(root, request?.includeEmptyDirectories === true)
  })

  server.register('mutateProjectFile', async (args) => {
    const [ctx, request] = args
    const rawRoot = projectRootForRequest(ctx, request?.cwd)
    if (!rawRoot) return { ok: false, error: 'No project directory is available.' } satisfies ProjectFileMutationResult

    let root: string
    try {
      root = await realpath(rawRoot)
    } catch {
      return { ok: false, error: 'The project directory is no longer reachable.' } satisfies ProjectFileMutationResult
    }
    return await applyProjectFileMutation(root, request.mutation)
  })

  server.register('searchFiles', async (args) => {
    const [query, cwd] = args
    // Keep the native page small: results render ranked by match score, and a
    // large page buries good matches in noise. fff does not index dotfiles or
    // dot-directories, so hidden paths are intentionally absent from results.
    const MAX = 25

    const cwdRoot = cwd.replace(/\/+$/, '')
    const toDisplay = (p: string): string =>
      p === cwdRoot ? basename(p) : p.startsWith(cwdRoot + '/') ? p.slice(cwdRoot.length + 1) : p

    // Explicit paths browse one directory, including paths outside the project.
    // Only plain project queries may create a recursive index.
    const browsed = await browseFileMatches(query, cwd)
    if (browsed) return { files: browsed }

    const base = cwd
    const search = query

    const finder = await getFinder(base)
    if (!finder) return { files: [] }

    const result = finder.mixedSearch(search, { pageSize: MAX })
    if (!result.ok) {
      log.warn('search_files_mixed_search_failed', { search, base, error: result.error })
      return { files: [] }
    }

    const files: FileMatch[] = []
    for (const entry of result.value.items) {
      const relativePath =
        entry.type === 'directory' && (
          entry.item.relativePath === '' ||
          entry.item.relativePath === '.' ||
          entry.item.relativePath === '/'
        )
          ? entry.item.dirName.replace(/\/$/, '')
          : entry.item.relativePath
      const path = join(base, relativePath).replace(/\/+$/, '')
      files.push({ path, display: toDisplay(path), isDir: entry.type === 'directory' })
    }

    // mixedSearch already returns relevance order. Unlike browse mode above,
    // do not regroup directories ahead of files after the user starts typing.
    return { files }
  })

  server.register('searchProjectContents', async (args) => {
    const [ctx, request] = args
    // Scoped to the caller's environment cwd, which already resolves to the
    // worktree path for an isolated session — searching the main checkout would
    // return matches the session cannot act on.
    const rawRoot = projectRootForRequest(ctx, request?.cwd)
    if (!rawRoot) return { ok: false, error: 'No project directory is available.' } satisfies ProjectContentSearchResult

    let root: string
    try {
      root = await realpath(rawRoot)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ProjectContentSearchResult
    }
    return searchProjectContents(root, request)
  })

  server.register('readProjectFile', async (args) => {
    const [ctx, request] = args
    return readFilePreview(ctx, request)
  })

  server.register('writeFile', async (args) => {
    const [ctx, request] = args
    // A host-destination write is a destination the user picked themselves in
    // the directory picker, so it is not anchored to a project at all.
    const toHost = request?.destination === 'host'
    const rawRoot = toHost ? null : projectRootForRequest(ctx, request?.cwd)
    const requestedPath = request?.path ?? ''
    if (!requestedPath) {
      return { ok: false, path: requestedPath, error: 'No file path was provided.' } satisfies WriteFileResult
    }

    let root: string | null = null
    if (rawRoot) {
      try {
        root = await realpath(rawRoot)
      } catch (err) {
        return {
          ok: false,
          path: requestedPath,
          error: err instanceof Error ? err.message : String(err),
        } satisfies WriteFileResult
      }
    }

    const resolved = toHost ? expandHome(requestedPath) : resolvePreviewPath(requestedPath, root ?? undefined)
    let target = resolved

    try {
      target = await realpath(resolved)
    } catch {
      try {
        const parent = await realpath(dirname(resolved))
        target = pathResolve(parent, basename(resolved))
      } catch (err) {
        return {
          ok: false,
          path: resolved,
          error: err instanceof Error ? err.message : String(err),
        } satisfies WriteFileResult
      }
    }

    // A file outside the project saves where it is, like a file inside it.
    const insideRoot = root !== null && isInsideRoot(root, target)
    try {
      if (request.expectedContents !== undefined) {
        const currentContents = await readFile(target, 'utf8')
        if (currentContents !== request.expectedContents) {
          return {
            ok: false,
            path: target,
            error: 'File changed on disk. Reload before saving.',
            conflict: true,
          } satisfies WriteFileResult
        }
      }
      const encoding = request.encoding === 'base64' ? 'base64' : 'utf8'
      const payload = Buffer.from(request.contents, encoding)
      await writeFile(target, payload)
      if (root && insideRoot) await refreshFinder(root)
      return {
        ok: true,
        path: target,
        // Relative to the project it belongs to; an export has no project to be
        // relative to, so it reports where it actually landed.
        displayPath: root && insideRoot ? pathRelative(root, target) || basename(target) : target,
        size: payload.byteLength,
      } satisfies WriteFileResult
    } catch (err) {
      return {
        ok: false,
        path: target,
        error: err instanceof Error ? err.message : String(err),
      } satisfies WriteFileResult
    }
  })
}
