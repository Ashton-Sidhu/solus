import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { CONTAINER_REPOSITORIES_MIN, type Codebase, type CodebaseFolderScan, type CodebaseFolderSuggestion, type CodebaseMember, type CodebaseMemberState } from '@solus/contracts/codebases'
import { hostPathKey } from '@solus/contracts/host-path'
import { repositoryKeyFromRemoteUrl } from '@solus/contracts/repository-key'
import { runAsync } from '../git/exec'
import { hasAnyCommit } from '../git/git-init'
import { runBounded } from '../lib/concurrency'
import { isInsideRoot } from '../paths'
import { resolveHomePath } from '../platform/paths'
import { readIgnoredRepositories } from '../project-config/project-config'

/**
 * The members of a codebase on this host (docs/plans/codebases.md §5). The
 * record holds roots only; this module reads the disk each time, so a
 * repository that is cloned inside a container root is a member on the next
 * read. A root that is not a container is one project: it is one member, and
 * the host does not look inside it.
 *
 * The file system decides what a folder is. Git runs only for the facts of a
 * repository that was found (its origin and whether it has a commit), a small
 * number of processes at a time.
 */

/** Folders that are read at the same time. */
const FOLDER_READS = 16
/** Repositories that Git is asked about at the same time. Each one is two short processes. */
const GIT_READS = 4

/** `.git` in a folder: a directory in a repository, a file in a linked worktree and in a submodule. */
type GitMark = 'directory' | 'file' | null

async function gitMarkOf(folder: string): Promise<GitMark> {
  const entry = await lstat(join(folder, '.git')).catch(() => null)
  if (!entry) return null
  return entry.isDirectory() ? 'directory' : 'file'
}

/** A path relative to a folder as `.gitmodules` and `ignoreRepositories` write it: `/` separators, no `./`, no trailing separator. */
function relativeKey(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
}

/** The submodule paths that the `.gitmodules` file of `repository` lists. */
async function submodulePathsOf(repository: string): Promise<string[]> {
  const text = await readFile(join(repository, '.gitmodules'), 'utf-8').catch(() => '')
  return [...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((match) => relativeKey(match[1]))
}

/**
 * Whether the nearest repository above `folder` lists it as a submodule. A
 * submodule follows its parent repository, so it never gets its own worktree.
 */
export async function isSubmodule(folder: string): Promise<boolean> {
  for (let parent = dirname(folder); ; parent = dirname(parent)) {
    if (await gitMarkOf(parent)) {
      return (await submodulePathsOf(parent)).includes(relativeKey(relative(parent, folder)))
    }
    if (parent === dirname(parent)) return false
  }
}

interface FoundRepository {
  path: string
  realPath: string
  /** The path has a symbolic link in it, below the root. */
  throughLink: boolean
}

/**
 * The repositories inside `root`: one level down, and one more level inside a
 * child that is a plain folder (`src`, `packages`). A repository is a folder
 * whose `.git` is a directory, so a linked worktree and a submodule are not
 * found. A symbolic link that resolves outside the root is not followed.
 */
export async function repositoriesInside(root: string): Promise<string[]> {
  const realRoot = await realpath(root)
  const skipped = [...await submodulePathsOf(root), ...(await readIgnoredRepositories(root)).map(relativeKey)].filter(Boolean)
  const isSkipped = (path: string): boolean => {
    const key = relativeKey(relative(root, path))
    return skipped.some((each) => key === each || key.startsWith(`${each}/`))
  }
  const found: FoundRepository[] = []

  const readLevel = async (folder: string, realFolder: string, level: 1 | 2, throughLink: boolean): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    await runBounded(entries.map((entry) => async () => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') return
      const path = join(folder, entry.name)
      if (isSkipped(path)) return
      const isLink = entry.isSymbolicLink()
      if (!isLink && !entry.isDirectory()) return
      const realPath = isLink ? await realpath(path).catch(() => null) : join(realFolder, entry.name)
      if (!realPath || !isInsideRoot(realRoot, realPath)) return
      if (isLink && !(await stat(realPath).catch(() => null))?.isDirectory()) return
      const mark = await gitMarkOf(path)
      if (mark === 'directory') found.push({ path, realPath, throughLink: throughLink || isLink })
      else if (mark === null && level === 1) await readLevel(path, realPath, 2, throughLink || isLink)
    }), FOLDER_READS)
  }
  await readLevel(root, realRoot, 1, false)

  // One repository is one member: a link to a repository that is also found by its own name adds nothing.
  const byRealPath = new Map<string, string>([[realRoot, root]])
  for (const repository of found.sort((a, b) => Number(a.throughLink) - Number(b.throughLink) || a.path.localeCompare(b.path))) {
    if (!byRealPath.has(repository.realPath)) byRealPath.set(repository.realPath, repository.path)
  }
  byRealPath.delete(realRoot)
  return [...byRealPath.values()].sort((a, b) => a.localeCompare(b))
}

interface FolderRead {
  state: CodebaseMemberState
  /** The folder itself, then the repositories found inside it. Git facts are not read yet. */
  members: CodebaseMember[]
}

function memberOf(path: string, name: string, state: CodebaseMemberState, rootPath: string): CodebaseMember {
  return { path, name: name || basename(path), state, repositoryKey: null, rootPath, discovered: path !== rootPath, hasCommit: false, submodule: false }
}

/**
 * What a folder that a person named is: a root of a codebase, or a folder
 * attached to a session. A person can name a linked worktree or a submodule,
 * so a folder with any `.git` is a repository here.
 */
export async function folderStateOf(path: string): Promise<CodebaseMemberState> {
  const isDirectory = isAbsolute(path) && (await stat(path).catch(() => null))?.isDirectory()
  if (!isDirectory) return 'missing'
  return await gitMarkOf(path) ? 'git' : 'plain'
}

