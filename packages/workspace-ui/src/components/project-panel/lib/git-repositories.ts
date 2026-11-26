import { isTaskFolderPath, type CodebaseMember, type SessionFolder, type TaskFolder } from '@solus/contracts/codebases'
import { hostPathBaseName, hostPathKey, sameHostPath } from '@solus/contracts/host-path'
import { isSolusWorktreePath, type GitState } from '@solus/contracts/types'
import type { CodebaseHostMembers } from '../../../contexts/codebases/codebases.store.svelte'
import type { SessionFolderPlace } from '../../../contexts/git/session-environment.store.svelte'
import { changesRow } from './changes-row'

/**
 * The repositories of the Git card (docs/plans/codebases.md §9, "Running
 * session"). A session can work in more than one repository: the repository
 * of its working directory, and each `git` session folder. The card then
 * shows one row for each, as it shows one row for each linked pull request,
 * and its Git rows (branch, commit and push, changes, pull request, discard)
 * work in one repository at a time: the chosen one. Pure: the component reads
 * the stores.
 */

const ISOLATED_NOTE = 'A worktree of this session: its changes stay out of the repository until they are merged.'
const OBSERVED_NOTE = 'The agent changed a file here, but the folder is not attached to the session.'

export interface GitRepositoryRow {
  /** One key for every spelling of the path. */
  key: string
  /** Where the session works: the repository, or its worktree. Git state is read by this path. */
  path: string
  /** The repository that `path` is a checkout of. */
  repositoryPath: string
  name: string
  /** The repository of the working directory of the session. */
  isWorkingDirectory: boolean
  /** `path` is a worktree, not the repository itself. */
  isIsolated: boolean
  /** The agent was not given the folder: Solus only shows it, for review. */
  isObserved: boolean
}

export interface GitRepositoriesInput {
  /** The working place of the run. */
  working: {
    path: string
    /** The repository of the working place, or null for a folder with no repository. */
    repositoryPath: string | null
    /** The project folder: it names the row of the working directory. */
    projectPath: string | null
  }
  /** The session folders of a started session, or the repositories of the codebase of a draft. */
  folders: readonly Pick<SessionFolder, 'path' | 'repositoryPath' | 'name' | 'state' | 'granted'>[]
  /**
   * The record of the task folder that a started session works in, or null.
   * Its worktrees are the repositories of the session: a row for each, named
   * by its repository, whatever the run's Git state says.
   */
  taskFolder?: Pick<TaskFolder, 'primaryPath' | 'primaryRepositoryPath' | 'primaryIsWorktree' | 'repositories'> | null
}

/**
 * The worktrees of a task folder: the one of the primary member, then one for
 * each other repository, in the order of the record. A primary member that is
 * a plain folder has no worktree, so it has no row.
 */
function taskFolderWorktrees(taskFolder: NonNullable<GitRepositoriesInput['taskFolder']>): { path: string; repositoryPath: string; name: string }[] {
  const primary = taskFolder.primaryIsWorktree
    ? [{ path: taskFolder.primaryPath, repositoryPath: taskFolder.primaryRepositoryPath, name: hostPathBaseName(taskFolder.primaryRepositoryPath) || taskFolder.primaryPath }]
    : []
  return [...primary, ...taskFolder.repositories.map((repository) => ({ path: repository.worktreePath, repositoryPath: repository.repositoryPath, name: repository.name }))]
}

/**
 * The repository of the working directory first, then each `git` session
 * folder in the order of the host. A working directory with no repository has
 * no row of its own: the card lists the repositories that the folder holds.
 *
 * A session in a task folder lists the worktrees of its record instead, as
 * the card of a session with one project shows its project: a `git_context`
 * that the client takes for the wrong place, or session folders that are not
 * read yet, cannot take a repository of the task folder off the card. The
 * worktree at the working directory is the row of the working directory.
 */
