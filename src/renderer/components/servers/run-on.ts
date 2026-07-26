import { serverConnections } from '@client-core/server-connections'
import { rememberRunOnHost } from '@client-core/run-on-preferences'
import { LOCAL_SERVER_ID } from '@client-core/server-registry'
import type { IpcContext, ProjectIdentity, Session } from '../../../shared/types'

/** Exactly what retargeting a tab's host needs from the workspace context. */
export interface RunOnWorkspace {
  tabOrder: string[]
  sessionFor(tabId: string): Session | undefined
  ctxFor(tabId: string): IpcContext
  apiFor(tabId: string): { closeTab(ctx: IpcContext): Promise<void> }
}

export interface RetargetSessionHostOptions {
  workspace: RunOnWorkspace
  tabId: string
  serverId: string
  isLocalHost: boolean
  /** The working directory on the new host; omitted keeps whatever the session had. */
  path?: string
  /** Remembered so the next session in this repo defaults to the same host. */
  repoKey?: string | null
  /**
   * Runs only when the session actually changed hosts, with the directory it
   * landed in. A dispatch always earns a session worktree — a base checkout on a
   * host nobody is watching is shared state with no one there to untangle a
   * collision — and the branch to cut from can only be read on the target.
   */
  onDispatched?: (path: string) => void
}

export type RetargetSessionHostResult =
  | { ok: true }
  /** The tab is gone, or was never a session. */
  | { ok: false; reason: 'no-session' }
  /** Nothing on the target names a directory the session could run in. */
  | { ok: false; reason: 'no-path-on-host' }

/**
 * Moves an unstarted tab to another host. The old host's runtime tab is closed
 * first, and its connection is only released once no other tab still needs it.
 *
 * A move between hosts must carry the directory to run in: the current one is a
 * path on the *old* host, and keeping it would start the session somewhere that
 * doesn't exist on the target. Staying put keeps whatever the session had.
 */
export function retargetSessionHost(opts: RetargetSessionHostOptions): RetargetSessionHostResult {
  const { workspace, tabId, serverId, isLocalHost, path, repoKey, onDispatched } = opts
  const session = workspace.sessionFor(tabId)
  if (!session) return { ok: false, reason: 'no-session' }

  const previousServerId = session.serverId
  const movingHosts = previousServerId !== serverId
  if (movingHosts && !path) return { ok: false, reason: 'no-path-on-host' }
  if (movingHosts) {
    void workspace.apiFor(tabId).closeTab(workspace.ctxFor(tabId)).catch(() => {})
  }
  rememberRunOnHost(repoKey ?? null, serverId)
  serverConnections.retain(serverId)
  if (!isLocalHost) serverConnections.ensure(serverId)
  session.serverId = serverId
  if (path) session.workingDirectory = path

  if (!movingHosts) return { ok: true }
  // The old host's checkout describes a filesystem this session no longer runs
  // on, so it is dropped rather than carried across and re-read as truth.
  session.gitContext = null
  session.worktreeBaseBranch = null
  onDispatched?.(path!)
  const stillInUse = workspace.tabOrder.some(
    (id) => id !== tabId && workspace.sessionFor(id)?.serverId === previousServerId,
  )
  if (stillInUse) return { ok: true }
  serverConnections.unretain(previousServerId)
  serverConnections.release(previousServerId)
  return { ok: true }
}

/**
 * True once a session runs somewhere other than the host you're using. Dispatch
 * carries the repository, not the working tree, so such a session always works
 * in its own worktree — the per-session toggle no longer applies to it.
 */
export function isDispatchedSession(session: Session | undefined): boolean {
  return !!session && session.serverId !== LOCAL_SERVER_ID
}

export function isRunOnHostLocked(session: Session | undefined): boolean {
  if (!session) return true
  return session.agentSessionId !== null || session.messages.length > 0 || session.status !== 'idle'
}

export function repoKeyForPath(identities: ProjectIdentity[], path: string | null | undefined): string | null {
  if (!path || path === '~') return null
  return identities.find((identity) => identity.path === path)?.repoKey ?? null
}

export function checkoutForRepo(identities: ProjectIdentity[], repoKey: string | null): ProjectIdentity | null {
  if (!repoKey) return null
  const normalizedRepoKey = repoKey.toLowerCase()
  return identities.find((identity) => identity.repoKey.toLowerCase() === normalizedRepoKey) ?? null
}
