import type { CodebaseMemberState, SessionFolder } from '@solus/contracts/codebases'
import { hostPathKey, isInsideHostPath, sameHostPath } from '@solus/contracts/host-path'
import type { GitState } from '@solus/contracts/types'
import type { CodebaseHostMembers, CodebaseHostPresence } from '../../../contexts/codebases/codebases.store.svelte'
import { changesRow } from './changes-row'
import { repositoriesInFolder } from './git-setup'
import type { TreeAgentRow } from './rail-agents'

/**
 * The menu of the project row of the Environment card (docs/plans/codebases.md
 * §9, "Running session"). The card names the work on one row. The caret of
 * that row opens this menu, which has one section for each folder of the
 * session: the working folder, then each session folder, then the folders of
 * the codebase on other hosts. A session with one folder has one section with
 * no heading: the menu is then the menu of a session with one project. The
 * Git card has the Git state of each repository. Pure: the component reads the
 * stores and calls the hosts.
 */

export type EnvironmentFolderAction =
  | 'open-in-solus'
  | 'open-in-file-manager'
  | 'open-terminal'
  | 'attach'
  | 'detach'
  | 'add-to-codebase'
  | 'track-with-git'

export const ADD_FOLDER_LABEL = 'Add folder…'
export const NO_SESSION_NOTE = 'No session works here'
export const PLAIN_FOLDER_NOTE = 'This folder is not a repository, so it has no diff.'
export const OBSERVED_FOLDER_NOTE = 'The agent changed a file here, but the folder is not attached to the session. Attach it to give the agent the folder.'
const ISOLATED_NOTE = 'A worktree of this session: its changes stay out of the repository until they are merged.'
const OTHER_HOST_NOTE = 'A session changes only the folders on its own host.'

/** A child session of this session, as the Agents section lists it. */
export type ChildSessionRow = Extract<TreeAgentRow, { kind: 'session' }>

export type EnvironmentMenuItem =
  | { kind: 'action'; key: string; action: EnvironmentFolderAction; label: string }
  /** A child session that works in the folder, on its host. The item opens it. */
  | { kind: 'session'; key: string; session: ChildSessionRow; label: string }

export interface EnvironmentMenuHeading {
  name: string
  /** The name of the host of the folder, when this client knows it. */
  hostLabel: string | undefined
  /** The folder is on this machine: the heading shows a glyph in place of the name of the host. */
  isLocalHost: boolean
  /** The state of the folder in one or two words, or null for a repository that the session has, on a host that this client reaches. */
  state: string | null
}

export interface EnvironmentMenuSection {
  /** One key for every spelling of the path, on its host. */
  key: string
  place: 'working' | 'session' | 'other-host'
  /** Where the session works: the folder, or its worktree. */
  path: string
  /** The folder that `path` is a checkout of. */
  repositoryPath: string
  /** This client's id for the host of a folder on a different host, or null. */
  serverId: string | null
  heading: EnvironmentMenuHeading
  /** One line for the tooltip of the heading. */
  tooltip: string
  items: EnvironmentMenuItem[]
  /** What a section with no item says in their place. */
  emptyNote: string | null
}

export interface EnvironmentMenu {
  sections: EnvironmentMenuSection[]
  /** False for a session with one folder: the menu has no heading, as before a session had more than one folder. */
  showsHeadings: boolean
  /** The last item of the menu, or null when this person cannot add a folder. */
  addFolderLabel: string | null
}