export function gitRepositoryRows(input: GitRepositoriesInput): GitRepositoryRow[] {
  const { working } = input
  const rows: GitRepositoryRow[] = []
  if (input.taskFolder) {
    for (const worktree of taskFolderWorktrees(input.taskFolder)) {
      const key = hostPathKey(worktree.path)
      if (rows.some((row) => row.key === key)) continue
      rows.push({
        key,
        path: worktree.path,
        repositoryPath: worktree.repositoryPath,
        name: worktree.name,
        isWorkingDirectory: sameHostPath(worktree.path, working.path),
        isIsolated: true,
        isObserved: false,
      })
    }
  } else if (working.repositoryPath) {
    rows.push({
      key: hostPathKey(working.path),
      path: working.path,
      repositoryPath: working.repositoryPath,
      name: hostPathBaseName(working.projectPath ?? working.repositoryPath) || working.path,
      isWorkingDirectory: true,
      isIsolated: !sameHostPath(working.repositoryPath, working.path),
      isObserved: false,
    })
  }
  for (const folder of input.folders) {
    const key = hostPathKey(folder.path)
    // The host never lists the working directory as a session folder; an old list can.
    if (folder.state !== 'git' || sameHostPath(folder.path, working.path) || rows.some((row) => row.key === key)) continue
    // A list from before the session moved into its task folder names the original of a repository that has its worktree there.
    if (input.taskFolder && rows.some((row) => sameHostPath(row.repositoryPath, folder.repositoryPath))) continue
    rows.push({
      key,
      path: folder.path,
      repositoryPath: folder.repositoryPath,
      name: folder.name,
      isWorkingDirectory: false,
      isIsolated: !sameHostPath(folder.path, folder.repositoryPath),
      isObserved: !folder.granted,
    })
  }
  return rows
}

/**
 * The members that one host read for a codebase (`CodebasesStore.membersOf`):
 * each root, and each repository that the host found in a root.
 */
export function codebaseMembersOn(groups: readonly CodebaseHostMembers[], serverId: string): CodebaseMember[] {
  return groups
    .filter((group) => group.serverId === serverId)
    .flatMap((group) => group.roots.flatMap((root) => [...(root.member ? [root.member] : []), ...root.found]))
}

/** The repositories of the codebase of a draft, as the folders of `gitRepositoryRows`. */
function memberRepositoryFolders(members: readonly CodebaseMember[]): GitRepositoriesInput['folders'] {
  return members
    .filter((member) => member.state === 'git')
    .map((member) => ({ path: member.path, repositoryPath: member.path, name: member.name, state: 'git' as const, granted: true }))
}

/**
 * The repositories of the Git card of one run. A started session has its
 * session folders. A draft has none: its working directory with no
 * repository shows the repositories of its codebase on the run host, because
 * the session gets them at its first prompt. A folder that holds repositories
 * is a container, and a container is a codebase (decision 14), so a draft
 * with no codebase has no repository besides its working directory.
 * `sessionFolders` is null for a draft, and `members` is what the run host
 * read for the codebase of the draft (`codebaseMembersOn`).
 */
export function gitCardRepositories(input: {
  working: GitRepositoriesInput['working']
  sessionFolders: GitRepositoriesInput['folders'] | null
  members: readonly CodebaseMember[]
  /** The task folder record of a started session (`useTaskFolderRead`): a draft has none. */
  taskFolder?: GitRepositoriesInput['taskFolder']
}): GitRepositoryRow[] {
  const folders = input.sessionFolders ?? (input.working.repositoryPath ? [] : memberRepositoryFolders(input.members))
  return gitRepositoryRows({ working: input.working, folders, taskFolder: input.sessionFolders ? input.taskFolder : null })
}

/**
 * True when the card shows its repository rows. A session in one repository
 * has none: the card looks as it does for each session with one project. A
 * working directory with no repository shows the rows also for one
 * repository, because the card must say which one its Git rows work in.
 */
export function showsRepositoryRows(rows: readonly GitRepositoryRow[]): boolean {
  return rows.length > 1 || (rows.length === 1 && !rows[0]!.isWorkingDirectory)
}

/** The card shows this many repository rows at most, until the person opens the rest. */
export const GIT_REPOSITORY_ROWS_FOLDED = 4

export interface GitRepositoryFold {
  /** The rows that show, in the order of the list. */
  visible: readonly GitRepositoryRow[]
  /** The text of the row that opens or closes the rest, or null for a list that has no such row. */
  toggleLabel: string | null
  /** The rest of a long list is open. */
  isExpanded: boolean
}

/**
 * The repository rows that show. A session can work in many repositories, so
 * the list shows four rows, then "Show N more", as the card folds its other
 * linked pull requests. The chosen repository always shows: the Git rows
 * below work in it, so the card must say which one it is. When the chosen row
 * is after the fourth one, it takes the place of the fourth.
 */
export function foldGitRepositoryRows(rows: readonly GitRepositoryRow[], chosenKey: string | null, isExpanded: boolean): GitRepositoryFold {
  if (rows.length <= GIT_REPOSITORY_ROWS_FOLDED) return { visible: rows, toggleLabel: null, isExpanded: false }
  if (isExpanded) return { visible: rows, toggleLabel: 'Show less', isExpanded: true }
  const first = rows.slice(0, GIT_REPOSITORY_ROWS_FOLDED)
  const chosen = chosenKey === null ? undefined : rows.find((row) => row.key === chosenKey)
  const visible = !chosen || first.includes(chosen) ? first : [...first.slice(0, GIT_REPOSITORY_ROWS_FOLDED - 1), chosen]
  return { visible, toggleLabel: `Show ${rows.length - visible.length} more`, isExpanded: false }
}