/**
 * One folder with what it holds: what it is, and the repositories inside it.
 * This is the read of a container root, and of a folder that a person looks
 * at before it is in a codebase.
 */
async function readFolder(rootPath: string, name: string): Promise<FolderRead> {
  const state = await folderStateOf(rootPath)
  if (state === 'missing') return { state, members: [memberOf(rootPath, name, 'missing', rootPath)] }
  const inside = await repositoriesInside(rootPath)
  return {
    state,
    members: [memberOf(rootPath, name, state, rootPath), ...inside.map((path) => memberOf(path, '', 'git', rootPath))],
  }
}

/** One root that is a project: one member, the folder itself. The host does not look inside it. */
async function readProject(rootPath: string, name: string): Promise<FolderRead> {
  const state = await folderStateOf(rootPath)
  return { state, members: [memberOf(rootPath, name, state, rootPath)] }
}

/** Ask Git for the facts of each repository in `members`, in place. */
async function readGitFacts(members: CodebaseMember[]): Promise<void> {
  await runBounded(members.filter((member) => member.state === 'git').map((member) => async () => {
    const origin = await runAsync('git', ['remote', 'get-url', 'origin'], member.path).catch(() => null)
    member.repositoryKey = origin ? repositoryKeyFromRemoteUrl(origin) : null
    member.hasCommit = await hasAnyCommit(member.path)
    member.submodule = await isSubmodule(member.path)
  }), GIT_READS)
}

/**
 * True when `folder` is a container (docs/plans/codebases.md decision 14): it
 * is not a repository itself, and it holds two or more repositories, found by
 * the discovery rules of `repositoriesInside`. A container is a codebase,
 * never a project. A folder that holds one repository or none is a project.
 */
export async function isContainer(folder: string): Promise<boolean> {
  if (await folderStateOf(folder) !== 'plain') return false
  return (await repositoriesInside(folder).catch(() => [])).length >= CONTAINER_REPOSITORIES_MIN
}

/**
 * The folders that `codebase` covers on the host `installationId`: each root
 * on this host, and, for a container root, the repositories inside it. A root
 * on a different host is not read and is not in the answer. A root that is not
 * a folder is a member of state `missing`.
 */
export async function membersOf(codebase: Codebase, installationId: string): Promise<CodebaseMember[]> {
  const roots = codebase.roots.filter((root) => root.installationId === installationId)
  const reads = await runBounded(roots.map((root) => () => root.container ? readFolder(root.path, root.name) : readProject(root.path, root.name)), GIT_READS)
  // A root inside a different root is one member: the root, not the repository that discovery found.
  const rootKeys = new Set(roots.map((root) => hostPathKey(root.path)))
  const seen = new Set<string>()
  const members = reads.flatMap((read) => read.members).filter((member) => {
    const key = hostPathKey(member.path)
    if (seen.has(key) || (member.discovered && rootKeys.has(key))) return false
    seen.add(key)
    return true
  })
  await readGitFacts(members)
  return members
}

const codeWorkspaceSchema = z.object({
  folders: z.array(z.object({ path: z.string().optional(), name: z.string().optional() })),
})

type CodeWorkspace = z.infer<typeof codeWorkspaceSchema>

/**
 * The content of a `.code-workspace` file: JSON that can have comments and
 * trailing commas. Null when it cannot be read.
 */
function parseCodeWorkspace(text: string): CodeWorkspace | null {
  const STRING = '"(?:\\\\.|[^"\\\\])*"'
  const withoutComments = text.replace(new RegExp(`(${STRING})|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, 'g'), (_match, string: string | undefined) => string ?? '')
  const withoutTrailingCommas = withoutComments.replace(new RegExp(`(${STRING})|,(\\s*[}\\]])`, 'g'), (_match, string: string | undefined, close: string | undefined) => string ?? close ?? '')
  try {
    return codeWorkspaceSchema.parse(JSON.parse(withoutTrailingCommas))
  } catch {
    return null
  }
}

/** The folders outside `folder` that a `.code-workspace` file in it lists and that exist. */
async function workspaceSuggestions(folder: string): Promise<CodebaseFolderSuggestion[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const suggestions = new Map<string, CodebaseFolderSuggestion>()
  for (const entry of entries.filter((each) => each.isFile() && each.name.endsWith('.code-workspace')).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await readFile(join(folder, entry.name), 'utf-8').catch(() => '')
    const workspace = parseCodeWorkspace(text)
    if (!workspace) continue
    for (const listed of workspace.folders) {
      if (!listed.path) continue
      const path = resolve(folder, listed.path.split(/[\\/]/).join(sep))
      if (isInsideRoot(folder, path) || suggestions.has(path)) continue
      if (!(await stat(path).catch(() => null))?.isDirectory()) continue
      suggestions.set(path, { path, name: listed.name?.trim() || basename(path) })
    }
  }
  return [...suggestions.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * What one folder holds, before it is in a codebase: the folder, the
 * repositories inside it (the members that a container root at `path` gives),
 * and the folders that a `.code-workspace` file in it lists. A client reads
 * from it whether the folder is a container (`isContainerScan`). A suggestion
 * is never a member. `path` is a client path, so `~` is resolved here.
 */
export async function scanFolder(path: string): Promise<CodebaseFolderScan> {
  const resolved = resolve(resolveHomePath(path))
  const { state, members } = await readFolder(resolved, '')
  await readGitFacts(members)
  return {
    path: resolved,
    state,
    members,
    suggestions: state === 'missing' ? [] : await workspaceSuggestions(resolved),
  }
}
