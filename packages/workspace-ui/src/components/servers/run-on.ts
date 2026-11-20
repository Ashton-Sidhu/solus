import { serverConnections } from '@solus/client-core/server-connections'
import { LOCAL_SERVER_ID } from '@solus/client-core/known-host'
import { isSessionBusyStatus, type CloneCheckout, type CopiedProjectFile, type DispatchRepository, type GithubDelegatedCredential, type IpcContext, type ProjectIdentity, type RunConfig, type RunLocation, type Session } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import { hasSessionStarted } from '../../lib/sessionUtils'
import { pendingClone, projectHome, runHost, startsWorktree, workingPlace } from '../../contexts/workspace/run-location'

/** Exactly what moving a tab to another host needs from the workspace context. */
export interface RunOnWorkspace {
  tabOrder: string[]
  sessionFor(tabId: string): Session | undefined
  ctxFor(tabId: string): IpcContext
  apiFor(tabId: string): Pick<SolusAPI, 'unwatchSession' | 'watchSession'>
  refreshStartTarget(tabId: string, path: string, worktree: boolean): void | Promise<void>
}

export interface MoveTabToHostOptions {
  workspace: RunOnWorkspace
  tabId: string
  /** Where the tab's run works next. Its host may be the one it is on. */
  location: RunLocation
}

/**
 * Point a tab's run somewhere new: before its first send, or between turns of
 * a started session (docs/plans/portable-sessions.md §10).
 *
 * No host owns a session; the run host changes. The tab stops listening on
 * the host it leaves, and that host's connection is released once no other
 * tab still needs it. A started session is watched on the new host at once,
 * so the sync card and the next turn's events reach this tab. A pending fork
 * has no session there yet; its first prompt watches it. `isRunOnHostLocked`
 * keeps the host while a turn runs.
 *
 * Resolves with the Git read of the new folder when the host changed, so Send
 * can wait for the checkout it is about to start in.
 */
export function moveTabToHost(opts: MoveTabToHostOptions): { ok: true; refreshStartTarget?: Promise<void> } | { ok: false } {
  const { workspace, tabId, location } = opts
  const session = workspace.sessionFor(tabId)
  if (!session) return { ok: false }

  const previousServerId = runHost(session.run)
  const serverId = runHost({ location })
  const movingHosts = previousServerId !== serverId
  if (movingHosts) {
    // The session is leaving this host, so stop listening to it there.
    void workspace.apiFor(tabId).unwatchSession(session.id).catch(() => {})
  }
  serverConnections.retain(serverId)
  if (serverId !== serverConnections.localServerId()) serverConnections.ensure(serverId)
  session.run.location = location

  if (!movingHosts) return { ok: true }
  if (hasSessionStarted(session) && !session.forked) {
    void workspace.apiFor(tabId).watchSession({ sessionId: session.id }).catch(() => {})
  }
  const refreshed = workspace.refreshStartTarget(tabId, workingPlace(session.run).path, startsWorktree(session.run))
  const refreshStartTarget = refreshed instanceof Promise ? refreshed : undefined
  const stillInUse = workspace.tabOrder.some(
    (id) => id !== tabId && runHost(workspace.sessionFor(id)?.run) === previousServerId,
  )
  if (!stillInUse) {
    serverConnections.unretain(previousServerId)
    serverConnections.release(previousServerId)
  }
  return refreshStartTarget ? { ok: true, refreshStartTarget } : { ok: true }
}

/**
 * Whether Run on keeps the tab's host. A started session can change its run
 * host between turns (plan §10); while a turn runs, or a sent prompt still
 * waits for its host, every prompt goes to the host that runs it (§4 decision 5).
 */
export function isRunOnHostLocked(session: Pick<Session, 'status' | 'outboundPrompts' | 'readOnlyReason'> | undefined): boolean {
  // A tab with no session at all has no host to move, so it is locked too.
  if (!session) return true
  return isSessionBusyStatus(session.status)
    || session.status === 'background'
    || (session.outboundPrompts?.length ?? 0) > 0
    || !!session.readOnlyReason
}

export interface RunOnPickerVisibility {
  /** Reachable execution hosts other than the client's own machine. */
  connectedRemoteIds: readonly string[]
  /** The client's own execution host; null on web. */
  localHostId: string | null
  /** The host the run will start on, remembered even for a forgotten remote. */
  selectedHostId: string | null | undefined
}

