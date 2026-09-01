import { serverConnections } from '@solus/client-core/server-connections'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { worktreeProjectRoot, type GithubDelegatedCredential, type IpcContext, type PendingHostDispatch, type ProjectIdentity, type RunConfig, type Session } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import { hasSessionStarted } from '../../lib/sessionUtils'
import {
  startsWorktree,
  withHost,
  withPendingHost,
  withProjectHost,
  withWorktreeToggled,
} from '../../contexts/workspace/run-config'

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
  serverId: string
  isLocalHost: boolean
  /** The working directory on the new host; omitted keeps whatever the session had. */
  path?: string
  /** Stable repository identity used to preserve sidebar grouping across hosts. */
  repoKey?: string | null
  /**
   * Which of the two moves this is. `dispatch` sends the session to another
   * machine and leaves the project — and its tasks — where they are.
   * `open-project` says the project itself lives on that machine, so its tasks
   * are minted there and worktree mode stays the user's choice.
   */
  intent: 'dispatch' | 'open-project'
}

export type MoveTabToHostResult =
  | { ok: true; refreshStartTarget?: Promise<void> }
  /** The tab is gone, or was never a session. */
  | { ok: false; reason: 'no-session' }
  /** Nothing on the target names a directory the session could run in. */
  | { ok: false; reason: 'no-path-on-host' }

/**
 * Point a tab at another host, before anything has started on it.
 *
 * A *session* never moves between machines — it is created on the host it will
 * live on and stays there. What moves is the tab: its speculative registration
 * on the previously-chosen host is closed, and that host's connection is
 * released once no other tab still needs it. Every caller is therefore
 * pre-start, which is what `isRunOnHostLocked` enforces at the picker.
 *
 * A move must carry the directory to run in: the current one is a path on the
 * *old* machine, and keeping it would start the session somewhere that does not
 * exist on the target. Staying put keeps whatever the run already had.
 */