export interface EnvironmentMenuInput {
  working: {
    /** The working place of the run. */
    path: string
    /** The name of the project folder. */
    name: string
    /** Null while the host has not said whether the folder is a repository. */
    state: 'git' | 'plain' | null
  }
  /** The session folders of a started session. Empty for a draft. */
  folders: readonly SessionFolder[]
  /** The members of the codebase of a draft on the run host. A started session has its session folders. */
  draftMembers?: readonly { path: string; state: CodebaseMemberState }[]
  /** The folders of the codebase on the hosts that the session does not run on (`otherHostFolders`). */
  otherHosts: readonly OtherHostFolders[]
  /** The host of the run. */
  host: { label: string | undefined; isLocal: boolean }
  /** The name of the codebase of the session, or null: a folder that is not in it can be added. */
  codebaseName: string | null
  /** True for a folder that the codebase of the session holds on this host now. The list of the host can be older: it is read at a turn start. */
  isInCodebase?(repositoryPath: string): boolean
  /** How the host names its file manager ("Finder"), or null when this client cannot open it. */
  fileManagerName: string | null
  /** This client can open a terminal on the run host: the desktop app, on its own machine. */
  canOpenTerminal: boolean
  /** This person can add a folder to the session. */
  canAddFolder: boolean
}

const ACTION_LABEL = {
  'open-in-solus': 'Open in Solus',
  'open-terminal': 'Open terminal',
  attach: 'Attach to this session',
  detach: 'Detach from this session',
  'track-with-git': 'Track with Git',
} satisfies Record<Exclude<EnvironmentFolderAction, 'open-in-file-manager' | 'add-to-codebase'>, string>

/** The items of a folder on the run host: the two places that show it, then its options. */
function actionItems(folderKey: string, actions: readonly EnvironmentFolderAction[], input: Pick<EnvironmentMenuInput, 'fileManagerName' | 'codebaseName'>): EnvironmentMenuItem[] {
  const items: EnvironmentMenuItem[] = []
  for (const action of actions) {
    const label =
      action === 'open-in-file-manager' ? (input.fileManagerName ? `Open in ${input.fileManagerName}` : null)
      : action === 'add-to-codebase' ? (input.codebaseName ? `Add to ${input.codebaseName}` : null)
      : ACTION_LABEL[action]
    if (label) items.push({ kind: 'action', key: `${action}:${folderKey}`, action, label })
  }
  return items
}

function sessionFolderActions(folder: SessionFolder, input: EnvironmentMenuInput): EnvironmentFolderAction[] {
  const actions: EnvironmentFolderAction[] = ['open-in-solus', 'open-in-file-manager']
  if (input.canOpenTerminal) actions.push('open-terminal')
  if (!folder.granted) actions.push('attach')
  // The host refuses to detach a folder of the codebase, and an observed folder is not attached.
  if (folder.granted && (folder.source === 'attached' || folder.source === 'created')) actions.push('detach')
  if (folder.source !== 'codebase' && !input.isInCodebase?.(folder.repositoryPath)) actions.push('add-to-codebase')
  if (folder.state === 'plain') actions.push('track-with-git')
  return actions
}

/** `hasOtherFolders`: the menu has more than this section, so this one has each option that the others have. */
function workingSection(input: EnvironmentMenuInput, hasOtherFolders: boolean): EnvironmentMenuSection {
  const { working } = input
  const key = hostPathKey(working.path)
  const actions: EnvironmentFolderAction[] = ['open-in-solus', 'open-in-file-manager']
  // A session with one folder has the menu of a session with one project: the
  // row "Open in" of the card opens its terminal. With more folders, each
  // section has the same options, so the working folder has its terminal here also.
  if (hasOtherFolders && input.canOpenTerminal) actions.push('open-terminal')
  // A folder with no repository that holds repositories: the Git card lists
  // them, so the way to make the folder itself a repository is here. With no
  // repository inside, the Git card has "Initialize Git".
  if (working.state !== 'git' && repositoriesInFolder(working.path, input.folders, input.draftMembers ?? []) > 0) actions.push('track-with-git')
  return {
    key,
    place: 'working',
    path: working.path,
    repositoryPath: working.path,
    serverId: null,
    heading: { name: working.name, hostLabel: input.host.label, isLocalHost: input.host.isLocal, state: working.state === 'plain' ? 'No repository' : null },
    tooltip: [working.path, 'The working folder of this session', working.state === 'plain' ? PLAIN_FOLDER_NOTE : null].filter(Boolean).join(' · '),
    items: actionItems(key, actions, input),
    emptyNote: null,
  }
}

