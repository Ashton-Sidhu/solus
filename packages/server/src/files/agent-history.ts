import { open, readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { trimTrailingSeparators } from '@solus/contracts/host-path'
import type { AgentHistoryProject } from '@solus/contracts/agent-history'
import { isTaskFolderPath } from '@solus/contracts/codebases'

/**
 * The folders the person used with Claude Code and Codex on this host
 * (docs/plans/one-page-onboarding.md decision 6, §3.2). A folder is the working
 * directory a thread file names: Claude Code writes `cwd` on its entries, Codex
 * writes it on the `session_meta` entry. The name of a Claude project folder
 * encodes the path lossily, so it is never decoded.
 *
 * Only the head of each file is read, newest files first, with a limit on the
 * files, the bytes, and the time; a file that names no folder in its head
 * counts for nothing.
 *
 * A git worktree is not a project: its threads count for the checkout it was
 * made from, so a repository used only through worktrees is still offered. A
 * Solus task folder that no longer holds a worktree is left out.
 */

type AgentHistorySource = AgentHistoryProject['sources'][number]

export interface AgentHistoryRoots {
  /** `<CLAUDE_CONFIG_DIR>/projects`: one folder per project, its thread files directly inside. */
  claudeProjects: string
  /** `<CODEX_HOME>/sessions`: `<year>/<month>/<day>/rollout-*.jsonl`. */
  codexSessions: string
}

export interface AgentHistoryLimits {
  /** The newest thread files read. */
  maxFiles: number
  /** The bytes read from the start of one file to find its folder. */
  headBytes: number
  /** The time for the whole read; older files past it are left out. */
  budgetMs: number
  /** The folders returned. */
  maxProjects: number
}

export const AGENT_HISTORY_LIMITS: AgentHistoryLimits = {
  maxFiles: 2000,
  // The first Claude entry with `cwd` follows the first prompt, which can be long.
  headBytes: 1024 * 1024,
  budgetMs: 3000,
  maxProjects: 200,
}

/** Thread files listed before any is read: the listing itself must stay bounded. */
const MAX_LISTED_FILES = 20_000
/** `<year>/<month>/<day>` under the Codex sessions folder. */
const CODEX_SESSIONS_DEPTH = 3
const READ_CHUNK_BYTES = 64 * 1024
const READ_CONCURRENCY = 8

interface ThreadFile {
  path: string
  source: AgentHistorySource
  modifiedAt: number
}

export async function readAgentHistoryProjects(options: {
  roots: AgentHistoryRoots
  /** The paths of this host's projects. */
  projectPaths: ReadonlySet<string>
  limits?: Partial<AgentHistoryLimits>
}): Promise<AgentHistoryProject[]> {
  const limits = { ...AGENT_HISTORY_LIMITS, ...options.limits }
  const deadline = Date.now() + limits.budgetMs
  const listed = [
    ...await claudeThreadFiles(options.roots.claudeProjects),
    ...await jsonlFilesBelow(options.roots.codexSessions, CODEX_SESSIONS_DEPTH),
  ].slice(0, MAX_LISTED_FILES)
  const files = (await withModifiedAt(listed))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
    .slice(0, limits.maxFiles)

  const folders = new Map<string, { sources: Set<AgentHistorySource>; threadCount: number; lastUsedAt: number }>()
  let next = 0
  const readNext = async (): Promise<void> => {
    while (next < files.length && Date.now() < deadline) {
      const file = files[next++]
      const folder = await folderOfThread(file, limits.headBytes)
      if (!folder) continue
      const entry = folders.get(folder) ?? { sources: new Set(), threadCount: 0, lastUsedAt: 0 }
      entry.sources.add(file.source)
      entry.threadCount += 1
      entry.lastUsedAt = Math.max(entry.lastUsedAt, file.modifiedAt)
      folders.set(folder, entry)
    }
  }
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, readNext))

  const projects = new Map<string, { sources: Set<AgentHistorySource>; threadCount: number; lastUsedAt: number }>()
  for (const [folder, entry] of folders) {
    const project = await projectFolderOf(folder)
    if (!project) continue
    const merged = projects.get(project)
    if (!merged) {
      projects.set(project, entry)
      continue
    }
    for (const source of entry.sources) merged.sources.add(source)
    merged.threadCount += entry.threadCount
    merged.lastUsedAt = Math.max(merged.lastUsedAt, entry.lastUsedAt)
  }

  const newest = [...projects]
    .sort(([pathA, a], [pathB, b]) => b.lastUsedAt - a.lastUsedAt || pathA.localeCompare(pathB))
    .slice(0, limits.maxProjects)
  return Promise.all(newest.map(async ([path, entry]) => ({
    path,
    name: basename(path) || path,
    sources: (['claude-code', 'codex'] as const).filter((source) => entry.sources.has(source)),
    threadCount: entry.threadCount,
    lastUsedAt: entry.lastUsedAt,
    exists: await stat(path).then((info) => info.isDirectory(), () => false),
    isProject: options.projectPaths.has(path),
  })))
}