export function moveTabToHost(opts: MoveTabToHostOptions): MoveTabToHostResult {
  const { workspace, tabId, serverId, isLocalHost, path, repoKey, intent } = opts
  const session = workspace.sessionFor(tabId)
  if (!session) return { ok: false, reason: 'no-session' }

  const previousServerId = session.run.serverId
  const movingHosts = previousServerId !== serverId
  if (movingHosts && !path) return { ok: false, reason: 'no-path-on-host' }
  const selectedDispatchWorktree = intent === 'dispatch'
    && session.run.pendingHostDispatch?.intent === 'dispatch'
    ? session.run.pendingHostDispatch.worktree
    : undefined
  const selectedDispatchBaseBranch = intent === 'dispatch'
    && session.run.pendingHostDispatch?.intent === 'dispatch'
    ? session.run.pendingHostDispatch.baseBranch
    : undefined
  const sourceProjectPath = session.run.projectGroupPath
    ?? session.run.gitContext?.repoRoot
    ?? session.run.workingDirectory
  if (movingHosts) {
    // The session is leaving this host, so stop listening to it there.
    void workspace.apiFor(tabId).unwatchSession(session.id).catch(() => {})
  }
  serverConnections.retain(serverId)
  if (!isLocalHost) serverConnections.ensure(serverId)
  session.run = intent === 'dispatch'
    ? withHost(session.run, serverId, { path })
    : withProjectHost(session.run, serverId, { path })
  if (intent === 'open-project') session.task = { kind: 'new' }
  const selectedDispatchBranch = selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch
  if (selectedDispatchBranch && path) {
    // Preserve the selected path as a worktree while the target host resolves
    // its full Git identity. Without this provisional context the refresh would
    // treat the exact worktree path as a plain branch checkout.
    session.run.gitContext = {
      repoRoot: worktreeProjectRoot(path),
      branch: selectedDispatchBranch,
      targetBranch: selectedDispatchBranch,
      worktreePath: path,
    }
    session.run.worktree = null
  }

  if (!movingHosts) return { ok: true }
  if (repoKey && sourceProjectPath && sourceProjectPath !== '~') {
    session.run.projectGroupPath = sourceProjectPath
  }
  const refreshed = workspace.refreshStartTarget(tabId, path!, startsWorktree(session.run))
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

export function isRunOnHostLocked(session: Session | undefined): boolean {
  // A tab with no session at all has no host to move, so it is locked too.
  return !session || hasSessionStarted(session)
}

export interface RunOnPickerVisibility {
  variant: 'chip' | 'header'
  /** True when the run sits in (or on the way into) a git checkout. */
  isGitRepo: boolean
  /** Remotes reachable right now — a saved-but-offline host does not count, so
   *  the picker only appears when there is a real machine to run on. */
  connectedRemoteCount: number
  /** True when the selected host resolves to a remote machine. */
  onRemoteHost: boolean
  /** The host the run will start on, remembered even for a forgotten remote. */
  selectedHostId: string | null | undefined
}

/**
 * Whether the run-on picker is worth showing at all.
 *
 * It earns its place the moment there is a real choice about where work runs:
 * a reachable remote to send it to, or a git checkout the header can branch a
 * worktree from. A plain local folder on a single machine has neither, so the
 * picker stays out of the way until a host is connected.
 */
export function shouldShowRunOnPicker(input: RunOnPickerVisibility): boolean {
  // The header is the only control for worktree mode, so a git checkout always
  // earns it — even on a machine that has never seen another host.
  if (input.variant === 'header' && input.isGitRepo) return true
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

/** The combined menu has one selected destination row. A remote host owns that
 * selection, so its default new-worktree shape must not add a second check. */
export function isNewWorktreeStartSelected(onRemoteHost: boolean, startsNewWorktree: boolean): boolean {
  return !onRemoteHost && startsNewWorktree
}

/** Explains why this checkout cannot create a worktree. */
export function worktreeBlockedReason(canToggleWorktree: boolean): string | null {
  if (canToggleWorktree) return null
  return 'This checkout has no base branch to create a worktree from.'
}

/**
 * Whether picking `serverId` returns a dispatched run to the host its project
 * already lives on — the reverse of a dispatch.
 *
 * A dispatch runs the agent on one host while the project (and its tasks) stay
 * on `taskServerId`; that home host still holds the real checkout, remembered as
 * `projectGroupPath`. Selecting it again is therefore a plain re-home: no clone,
 * and no project to pick, because the checkout is already there. Every other host
 * is a genuine move — a dispatch to it, or opening a folder on it — so this stays
 * false for them, and for a run already on its own home host.
 */
export function returnsToProjectHome(run: RunConfig, serverId: string): boolean {
  return run.serverId !== serverId && run.taskServerId === serverId && !!run.projectGroupPath
}

/**
 * Apply one of the local checkout rows in the Run on picker.
 *
 * Returning from another host and choosing the checkout shape are one user
 * action. Build both changes from the same run so the first click cannot stop
 * after the host move and leave "New worktree" selected.
 */
export function withLocalStart(
  run: RunConfig,
  localServerId: string,
  fallbackPath: string,
  worktree: boolean,
): RunConfig {
  let next = withPendingHost(run, null)
  if (run.serverId !== localServerId) {
    next = withProjectHost(next, localServerId, {
      path: run.projectGroupPath ?? fallbackPath,
    })
    next.projectGroupPath = null
  }
  if (startsWorktree(next) !== worktree) next = withWorktreeToggled(next)
  return next
}

/**
 * Queue a repository dispatch and select a fresh worktree by default.
 *
 * Selecting an existing target worktree later changes this from creation to
 * reuse, but the dispatched session remains isolated in either case.
 */
export function withRemoteDispatch(
  run: RunConfig,
  target: Extract<PendingHostDispatch, { intent: 'dispatch' }>,
): RunConfig {
  const next = withPendingHost(run, target)
  return startsWorktree(next) ? next : withWorktreeToggled(next)
}

/**
 * The host whose recent projects the project chip should list — where the run's
 * project *lives*, which is not always where it *runs*.
 *
 * The run-on picker chooses the run host and records the choice as a pending
 * dispatch; the project chip reads this back to know whose projects to offer:
 *
 * - **open-project** — the pending choice is "work on a project that lives over
 *   there", so the project host is that target host, before Send moves either id.
 * - **dispatch** — the agent runs elsewhere but the project (and its tasks) stay
 *   home, so the project host is `taskServerId`, and the chip keeps listing the
 *   local checkout being dispatched.
 * - **no pending choice** — the run already sits on its project host, named by
 *   `taskServerId` (a remote-owned project) or, failing that, `serverId`.
 */
export function projectHostId(run: RunConfig): string {
  if (run.pendingHostDispatch?.intent === 'open-project') return run.pendingHostDispatch.serverId
  return run.taskServerId ?? run.serverId
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