/**
 * The repository that the Git rows work in. `chosenPath` is the choice that
 * the view of the conversation keeps: null for no choice. A choice that is
 * not a row (no choice yet, or a folder that left the session) is the first
 * row: the repository of the working directory, else the first repository
 * that the working directory holds.
 */
export function chosenGitRepository(rows: readonly GitRepositoryRow[], chosenPath: string | null | undefined): GitRepositoryRow | null {
  const chosen = chosenPath ? rows.find((row) => sameHostPath(row.path, chosenPath)) : undefined
  return chosen ?? rows[0] ?? null
}

/** What the view keeps for a choice of `row`: null for the first row, so a session that gets a new first row follows it. */
export function gitRepositoryChoice(rows: readonly GitRepositoryRow[], row: GitRepositoryRow): string | null {
  return rows[0]?.key === row.key ? null : row.path
}

/**
 * The place that the Git section works in for a row: null for the working
 * directory, which is the place of the run, else the folder of the row.
 */
export function gitFolderOf(row: GitRepositoryRow | null): SessionFolderPlace | null {
  return row && !row.isWorkingDirectory ? { path: row.path, repositoryPath: row.repositoryPath } : null
}

/** What one repository row shows of its Git state. The component gives the status that the Git store has for the path of the row. */
export interface GitRepositoryReading {
  /**
   * "Not attached" for a folder that the agent was not given, else nothing.
   * The Git rows below the divider name the branch of the chosen repository,
   * so a row does not repeat it: the branch is in the tooltip.
   */
  badge: string | undefined
  diffStat: { insertions: number; deletions: number } | undefined
  /** One line: the tooltip of a row does not keep a line break, so the facts are joined with " · ". */
  tooltip: string
}

export function gitRepositoryReading(row: GitRepositoryRow, status: GitState | null | undefined): GitRepositoryReading {
  const branch = status?.branch ? `Branch ${status.branch}` : status ? 'Detached HEAD' : null
  const changes = changesRow(status)
  const facts = [
    row.path,
    row.isIsolated ? ISOLATED_NOTE : null,
    row.isObserved ? OBSERVED_NOTE : null,
    branch,
    changes.tooltip ?? null,
  ].filter((fact): fact is string => !!fact)
  return {
    badge: row.isObserved ? 'Not attached' : undefined,
    diffStat: changes.lines,
    tooltip: facts.join(' · '),
  }
}

/** What a screen reader hears for a repository row: its name, its place in the session, and what a choice does. */
export function gitRepositoryRowLabel(row: GitRepositoryRow, isChosen: boolean): string {
  const place = row.isWorkingDirectory ? `${row.name}, the working directory` : row.name
  return isChosen ? `${place}: the Git actions below work in this repository` : `${place}: work in this repository with the Git actions below`
}

/**
 * What "Add repository…" does in a session. The Git card of each started
 * session that the person can drive has the row; what it does depends on
 * where the session works:
 *
 * - `task-folder`: a menu of the repositories of the codebase with no
 *   worktree in the task folder; a pick makes the worktree.
 * - `folder`: the session works in its project folder, so it reaches the
 *   original of each repository. The person chooses a folder, and the host
 *   attaches it, as "Add folder…" does.
 * - `worktree`: one worktree inside its repository holds no second
 *   repository. The menu says so.
 */
export type AddRepositoryPlace = 'task-folder' | 'worktree' | 'folder'

export function addRepositoryPlace(cwd: string): AddRepositoryPlace {
  if (isTaskFolderPath(cwd)) return 'task-folder'
  return isSolusWorktreePath(cwd) ? 'worktree' : 'folder'
}

export const SINGLE_WORKTREE_NOTE = 'This session works in one worktree inside its repository, which cannot hold a second repository. Start a new worktree session to work in more than one.'

/** The tooltip of "Add repository…": what a click does. */
export function addRepositoryTooltip(place: AddRepositoryPlace): string {
  if (place === 'task-folder') return 'Make a worktree of one more repository, on the branch of this session'
  if (place === 'folder') return 'Choose a repository on this host for the session to work in'
  return SINGLE_WORKTREE_NOTE
}

/** The repositories that "Add repository" offers in a task folder session, by name. */
export function candidateRows(candidates: readonly CodebaseMember[]): { path: string; name: string }[] {
  return candidates
    .map((member) => ({ path: member.path, name: member.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
