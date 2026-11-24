/**
 * Codebases (docs/plans/codebases.md §2 and §4). A codebase is a named set of
 * folders, on one or more hosts, that one piece of work covers. The record
 * holds roots only: a host reads the members of a codebase from its own disk.
 * Each host keeps the full record. The newest `updatedAt` wins when two hosts
 * have different copies, and a delete is a tombstone, so it also moves.
 */

import { z } from 'zod'

export const CODEBASE_ROOTS_MAX = 128
/** A new worktree session isolates every repository only up to this many. */
export const CODEBASE_WORKTREE_DEFAULT_MAX = 8

/**
 * A folder that a person put in a codebase. The schema checks the shape that
 * crosses the RPC boundary. The store checks the rules of a codebase (a name,
 * absolute paths, no root twice, the limit of roots).
 */
export const codebaseRootSchema = z.object({
  /** The host the folder is on (decision 2): its installation id, never `local`. */
  installationId: z.string().min(1).max(200),
  /** Absolute on that host. Never `~`. */
  path: z.string().min(1).max(4096),
  name: z.string().max(200),
}).strict()
export type CodebaseRoot = z.infer<typeof codebaseRootSchema>

export const codebaseSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  roots: z.array(codebaseRootSchema),
  /** Epoch milliseconds of the last change. The newest copy wins. */
  updatedAt: z.number().int().nonnegative(),
  /** Set on a deleted codebase. The row stays so that the delete moves. */
  deletedAt: z.number().int().nonnegative().nullable(),
}).strict()
export type Codebase = z.infer<typeof codebaseSchema>

export const codebaseListOptionsSchema = z.object({
  /** Also answer the tombstones: a client needs them to send a delete to a host that has an older copy. */
  includeDeleted: z.boolean().optional(),
}).strict()
export type CodebaseListOptions = z.infer<typeof codebaseListOptionsSchema>

export type CodebaseMemberState = 'git' | 'plain' | 'missing'

/** One folder a codebase covers on the answering host. Read from the disk. */
export interface CodebaseMember {
  path: string
  name: string
  state: CodebaseMemberState
  /** `repositoryKeyFromRemoteUrl(origin)`, or null. */
  repositoryKey: string | null
  /** The root this member is, or was found in. */
  rootPath: string
  /** Found inside a root, not a root itself. */
  discovered: boolean
  /** False for a repository with no commit: it cannot get a worktree. */
  hasCommit: boolean
  /** A submodule follows its parent repository: it never gets its own worktree. */
  submodule: boolean
}

/** A folder outside the scanned one that a `.code-workspace` file in it lists. */
export interface CodebaseFolderSuggestion {
  path: string
  name: string
}

/** What one folder holds, for the editor of a codebase. */
export interface CodebaseFolderScan {
  /** The resolved absolute path. */
  path: string
  state: CodebaseMemberState
  members: CodebaseMember[]
  /** Folders outside `path` that a `.code-workspace` file in it lists. Never added by themselves. */
  suggestions: CodebaseFolderSuggestion[]
}

export const sessionFolderSourceSchema = z.enum(['codebase', 'attached', 'created', 'observed'])
export type SessionFolderSource = z.infer<typeof sessionFolderSourceSchema>

/** One folder that a session record keeps besides its working directory (`session_records.attached_folders`). */
export const sessionAttachedFolderSchema = z.object({
  path: z.string().min(1).max(4096),
  source: sessionFolderSourceSchema,
}).strict()
export type SessionAttachedFolder = z.infer<typeof sessionAttachedFolderSchema>

/** One folder a session works in besides its working directory. */
export interface SessionFolder {
  /** Where the session works: the member itself, or its worktree. */
  path: string
  name: string
  state: 'git' | 'plain'
  /** The folder `path` is a checkout of. Equal to `path` when it is not a worktree. */
  repositoryPath: string
  source: SessionFolderSource
  /** False for `observed`: the provider was not granted the folder, Solus only shows it. */
  granted: boolean
}

/**
 * The folder that holds every task folder of a host:
 * `<data folder>/solus-task-folders/<branch slug>-<8 hex>`. As for a chat
 * (`chat.ts`), the folder name is the only mark.
 */
export const TASK_FOLDER_ROOT_NAME = 'solus-task-folders'

export interface TaskFolderRepository {
  repositoryPath: string
  worktreePath: string
  name: string
}

export interface TaskFolder {
  root: string
  /** The folder `root` stands in for: a path below it is at the same place below `root`. */
  anchor: string
  /** The session's working directory inside `root`. */
  primaryPath: string
  /** The member that `primaryPath` stands in for. */
  primaryRepositoryPath: string
  /** False when the primary member is a plain folder: `primaryPath` then holds links to its entries. */
  primaryIsWorktree: boolean
  branch: string
  repositories: TaskFolderRepository[]
}

/** The holder folder, then the name of one task folder: a branch slug, a hyphen, and 8 hex digits. */
const TASK_FOLDER_IN_PATH = new RegExp(`(?:^|[\\\\/])${TASK_FOLDER_ROOT_NAME}[\\\\/][^\\\\/]+-[0-9a-f]{8}(?=[\\\\/]|$)`)

/**
 * The task folder that `path` is, or is inside: the path up to the folder
 * below `solus-task-folders`, in the path's own spelling. Null for every other
 * path, and for the holder folder itself.
 */
export function taskFolderRootOf(path: string | null | undefined): string | null {
  if (!path) return null
  const match = TASK_FOLDER_IN_PATH.exec(path)
  return match ? path.slice(0, match.index + match[0].length) : null
}

/** True for a task folder and for each path inside one. */
export function isTaskFolderPath(path: string | null | undefined): boolean {
  return taskFolderRootOf(path) !== null
}
