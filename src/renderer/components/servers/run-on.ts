import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID } from '@client-core/server-registry'
import type { GithubDelegatedCredential, IpcContext, PendingHostDispatch, ProjectIdentity, RunConfig, Session } from '../../../shared/types'
import type { SolusAPI } from '../../../preload'
import { hasSessionStarted } from '../../lib/sessionUtils'
import { withHost } from '../../contexts/workspace/run-config'

/** Exactly what retargeting a tab's host needs from the workspace context. */
export interface RunOnWorkspace {
  tabOrder: string[]
  sessionFor(tabId: string): Session | undefined
  ctxFor(tabId: string): IpcContext
  apiFor(tabId: string): { closeTab(ctx: IpcContext): Promise<void> }
  refreshStartTarget(tabId: string, path: string, worktree: boolean): void | Promise<void>
}

export interface RetargetSessionHostOptions {
  workspace: RunOnWorkspace
  tabId: string
  serverId: string
  isLocalHost: boolean
  /** The working directory on the new host; omitted keeps whatever the session had. */
  path?: string
  /** Stable repository identity used to preserve sidebar grouping across hosts. */
  repoKey?: string | null
  /** The Run on picker requires isolation; opening a project remotely does not. */
  requireWorktree?: boolean
}

export type RetargetSessionHostResult =
  | { ok: true; refreshStartTarget?: Promise<void> }
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
  const { workspace, tabId, serverId, isLocalHost, path, repoKey, requireWorktree = false } = opts
  const session = workspace.sessionFor(tabId)
  if (!session) return { ok: false, reason: 'no-session' }

  const previousServerId = session.run.serverId
  const movingHosts = previousServerId !== serverId
  if (movingHosts && !path) return { ok: false, reason: 'no-path-on-host' }
  const sourceProjectPath = session.projectGroupPath
    ?? session.run.gitContext?.repoRoot
    ?? session.run.workingDirectory
  if (movingHosts) {
    void workspace.apiFor(tabId).closeTab(workspace.ctxFor(tabId)).catch(() => {})
  }
  serverConnections.retain(serverId)
  if (!isLocalHost) serverConnections.ensure(serverId)
  session.run = withHost(session.run, serverId, { path, isLocalHost, requireWorktree })

  if (!movingHosts) return { ok: true }
  if (repoKey && sourceProjectPath && sourceProjectPath !== '~') {
    session.projectGroupPath = sourceProjectPath
  }
  const refreshed = workspace.refreshStartTarget(tabId, path!, requireWorktree)
  const refreshStartTarget = refreshed instanceof Promise ? refreshed : undefined
  const success = refreshStartTarget ? { ok: true as const, refreshStartTarget } : { ok: true as const }
  const stillInUse = workspace.tabOrder.some(
    (id) => id !== tabId && workspace.sessionFor(id)?.run.serverId === previousServerId,
  )
  if (stillInUse) return success
  serverConnections.unretain(previousServerId)
  serverConnections.release(previousServerId)
  return success
}

/**
 * True when this run was sent to another host through Run on, which requires
 * its own worktree. Merely opening a project that already lives remotely keeps
 * worktree mode optional, just as it is for a local project.
 *
 * Reads the run config rather than a session, so a draft answers it identically.
 */
export function isDispatchedRun(run: RunConfig | undefined | null): boolean {
  return run?.worktreeRequired === true
}

export function isRunOnHostLocked(session: Session | undefined): boolean {
  // A tab with no session at all has no host to move, so it is locked too.
  return !session || hasSessionStarted(session)
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

/** Records the picker choice without touching a connection or filesystem. */
export function queueSessionHostDispatch(
  session: Session,
  target: PendingHostDispatch,
): void {
  if (target.serverId === session.run.serverId) {
    session.run.pendingHostDispatch = null
    return
  }
  session.run.pendingHostDispatch = target
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
 * root. The caller retargets only after this resolves, so a failed preparation
 * can never send the prompt to a stale or half-created directory.
 */
export async function prepareHostCheckout(
  apis: {
    target: Pick<SolusAPI, 'setupPrepareProject'>
    local: Pick<SolusAPI, 'githubExportCredential'>
  },
  serverId: string,
  repoKey: string,
): Promise<PreparedHostCheckout> {
  const cloneUrl = cloneUrlForRepoKey(repoKey)
  if (!cloneUrl) throw new Error('This repository does not have a cloneable remote.')
  // A web client has no local credential store of its own: there, LOCAL_SERVER_ID
  // resolves onto the target itself, and the host uses its own token as before.
  let credential: GithubDelegatedCredential | undefined
  if (serverConnections.resolveId(LOCAL_SERVER_ID) !== serverId) {
    try {
      credential = await apis.local.githubExportCredential()
    } catch (error) {
      console.warn('[Solus] GitHub credential delegation failed; using the target host credential.', error)
    }
  }
  const result = await apis.target.setupPrepareProject({
    cloneUrl,
    ...(credential ? { credential } : {}),
  })
  return { path: result.path, action: result.action }
}
