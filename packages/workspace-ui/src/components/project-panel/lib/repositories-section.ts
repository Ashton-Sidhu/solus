import type { CodebaseMember, CodebaseMemberState, SessionFolder } from '@solus/contracts/codebases'
import { hostPathBaseName, hostPathKey, sameHostPath } from '@solus/contracts/host-path'
import type { GitState } from '@solus/contracts/types'
import type { CodebaseHostMembers, CodebaseHostPresence } from '../../../contexts/codebases/codebases.store.svelte'
import { PLAIN_MEMBER_LINKS_NOTE } from '../../input/lib/worktree-repositories'
import { changesRow } from './changes-row'
import type { TreeAgentRow } from './rail-agents'

/**
 * The Repositories section of the project panel (docs/plans/codebases.md §9,
 * "Running session"): the working directory of a session, each session
 * folder, and the folders of its codebase on other hosts. Pure: the component
 * reads the stores and calls the hosts. The section has no offer to make a
 * codebase: the host makes one when a folder is attached (decision 13).
 */

export type RepositoryRowAction = 'open-files' | 'open-terminal' | 'attach' | 'detach' | 'add-to-codebase' | 'track-with-git'

const ACTION_LABEL = {
  'open-files': 'Open files',
  'open-terminal': 'Open terminal',
  attach: 'Attach to this session',
  detach: 'Detach from this session',
  'track-with-git': 'Track with Git',
} satisfies Record<Exclude<RepositoryRowAction, 'add-to-codebase'>, string>

/**
 * The label of a row action in the row menu. "add-to-codebase" names the
 * codebase of the session, so it has no label of its own: a row has the
 * action only while the session has a codebase. Null when the codebase is
 * gone: the menu then shows no item for the action.
 */
export function repositoryActionLabel(action: RepositoryRowAction, codebaseName: string | null): string | null {
  if (action === 'add-to-codebase') return codebaseName ? `Add to ${codebaseName}` : null
  return ACTION_LABEL[action]
}

export const PLAIN_FOLDER_NOTE = 'This folder is not a repository, so it has no diff.'
export const OBSERVED_FOLDER_NOTE = 'The agent changed a file here, but the folder is not attached to the session. Attach it to give the agent the folder.'
const ISOLATED_NOTE = 'A worktree of this session: its changes stay out of the repository until they are merged.'

export interface RepositoryRow {
  /** One key for every spelling of the path. */
  key: string
  /** The working directory of the session, or one of its session folders. */
  kind: 'working' | 'folder'
  /** Where the session works: the folder, or its worktree. Git state is read by this path. */
  path: string
  /** The folder that `path` is a checkout of. */
  repositoryPath: string
  name: string
  state: 'git' | 'plain'
  /** `path` is a worktree in a task folder, not the repository itself. */
  isIsolated: boolean
  /** The agent was not given the folder: Solus only shows it. */
  isObserved: boolean
  /** The actions of the row menu, in the order they show. */
  actions: RepositoryRowAction[]
  /** Said below the row, or null. */
  note: string | null
}

export interface RepositoriesInput {
  /** The working place of the run. */
  working: {
    path: string
    /** The repository of the working place, or null for a folder with no repository. */
    repositoryPath: string | null
    /** The project folder: it names the row. */
    projectPath: string | null
    /** The working place holds links to a folder with no repository (a task folder session). */
    isLinkedPlainFolder: boolean
  }
  folders: readonly SessionFolder[]
  /** The session has a codebase: a folder that is not in it can be added. */
  hasCodebase: boolean
  /** True for a folder that the codebase of the session holds on this host now. The list of the host can be older: it is read at a turn start. */
  isInCodebase?(repositoryPath: string): boolean
  /** This client can open a terminal on the run host: the desktop app, on its own machine. */
  canOpenTerminal?: boolean
}

/** Each row opens its own folder: the files pane, and a terminal where this client has one. */
function openActions(canOpenTerminal: boolean): RepositoryRowAction[] {
  return canOpenTerminal ? ['open-files', 'open-terminal'] : ['open-files']
}

function folderActions(folder: SessionFolder, hasCodebase: boolean, isInCodebase: boolean, canOpenTerminal: boolean): RepositoryRowAction[] {
  const actions = openActions(canOpenTerminal)
  if (!folder.granted) actions.push('attach')
  // The host refuses to detach a folder of the codebase, and an observed folder is not attached.
  if (folder.granted && (folder.source === 'attached' || folder.source === 'created')) actions.push('detach')
  if (hasCodebase && folder.source !== 'codebase' && !isInCodebase) actions.push('add-to-codebase')
  if (folder.state === 'plain') actions.push('track-with-git')
  return actions
}