/** `gitdir: <checkout>/.git/worktrees/<name>`: what a linked worktree's `.git` file says. */
const WORKTREE_GITDIR = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/m

/**
 * The project a thread's folder belongs to: the checkout a worktree was made
 * from, the folder itself otherwise. Null for a task folder with no worktree
 * left in it. Reads the `.git` file only, never runs git: there may be hundreds.
 */
async function projectFolderOf(folder: string): Promise<string | null> {
  const dotGit = await readFile(join(folder, '.git'), 'utf8').catch(() => null)
  const checkout = dotGit ? WORKTREE_GITDIR.exec(dotGit)?.[1] : undefined
  if (checkout) return trimTrailingSeparators(resolve(folder, checkout))
  return isTaskFolderPath(folder) ? null : folder
}

/** `<root>/<project>/<thread>.jsonl`. A thread's subagents sit one folder lower and are not threads. */
async function claudeThreadFiles(root: string): Promise<Omit<ThreadFile, 'modifiedAt'>[]> {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files: Omit<ThreadFile, 'modifiedAt'>[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(root, project.name)
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ path: join(dir, entry.name), source: 'claude-code' })
      if (files.length >= MAX_LISTED_FILES) return files
    }
  }
  return files
}

async function jsonlFilesBelow(dir: string, depth: number, files: Omit<ThreadFile, 'modifiedAt'>[] = []): Promise<Omit<ThreadFile, 'modifiedAt'>[]> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (files.length >= MAX_LISTED_FILES) break
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ path, source: 'codex' })
    else if (entry.isDirectory() && depth > 0) await jsonlFilesBelow(path, depth - 1, files)
  }
  return files
}

async function withModifiedAt(files: Omit<ThreadFile, 'modifiedAt'>[]): Promise<ThreadFile[]> {
  const stated: ThreadFile[] = []
  for (let i = 0; i < files.length; i += 64) {
    const batch = await Promise.all(files.slice(i, i + 64).map(async (file) => {
      const info = await stat(file.path).catch(() => null)
      return info ? { ...file, modifiedAt: Math.trunc(info.mtimeMs) } : null
    }))
    for (const file of batch) if (file) stated.push(file)
  }
  return stated
}

/** The folder a thread file names in its first `headBytes`, or null. */
async function folderOfThread(file: ThreadFile, headBytes: number): Promise<string | null> {
  const handle = await open(file.path, 'r').catch(() => null)
  if (!handle) return null
  try {
    let pending = Buffer.alloc(0)
    let offset = 0
    while (offset < headBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, headBytes - offset))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
      const atEnd = bytesRead < chunk.length
      offset += bytesRead
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
      // A newline byte never occurs inside a UTF-8 sequence, so each complete line decodes alone.
      let newline = pending.indexOf(0x0a)
      while (newline !== -1) {
        const folder = folderOfEntry(pending.subarray(0, newline).toString('utf8'), file.source)
        if (folder) return folder
        pending = pending.subarray(newline + 1)
        newline = pending.indexOf(0x0a)
      }
      if (atEnd) return folderOfEntry(pending.toString('utf8'), file.source)
    }
    return null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Claude Code writes the working directory on its entries. */
const claudeEntrySchema = z.object({ cwd: z.string() })
/** Codex writes it once, on the thread's `session_meta` entry. */
const codexEntrySchema = z.object({ type: z.literal('session_meta'), payload: z.object({ cwd: z.string() }) })

function folderOfEntry(line: string, source: AgentHistorySource): string | null {
  if (!line.trim()) return null
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  const cwd = source === 'claude-code'
    ? claudeEntrySchema.safeParse(entry).data?.cwd
    : codexEntrySchema.safeParse(entry).data?.payload.cwd
  if (!cwd || !isAbsolute(cwd) || cwd.includes('\0')) return null
  return trimTrailingSeparators(cwd)
}
