import { serverConnections } from '@solus/client-core/server-connections'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import type { GithubDelegatedCredential, IpcContext, ProjectIdentity, RunLocation, Session } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import { hasSessionStarted } from '../../lib/sessionUtils'
import { runHost, startsWorktree, workingPlace } from '../../contexts/workspace/run-location'

/** Exactly what moving a tab to another host needs from the workspace context. */
export interface RunOnWorkspace {
  tabOrder: string[]
  sessionFor(tabId: string): Session | undefined
  ctxFor(tabId: string): IpcContext
  apiFor(tabId: string): { unwatchSession(sessionId: string): Promise<void> }
  refreshStartTarget(tabId: string, path: string, worktree: boolean): void | Promise<void>
}

export interface MoveTabToHostOptions {
  workspace: RunOnWorkspace
  tabId: string
  /** Where the tab's run works next. Its host may be the one it is on. */
  location: RunLocation
}

/**
 * Point a tab's run somewhere new, before anything has started on it.
 *
 * A *session* never moves between machines — it is created on the host it will
 * live on and stays there. What moves is the tab: its speculative registration
 * on the previously-chosen host is closed, and that host's connection is
 * released once no other tab still needs it. Every caller is therefore
 * pre-start, which is what `isRunOnHostLocked` enforces at the picker.
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

export function isRunOnHostLocked(session: Session | undefined): boolean {
  // A tab with no session at all has no host to move, so it is locked too.
  return !session || hasSessionStarted(session)
}

export interface RunOnPickerVisibility {
  /** Remotes reachable right now — a saved-but-offline host does not count, so
   *  the picker only appears when there is a real machine to run on. */
  connectedRemoteCount: number
  /** True when the selected host resolves to a remote machine. */
  onRemoteHost: boolean
  /** The host the run will start on, remembered even for a forgotten remote. */
  selectedHostId: string | null | undefined
}

/**
 * Whether the run-on picker is worth showing at all: only when there is a real
 * choice about which machine runs the work. The checkout type is the branch
 * chip's question, so one machine never shows this picker.
 */
export function shouldShowRunOnPicker(input: RunOnPickerVisibility): boolean {
  // A reachable remote is a genuine choice: run here, or run on that machine.
  // Saved-but-offline hosts are filtered out before they reach this count.
  if (input.connectedRemoteCount > 0) return true
  // A session already living on a remote host names it, so the badge never
  // silently reads as local — true even after that host has been forgotten.
  return (
    input.onRemoteHost ||
    (!!input.selectedHostId && input.selectedHostId !== LOCAL_SERVER_ID)
  )
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

export interface PreparedHostCheckout {
  path: string
  action: 'updated' | 'cloned'
}

/** Turns the normalized repository identity into a credential-free clone URL. */
export function cloneUrlForRepoKey(repoKey: string): string | null {
  const [host, ...repoPath] = repoKey.split('/').filter(Boolean)
  if (!host || repoPath.length < 2) return null
  return `https://${host}/${repoPath.join('/')}.git`
}

/**
 * Makes the selected host ready before the tab moves: a known checkout is
 * fast-forwarded, while a missing checkout is cloned under that host's projects
 * root. The caller moves the tab only after this resolves, so a failed preparation
 * can never send the prompt to a stale or half-created directory.
 */
export async function prepareHostCheckout(
  apis: {
    target: Pick<SolusAPI, 'setupPrepareProject'>
    local: Pick<SolusAPI, 'githubExportCredential'>
  },
  serverId: string,
  repoKey: string,
  worktreePath?: string,
  baseBranch?: string,
): Promise<PreparedHostCheckout> {
  const cloneUrl = cloneUrlForRepoKey(repoKey)
  if (!cloneUrl) throw new Error('This repository does not have a cloneable remote.')
  // Credential delegation carries the client machine's GitHub token to the
  // dispatch target. A web client has no machine (and no credential store) of
  // its own, so the target host uses its own token as before.
  const clientMachineServerId = serverConnections.localServerId()
  let credential: GithubDelegatedCredential | undefined
  if (clientMachineServerId && clientMachineServerId !== serverId) {
    try {
      credential = await apis.local.githubExportCredential()
    } catch (error) {
      console.warn('[Solus] GitHub credential delegation failed; using the target host credential.', error)
    }
  }
  const request = {
    cloneUrl,
  }
  if (credential) Object.assign(request, { credential })
  if (worktreePath) Object.assign(request, { worktreePath })
  if (baseBranch) Object.assign(request, { baseBranch })
  const result = await apis.target.setupPrepareProject(request)
  return { path: result.path, action: result.action }
}