/** The working directory first, then each session folder in the order of the host. */
export function repositoryRows(input: RepositoriesInput): RepositoryRow[] {
  const { working } = input
  const workingRow: RepositoryRow = {
    key: hostPathKey(working.path),
    kind: 'working',
    path: working.path,
    repositoryPath: working.repositoryPath ?? working.path,
    name: hostPathBaseName(working.projectPath ?? working.repositoryPath ?? working.path) || working.path,
    state: working.repositoryPath ? 'git' : 'plain',
    isIsolated: !!working.repositoryPath && !sameHostPath(working.repositoryPath, working.path),
    isObserved: false,
    actions: openActions(input.canOpenTerminal ?? false),
    note: working.isLinkedPlainFolder ? PLAIN_MEMBER_LINKS_NOTE : null,
  }
  const folderRows = input.folders
    // The host never lists the working directory as a session folder; an old list can.
    .filter((folder) => !sameHostPath(folder.path, working.path))
    .map((folder): RepositoryRow => ({
      key: hostPathKey(folder.path),
      kind: 'folder',
      path: folder.path,
      repositoryPath: folder.repositoryPath,
      name: folder.name,
      state: folder.state,
      isIsolated: !sameHostPath(folder.path, folder.repositoryPath),
      isObserved: !folder.granted,
      actions: folderActions(folder, input.hasCodebase, input.isInCodebase?.(folder.repositoryPath) ?? false, input.canOpenTerminal ?? false),
      note: !folder.granted ? OBSERVED_FOLDER_NOTE : folder.state === 'plain' ? PLAIN_FOLDER_NOTE : null,
    }))
  return [workingRow, ...folderRows]
}

/** What one row shows of its Git state. The component gives the status that the Git store has for the row's path. */
export interface RepositoryRowReading {
  /** The branch, or a word for a row that has none to show. A folder that is
   *  not attached shows that word in place of its branch: `MenuRow` joins a
   *  prefix to the badge with no space, which is correct only for a
   *  reference such as `site#52`. Its branch is in the tooltip. */
  badge: string | undefined
  diffStat: { insertions: number; deletions: number } | undefined
  /** One line: the tooltip of a row does not keep a line break, so the facts are joined with " · ". */
  tooltip: string
}

export function repositoryRowReading(row: RepositoryRow, status: GitState | null | undefined): RepositoryRowReading {
  const branch = row.state === 'git' ? status?.branch ?? (status ? 'Detached HEAD' : undefined) : undefined
  const changes = row.state === 'git' ? changesRow(status) : null
  const facts = [
    row.path,
    row.isIsolated ? ISOLATED_NOTE : null,
    row.note,
    row.isObserved && branch ? `Branch ${branch}` : null,
    changes?.tooltip ?? null,
  ].filter((fact): fact is string => !!fact)
  return {
    badge: row.isObserved ? 'Not attached' : row.state === 'plain' ? 'No repository' : branch,
    diffStat: changes?.lines,
    tooltip: facts.join(' · '),
  }
}

/**
 * The open state of a row: true or false for a row that shows its Git rows
 * below it, where `expandedKey` is the key of the one open row. Undefined for
 * a row that opens nothing in place: the working directory opens its changes,
 * and a folder with no repository opens its menu.
 */
export function repositoryRowExpanded(row: RepositoryRow, expandedKey: string | null): boolean | undefined {
  if (row.kind !== 'folder' || row.state !== 'git') return undefined
  return row.key === expandedKey
}

export interface OtherHostRoot {
  path: string
  name: string
  /** What the host read at the root, or null before it answers. */
  state: CodebaseMemberState | null
}

/** The folders of the session's codebase on one host that is not the run host. */
export interface OtherHostFolders {
  installationId: string
  /** This client's id for the host, or null when this client does not know it. */
  serverId: string | null
  label: string
  presence: CodebaseHostPresence
  /** One or two words for the presence, or null for a host that is ready. */
  presenceNote: string | null
  roots: OtherHostRoot[]
  /** The child sessions of this session that run on the host. */
  sessions: Extract<TreeAgentRow, { kind: 'session' }>[]
}

const PRESENCE_NOTE = { ready: null, away: 'Offline', unknown: 'Not connected' } satisfies Record<CodebaseHostPresence, string | null>

/**
 * The roots of the codebase on the hosts that the session does not run on
 * (`CodebasesStore.membersOf`), each with the child sessions that work there.
 * A session changes only the folders on its run host: to change a folder on a
 * different host, the agent starts a session there. `runnerOf` gives this
 * client's id for the host that a child row names.
 */
export function otherHostFolders(
  groups: readonly CodebaseHostMembers[],
  runServerId: string,
  childRows: readonly TreeAgentRow[],
  runnerOf: (hostId: string) => string,
): OtherHostFolders[] {
  const sessions = childRows.filter((row): row is Extract<TreeAgentRow, { kind: 'session' }> => row.kind === 'session')
  return groups
    .filter((group) => group.serverId !== runServerId)
    .map((group) => ({
      installationId: group.installationId,
      serverId: group.serverId,
      label: group.label ?? 'Unknown host',
      presence: group.presence,
      presenceNote: PRESENCE_NOTE[group.presence],
      roots: group.roots.map(({ root, member }) => ({ path: root.path, name: root.name, state: member?.state ?? null })),
      sessions: group.serverId ? sessions.filter((row) => runnerOf(row.serverId) === group.serverId) : [],
    }))
}

/** One line for a child session on another host: its branch and what it changed, when this client has read them. */
export function childRepositoryNote(status: GitState | null | undefined): string | null {
  if (!status) return null
  const changes = changesRow(status)
  const counts = changes.lines
    ? [changes.lines.insertions ? `+${changes.lines.insertions}` : '', changes.lines.deletions ? `−${changes.lines.deletions}` : ''].filter(Boolean).join(' ')
    : ''
  return [status.branch ?? 'Detached HEAD', counts].filter(Boolean).join(' · ')
}

/** The repositories that "Add repository" offers in a task folder session, by name. */
export function candidateRows(candidates: readonly CodebaseMember[]): { path: string; name: string }[] {
  return candidates
    .map((member) => ({ path: member.path, name: member.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