function sessionFolderSection(folder: SessionFolder, input: EnvironmentMenuInput): EnvironmentMenuSection {
  const key = hostPathKey(folder.path)
  const isIsolated = !sameHostPath(folder.path, folder.repositoryPath)
  const note = !folder.granted ? OBSERVED_FOLDER_NOTE : folder.state === 'plain' ? PLAIN_FOLDER_NOTE : isIsolated ? ISOLATED_NOTE : null
  return {
    key,
    place: 'session',
    path: folder.path,
    repositoryPath: folder.repositoryPath,
    serverId: null,
    heading: {
      name: folder.name,
      hostLabel: input.host.label,
      isLocalHost: input.host.isLocal,
      state: !folder.granted ? 'Not attached' : folder.state === 'plain' ? 'No repository' : null,
    },
    tooltip: [folder.path, note].filter(Boolean).join(' · '),
    items: actionItems(key, sessionFolderActions(folder, input), input),
    emptyNote: null,
  }
}

const MEMBER_STATE_NOTE = { git: null, plain: 'No repository', missing: 'Missing' } satisfies Record<CodebaseMemberState, string | null>

/**
 * One section for each folder of the codebase on a different host. A child
 * session is an item of the folder that holds its working directory. A child
 * that works in none of them (a worktree is outside its repository) is an
 * item of the first folder of its host, so each child shows one time.
 */
function otherHostSections(host: OtherHostFolders): EnvironmentMenuSection[] {
  return host.roots.map((root, index): EnvironmentMenuSection => {
    const sessions = host.sessions.filter((child) => {
      const holder = host.roots.findIndex((each) => isInsideHostPath(each.path, child.cwd))
      return (holder === -1 ? 0 : holder) === index
    })
    return {
      key: `${host.installationId}\n${hostPathKey(root.path)}`,
      place: 'other-host',
      path: root.path,
      repositoryPath: root.path,
      serverId: host.serverId,
      heading: { name: root.name, hostLabel: host.label, isLocalHost: host.isLocal, state: host.presenceNote ?? (root.state ? MEMBER_STATE_NOTE[root.state] : null) },
      tooltip: [root.path, OTHER_HOST_NOTE].join(' · '),
      items: sessions.map((child) => ({ kind: 'session', key: child.key, session: child, label: child.title })),
      emptyNote: sessions.length === 0 ? NO_SESSION_NOTE : null,
    }
  })
}

/**
 * The menu of the project row: the working folder first, then each session
 * folder in the order of the host, then the folders on other hosts. Each
 * section of the run host has the two places that show its folder ("Open in
 * Solus", and the file manager of the host where this client can open it),
 * then the options of that folder. "Add folder…" is the last item.
 */
export function environmentMenu(input: EnvironmentMenuInput): EnvironmentMenu {
  const others = [
    // The host never lists the working directory as a session folder; an old list can.
    ...input.folders.filter((folder) => !sameHostPath(folder.path, input.working.path)).map((folder) => sessionFolderSection(folder, input)),
    ...input.otherHosts.flatMap(otherHostSections),
  ]
  const sections = [workingSection(input, others.length > 0), ...others]
  return { sections, showsHeadings: sections.length > 1, addFolderLabel: input.canAddFolder ? ADD_FOLDER_LABEL : null }
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
  /** The host is this machine: a session on a different host has a codebase with a folder here. */
  isLocal: boolean
  presence: CodebaseHostPresence
  /** One or two words for the presence, or null for a host that is ready. */
  presenceNote: string | null
  roots: OtherHostRoot[]
  /** The child sessions of this session that run on the host. */
  sessions: ChildSessionRow[]
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
  isLocalHost: (serverId: string) => boolean = () => false,
): OtherHostFolders[] {
  const sessions = childRows.filter((row): row is ChildSessionRow => row.kind === 'session')
  return groups
    .filter((group) => group.serverId !== runServerId)
    .map((group) => ({
      installationId: group.installationId,
      serverId: group.serverId,
      label: group.label ?? 'Unknown host',
      isLocal: !!group.serverId && isLocalHost(group.serverId),
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