/** Show a host choice only when there is another machine to run on. */
export function shouldShowRunOnPicker(input: RunOnPickerVisibility): boolean {
  if (input.connectedRemoteIds.some((hostId) => hostId !== input.selectedHostId)) return true
  // Desktop can return to its own machine, including from a forgotten host.
  // Web has no local machine: its sole connected host is not an extra choice.
  return !!input.localHostId && !!input.selectedHostId && input.selectedHostId !== input.localHostId
}

/** Explains why this checkout cannot create a worktree. */
export function worktreeBlockedReason(canToggleWorktree: boolean): string | null {
  if (canToggleWorktree) return null
  return 'This checkout has no base branch to create a worktree from.'
}

export function repoKeyForPath(identities: ProjectIdentity[], path: string | null | undefined): string | null {
  if (!path || path === '~') return null
  return identities.find((identity) => identity.path === path)?.repoKey ?? null
}

/** Turns the normalized repository identity into a credential-free clone URL. */
export function cloneUrlForRepoKey(repoKey: string): string | null {
  const [host, ...repoPath] = repoKey.split('/').filter(Boolean)
  if (!host || repoPath.length < 2) return null
  return `https://${host}/${repoPath.join('/')}.git`
}

/**
 * What the run host copies before a clone run starts (docs/run-on.md), or null
 * when the repository has no remote to clone. The credential is added at Send.
 */
export function dispatchRepository(clone: CloneCheckout): DispatchRepository | null {
  const cloneUrl = cloneUrlForRepoKey(clone.repoKey)
  if (!cloneUrl) return null
  const { start } = clone
  if (start.kind === 'worktree') return { cloneUrl, worktreePath: start.path }
  // A new worktree starts from the chosen branch, else from the host's default
  // branch. A run on the default branch works in the checkout itself.
  if (start.kind === 'new-worktree') return start.baseBranch ? { cloneUrl, newWorktree: true, baseBranch: start.baseBranch } : { cloneUrl, newWorktree: true }
  return clone.defaultBranch ? { cloneUrl, baseBranch: clone.defaultBranch } : { cloneUrl }
}

/**
 * The repository a host needs to sync a started session when it has no
 * checkout of the project (plan §19, Part D): the one a Run on send builds,
 * with the client's GitHub credential and the copied files. A clone run
 * names it; a folder run names it by the project's repository key. Undefined
 * for a chat or a project with no remote.
 */
export async function syncRepository(
  run: Pick<RunConfig, 'location'>,
  repoKey: string | null,
): Promise<DispatchRepository | undefined> {
  const clone = pendingClone(run)
  const cloneUrl = !clone && repoKey ? cloneUrlForRepoKey(repoKey) : null
  const repository = clone ? dispatchRepository(clone) : cloneUrl ? { cloneUrl } : null
  if (!repository) return undefined
  const [credential, files] = await Promise.all([
    delegatedGithubCredential(runHost(run)),
    copiedProjectFiles(run),
  ])
  if (credential) repository.credential = credential
  if (files.length > 0) repository.files = files
  return repository
}

/**
 * The files a clone gets from the project's home checkout: what its
 * `.worktreeinclude` names (docs/run-on.md#copied-files). The two hosts never
 * talk to each other, so the client carries them. When the home host cannot
 * answer, the send goes without them.
 */
export async function copiedProjectFiles(
  run: Pick<Session['run'], 'location'>,
  apiFor: (serverId: string) => Pick<SolusAPI, 'readWorktreeIncludedFiles'> = (serverId) => serverConnections.apiFor(serverId),
): Promise<CopiedProjectFile[]> {
  const home = projectHome(run)
  if (home.path === '~') return []
  try {
    return await apiFor(home.serverId).readWorktreeIncludedFiles(home.path)
  } catch (error) {
    console.warn('[Solus] Reading the .worktreeinclude files failed; the clone gets none.', error)
    return []
  }
}

/**
 * The client machine's GitHub credential, lent to the run host so a clone there
 * clones, fetches, and pushes as the person who sent it. A web client has no
 * machine (and no credential store) of its own, and a send to this machine
 * needs none, so the run host then uses its own token.
 */
export async function delegatedGithubCredential(
  serverId: string,
  local: Pick<SolusAPI, 'githubExportCredential'> = serverConnections.apiFor(LOCAL_SERVER_ID),
): Promise<GithubDelegatedCredential | undefined> {
  const clientMachineServerId = serverConnections.localServerId()
  if (!clientMachineServerId || clientMachineServerId === serverId) return undefined
  try {
    return await local.githubExportCredential()
  } catch (error) {
    console.warn('[Solus] GitHub credential delegation failed; using the target host credential.', error)
    return undefined
  }
}
