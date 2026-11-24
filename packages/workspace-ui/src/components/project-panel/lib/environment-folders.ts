import type { CodebaseMemberState, SessionFolder } from '@solus/contracts/codebases'
import { hostPathKey, sameHostPath } from '@solus/contracts/host-path'
import type { GitState } from '@solus/contracts/types'
import type { CodebaseHostMembers, CodebaseHostPresence } from '../../../contexts/codebases/codebases.store.svelte'
import { changesRow } from './changes-row'
import type { TreeAgentRow } from './rail-agents'

/**
 * The folders of the Environment card (docs/plans/codebases.md §9, "Running
 * session"). The card shows where a session works: its project, then each
 * session folder that is not a repository of that project (an attached
 * folder, a member of the codebase outside the project folder, a folder that
 * the agent wrote in), and the folders of its codebase on other hosts. The
 * Git card has the Git state of each repository. Pure: the component reads
 * the stores and calls the hosts.
 */

export type EnvironmentFolderAction = 'open-files' | 'open-terminal' | 'attach' | 'detach' | 'add-to-codebase' | 'track-with-git'

const ACTION_LABEL = {
  'open-files': 'Open files',
  'open-terminal': 'Open terminal',
  attach: 'Attach to this session',
  detach: 'Detach from this session',
  'track-with-git': 'Track with Git',
} satisfies Record<Exclude<EnvironmentFolderAction, 'add-to-codebase'>, string>

/**
 * The label of a folder action in the menu of its row. "add-to-codebase"
 * names the codebase of the session, so it has no label of its own: a row has
 * the action only while the session has a codebase. Null when the codebase is
 * gone: the menu then shows no item for the action.
 */
export function environmentFolderActionLabel(action: EnvironmentFolderAction, codebaseName: string | null): string | null {
  if (action === 'add-to-codebase') return codebaseName ? `Add to ${codebaseName}` : null
  return ACTION_LABEL[action]
}

export const PLAIN_FOLDER_NOTE = 'This folder is not a repository, so it has no diff.'
export const OBSERVED_FOLDER_NOTE = 'The agent changed a file here, but the folder is not attached to the session. Attach it to give the agent the folder.'
const ISOLATED_NOTE = 'A worktree of this session: its changes stay out of the repository until they are merged.'

export interface EnvironmentFolderRow {
  /** One key for every spelling of the path. */
  key: string
  /** Where the session works: the folder, or its worktree. */
  path: string
  /** The folder that `path` is a checkout of. */
  repositoryPath: string
  name: string
  state: 'git' | 'plain'
  /** `path` is a worktree in a task folder, not the repository itself. */
  isIsolated: boolean
  /** The state of the folder in one or two words, or null for a folder of the work that is a repository: the Git card has its state. */
  mark: 'Not attached' | 'No repository' | null
  /** The actions of the row menu, in the order they show. */
  actions: EnvironmentFolderAction[]
  /** One line for the tooltip of the row. */
  tooltip: string
}

export interface EnvironmentFoldersInput {
  /** The working place of the run. It is the project row of the card, not a folder row. */
  workingPath: string
  folders: readonly SessionFolder[]
  /** The session has a codebase: a folder that is not in it can be added. */
  hasCodebase: boolean
  /** True for a folder that the codebase of the session holds on this host now. The list of the host can be older: it is read at a turn start. */
  isInCodebase?(repositoryPath: string): boolean
  /** This client can open a terminal on the run host: the desktop app, on its own machine. */
  canOpenTerminal?: boolean
}

function actionsOf(folder: SessionFolder, hasCodebase: boolean, isInCodebase: boolean, canOpenTerminal: boolean): EnvironmentFolderAction[] {
  const actions: EnvironmentFolderAction[] = canOpenTerminal ? ['open-files', 'open-terminal'] : ['open-files']
  if (!folder.granted) actions.push('attach')
  // The host refuses to detach a folder of the codebase, and an observed folder is not attached.
  if (folder.granted && (folder.source === 'attached' || folder.source === 'created')) actions.push('detach')
  if (hasCodebase && folder.source !== 'codebase' && !isInCodebase) actions.push('add-to-codebase')
  if (folder.state === 'plain') actions.push('track-with-git')
  return actions
}

/**
 * One row for each session folder that is not a repository of the project, in
 * the order of the host. A repository that the host found in the project
 * folder (`project`) is in the Git card only: it is inside the project that
 * the card names already.
 */
export function environmentFolderRows(input: EnvironmentFoldersInput): EnvironmentFolderRow[] {
  return input.folders
    // The host never lists the working directory as a session folder; an old list can.
    .filter((folder) => folder.source !== 'project' && !sameHostPath(folder.path, input.workingPath))
    .map((folder): EnvironmentFolderRow => {
      const isIsolated = !sameHostPath(folder.path, folder.repositoryPath)
      const note = !folder.granted ? OBSERVED_FOLDER_NOTE : folder.state === 'plain' ? PLAIN_FOLDER_NOTE : isIsolated ? ISOLATED_NOTE : null
      return {
        key: hostPathKey(folder.path),
        path: folder.path,
        repositoryPath: folder.repositoryPath,
        name: folder.name,
        state: folder.state,
        isIsolated,
        mark: !folder.granted ? 'Not attached' : folder.state === 'plain' ? 'No repository' : null,
        actions: actionsOf(folder, input.hasCodebase, input.isInCodebase?.(folder.repositoryPath) ?? false, input.canOpenTerminal ?? false),
        tooltip: [folder.path, note].filter(Boolean).join(' · '),
      }
    })
}

/** What a folder row shows in its trailing slot: the fields of `ActionRowItem` with the same names. */
export interface EnvironmentFolderTrailing {
  badge: string | undefined
  /** Cut first when the rail is narrow. */
  badgePrefix: string | undefined
}

/**
 * The trailing slot of a folder row: its state mark, and the host of the
 * run, as the project row marks it (a glyph for this machine, the name for a
 * different one). With a mark on a different host, the host is the prefix,
 * which `MenuRow` cuts first when the rail is narrow.
 */
export function environmentFolderTrailing(row: Pick<EnvironmentFolderRow, 'mark'>, host: { label: string | undefined; isLocal: boolean }): EnvironmentFolderTrailing {
  const hostLabel = host.isLocal ? undefined : host.label
  if (!row.mark) return { badge: hostLabel, badgePrefix: undefined }
  // The no-break space stays at the end of the prefix: the row joins the two parts with nothing between them.
  return { badge: row.mark, badgePrefix: hostLabel ? `${hostLabel} · ` : undefined }
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
