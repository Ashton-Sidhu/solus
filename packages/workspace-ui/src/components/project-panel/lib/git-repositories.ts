import type { CodebaseMember, SessionFolder } from '@solus/contracts/codebases'
import { hostPathBaseName, hostPathKey, sameHostPath } from '@solus/contracts/host-path'
import type { GitState } from '@solus/contracts/types'
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
  /** The session folders of a started session, or the repositories that the host found in the project folder of a draft. */
  folders: readonly Pick<SessionFolder, 'path' | 'repositoryPath' | 'name' | 'state' | 'granted'>[]
}

/**
 * The repository of the working directory first, then each `git` session
 * folder in the order of the host. A working directory with no repository has
 * no row of its own: the card lists the repositories that the folder holds.
 */
export function gitRepositoryRows(input: GitRepositoriesInput): GitRepositoryRow[] {
  const { working } = input
  const rows: GitRepositoryRow[] = []
  if (working.repositoryPath) {
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

/** The repositories that the host found in the project folder of a draft, as the folders of `gitRepositoryRows`. */
function foundRepositoryFolders(members: readonly CodebaseMember[]): GitRepositoriesInput['folders'] {
  return members
    .filter((member) => member.discovered && member.state === 'git')
    .map((member) => ({ path: member.path, repositoryPath: member.path, name: member.name, state: 'git' as const, granted: true }))
}

/**
 * The repositories of the Git card of one run. A started session has its
 * session folders. A draft has none: its working directory with no
 * repository shows the repositories that the host found in it, because the
 * session gets them at its first prompt (decision 14). `sessionFolders` is
 * null for a draft, and `found` is the scan of its project folder.
 */
export function gitCardRepositories(input: {
  working: GitRepositoriesInput['working']
  sessionFolders: GitRepositoriesInput['folders'] | null
  found: readonly CodebaseMember[]
}): GitRepositoryRow[] {
  const folders = input.sessionFolders ?? (input.working.repositoryPath ? [] : foundRepositoryFolders(input.found))
  return gitRepositoryRows({ working: input.working, folders })
}

/** The words beside the title of the card while it lists repositories: how many there are. */
export function gitRepositoriesDetail(rows: readonly GitRepositoryRow[]): string | undefined {
  return showsRepositoryRows(rows) ? `${rows.length} ${rows.length === 1 ? 'repository' : 'repositories'}` : undefined
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
  /** The branch. A folder that is not attached shows "Not attached" in its place: its branch is in the tooltip. */
  badge: string | undefined
  diffStat: { insertions: number; deletions: number } | undefined
  /** One line: the tooltip of a row does not keep a line break, so the facts are joined with " · ". */
  tooltip: string
}

export function gitRepositoryReading(row: GitRepositoryRow, status: GitState | null | undefined): GitRepositoryReading {
  const branch = status?.branch ?? (status ? 'Detached HEAD' : undefined)
  const changes = changesRow(status)
  const facts = [
    row.path,
    row.isIsolated ? ISOLATED_NOTE : null,
    row.isObserved ? OBSERVED_NOTE : null,
    row.isObserved && branch ? `Branch ${branch}` : null,
    changes.tooltip ?? null,
  ].filter((fact): fact is string => !!fact)
  return {
    badge: row.isObserved ? 'Not attached' : branch,
    diffStat: changes.lines,
    tooltip: facts.join(' · '),
  }
}

/** What a screen reader hears for a repository row: its name, its place in the session, and what a choice does. */
export function gitRepositoryRowLabel(row: GitRepositoryRow, isChosen: boolean): string {
  const place = row.isWorkingDirectory ? `${row.name}, the working directory` : row.name
  return isChosen ? `${place}: the Git actions below work in this repository` : `${place}: work in this repository with the Git actions below`
}

/** The repositories that "Add repository" offers in a task folder session, by name. */
export function candidateRows(candidates: readonly CodebaseMember[]): { path: string; name: string }[] {
  return candidates
    .map((member) => ({ path: member.path, name: member.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
