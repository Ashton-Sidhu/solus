import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import type { SessionRuntime } from '../../execution/session-runtime'
import type { SessionOrchestrator } from '../../execution/orchestration/session-orchestrator'
import { activityLeases } from '../../execution/activity-leases'
import type { AgentId, AgentMetadata, IpcContext } from '@solus/contracts/types'
import { AGENT_BIN } from '@solus/contracts/types'
import { userKey } from '@solus/contracts/user'
import { findOnPath, getCliEnv, warmCliPath } from '../../cli-env'
import { createLogger } from '../../logger'
import { appVersion, solusDir } from '../../platform/paths'
import { warmFinder } from '../../files/file-finder'
import type { SolusServer } from '../server'
import type { HandlerCtx } from '../server'
import type { ShareManager } from '../../sharing/share-manager'
import { insightsAccountOf, type Actor } from '../../admission/actor'
import { admitTurnOrganization, mayAnswerFor, type DelegationPort } from '../../execution/sessions/turn-organization'
import type { HostOrganizations } from '../../host/organizations'
import { isOrganizationSpace, type Principal } from '../../admission/principal'
import { WorkingTreeBusyError } from '../../execution/sessions/working-tree-busy'
import { chatFolderFor, projectsRootFor, resolveUnknownFolder } from './setup-handlers'
import { isChatFolder } from '../../workspace'
import { recordingRetention } from '../../browser/recording-retention'

const log = createLogger('main', 'session-handlers')
const execFileAsync = promisify(execFile)

export interface SessionDeps {
  sessionRuntime: SessionRuntime
  /** Decides whether a conversation may answer a question another session asked. */
  orchestrator: Pick<SessionOrchestrator, 'mayAnswer'>
  agentIdFromContext(ctx?: IpcContext): AgentId
  /** Records who started a session; the first caller to name a new session owns it. */
  shares?: ShareManager
  /** This host's standing in its organizations (organization-scope §3.1, §6.1); absent on the Solus API. */
  hostOrganizations?: HostOrganizations
  /** The organization a session is reserved for by an active publication (§7). */
  reservedOrganization?: (sessionId: string) => string | null
  /** How this host acts for people in organizations (plans/010-standard-oauth.md); set once the link exists. */
  delegations?: DelegationPort
  /** Persists the organization attachment before organization work is admitted. */
  markAttached?: () => void
}

const _agentBinaryCache = new Map<AgentId, string | null>()

// Persisted alongside the in-memory cache so a fresh launch can skip the `which`
// probe (and the async-warmed PATH lookup) entirely when the last-known binary
// still exists on disk. A background re-probe still runs to self-heal moved/upgraded
// binaries without blocking the `start` RPC on it.
const SOLUS_DIR = solusDir()
const AGENT_BINARIES_FILE = join(SOLUS_DIR, 'agent-binaries.json')
type PersistedAgentBinaries = Partial<Record<AgentId, string | null>>
const persistedAgentBinariesSchema = z.object({
  'claude-code': z.string().nullable().optional(),
  codex: z.string().nullable().optional(),
  opencode: z.string().nullable().optional(),
}).strict()
let _persistedBinaries: PersistedAgentBinaries | null = null

function loadPersistedBinaries(): PersistedAgentBinaries {
  if (_persistedBinaries) return _persistedBinaries
  try {
    _persistedBinaries = persistedAgentBinariesSchema.parse(JSON.parse(readFileSync(AGENT_BINARIES_FILE, 'utf8')))
  } catch {
    _persistedBinaries = {}
  }
  return _persistedBinaries
}

function savePersistedBinaries(): void {
  try {
    mkdirSync(SOLUS_DIR, { recursive: true })
    writeFileSync(AGENT_BINARIES_FILE, JSON.stringify(_persistedBinaries ?? {}))
  } catch (err) {
    log.warn('agent_binaries_persist_failed', { error: String(err) })
  }
}

async function probeAgentBinary(agentId: AgentId): Promise<string | null> {
  const bin = AGENT_BIN[agentId]
  if (!bin) return null
  // Wait for the async PATH warmup instead of letting getCliEnv() fall back to
  // the synchronous login-shell probes, which would block the main process.
  const path = await warmCliPath()
  try {
    const { stdout } = await execFileAsync('which', [bin], { encoding: 'utf8', env: getCliEnv(), timeout: 3000 })
    const result = stdout.trim()
    if (result) {
      log.info('agent_binary_which_hit', { agentId, bin, result })
      return result
    }
    // `which` answered "found nothing" without failing — an installed binary has
    // been reported missing this way, so don't take its word for it.
    log.warn('agent_binary_which_empty', { agentId, bin, path })
  } catch (err) {
    log.warn('agent_binary_which_failed', { agentId, bin, path, error: String(err) })
  }
  const scanned = findOnPath(bin, path)
  log.info('agent_binary_path_scan', { agentId, bin, result: scanned ?? null })
  return scanned
}

async function resolveAgentBinary(agentId: AgentId): Promise<string | null> {
  const cached = _agentBinaryCache.get(agentId)
  if (cached !== undefined) {
    log.info('agent_binary_memory_cache_hit', { agentId, path: cached ?? null })
    return cached
  }

  const persisted = loadPersistedBinaries()
  const persistedPath = persisted[agentId]
  if (persistedPath && existsSync(persistedPath)) {
    _agentBinaryCache.set(agentId, persistedPath)
    log.info('agent_binary_persisted_cache_hit', { agentId, path: persistedPath })
    // Self-heal in the background: if the binary moved/upgraded, update the
    // cache and the persisted file for the next lookup/launch. A probe that
    // comes back empty is ignored — the path it would replace demonstrably
    // exists, so the probe is the thing that's wrong.
    void probeAgentBinary(agentId).then((fresh) => {
      if (fresh && fresh !== persistedPath) {
        _agentBinaryCache.set(agentId, fresh)
        persisted[agentId] = fresh
        savePersistedBinaries()
      }
    })
    return persistedPath
  }

  log.info('agent_binary_cache_miss', { agentId, persistedPath: persistedPath ?? null })
  const result = await probeAgentBinary(agentId)
  // Only a hit is remembered. A miss can be the probe's fault rather than the
  // agent's, and caching one strands every agent picker empty — with no way
  // back — for the rest of the app run; the next start() re-probes instead.
  if (result) {
    _agentBinaryCache.set(agentId, result)
    persisted[agentId] = result
    savePersistedBinaries()
  }
  return result
}

export async function enrichAgentMetadata(metadata: AgentMetadata): Promise<AgentMetadata> {
  const binaryPath = await resolveAgentBinary(metadata.id)
  return {
    ...metadata,
    available: !!binaryPath,
    binaryPath: binaryPath ?? undefined,
    unavailableReason: binaryPath ? undefined : `${AGENT_BIN[metadata.id]} binary not found`,
  }
}

export function registerSessionHandlers(server: SolusServer, deps: SessionDeps): void {
  const { sessionRuntime, agentIdFromContext } = deps

  /**
   * The organization model's part of admitting a turn (organization-scope §3,
   * §3.1, §6.1): assign an unassigned session once, refuse a personal machine an
   * organization does not allow, and name the verified account behind the turn.
   */
  const turnOrganizationDeps = (hostOrganizations: HostOrganizations) => ({
    hostOrganizations,
    reservedOrganization: deps.reservedOrganization,
    recordIdFor: (sessionId: string) => sessionRuntime.sessionTranscriptSource(sessionId)?.agentSessionId ?? null,
    delegations: deps.delegations,
    markAttached: deps.markAttached,
    adoptSession: (sessionId: string, organizationId: string, ownerUserId: string, options: { shareWithOrganization: boolean }) =>
      deps.shares?.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerUserId, options) ?? Promise.resolve(),
  })

  /** A new approval or answer needs the person's organization authority again (organization-vms §4). */
  const mayAnswer = async (askingSessionId: string, principal: Principal): Promise<boolean> => {
    if (!deps.hostOrganizations) return true
    const recordId = sessionRuntime.sessionTranscriptSource(askingSessionId)?.agentSessionId ?? askingSessionId
    const allowed = await mayAnswerFor(principal, askingSessionId, recordId, turnOrganizationDeps(deps.hostOrganizations))
    if (!allowed) log.info('answer_refused_authority_removed', { sessionId: askingSessionId, principal: principal.kind })
    return allowed
  }

  /** A prompt and a retry pass the same admission: the turn's organization, for the actor behind it. */
  const admitTurn = async (ctx: IpcContext, actor: Actor): Promise<void> => {
    if (!deps.hostOrganizations) return
    const organizationId = await admitTurnOrganization(ctx, actor, turnOrganizationDeps(deps.hostOrganizations))
    const account = insightsAccountOf(actor)
    log.info('turn_admitted', { sessionId: ctx.session.sessionId, organizationId, accountUserId: account ? userKey(account.id) : null, principal: actor.principal.kind })
  }

  server.register('start', async (_args, handlerCtx) => {
    log.info('rpc_start')
    // No seq-reset here: `start` runs only at boot, when the renderer is already
    // performing a full bootstrapRuntimeTabs (createTab + bindRuntimeSession per
    // tab). Pushing seq-reset would trigger a redundant resyncRuntime that races
    // that bootstrap — doubling the WS calls and flickering the "Syncing…" badge.
    // Genuine reconnect gaps are still covered by the WS resume protocol
    // (handleResume → seq-reset) in transports/websocket.ts.
    // Creates the caller's chat folder before any session points its cwd at it.
    const workspacePath = chatFolderFor(handlerCtx.principal)
    const agents = await Promise.all(
      sessionRuntime
        .getBackendIds()
        .map((id) => sessionRuntime.getMetadataFor(id))
        .filter((metadata): metadata is AgentMetadata => metadata !== undefined)
        .map(enrichAgentMetadata),
    )
    // A member's home on a shared host is their member folder (managed-hosts.md §3).
    const projectPath = projectsRootFor(handlerCtx.principal)
    const homePath = handlerCtx.principal.kind === 'org-member' ? projectPath : homedir()
    return { projectPath, homePath, workspacePath, version: appVersion(), agents }
  })

  function requireClientId(handlerCtx: HandlerCtx): string {
    if (!handlerCtx.clientId) throw new Error('Watching a session requires a connected client')
    return handlerCtx.clientId
  }

  /** A bare `~` in a session context is the caller's chat folder, not the host's home folder. */
  function resolveUnknownFolders(ctx: IpcContext, principal: Principal): void {
    ctx.session.workingDirectory = resolveUnknownFolder(ctx.session.workingDirectory, principal)
    ctx.session.projectPath = resolveUnknownFolder(ctx.session.projectPath, principal)
  }

  /**
   * A new session that starts in a working tree where another session runs a
   * turn is refused once, so the client can ask the person (plan 004 item 7).
   * A session that makes its own new worktree, and a chat folder, share no tree.
   */
  function refuseBusyStart(ctx: IpcContext, handlerCtx: HandlerCtx): void {
    if (ctx.session.agentSessionId) return
    if (ctx.session.worktreeBaseBranch && !ctx.session.gitContext?.worktreePath) return
    const tree = ctx.session.gitContext?.worktreePath || ctx.session.workingDirectory
    if (isChatFolder(tree)) return
    const busy = sessionRuntime.busyWorkingTree(tree, {
      sessionId: ctx.session.sessionId,
      clientId: handlerCtx.clientId,
      userId: handlerCtx.actor.user ? userKey(handlerCtx.actor.user.id) : null,
    })
    if (!busy) return
    log.info('session_start_working_tree_busy', { sessionId: ctx.session.sessionId, runningSessionId: busy.sessionId })
    throw new WorkingTreeBusyError(busy.authorName)
  }

  /**
   * New sessions a client watched before any request named their folder. They
   * start private; the first request that names the folder decides whether the
   * organization gets its grant. Lost on restart, so such a session stays private.
   */
  const sessionsAwaitingFolder = new Set<string>()

  /**
   * The person who started the session owns it (docs/plans/multiplayer-sharing.md §3.4).
   * A session in a chat folder starts private; a project session starts shared
   * with the organization in an organization space (Scratchpad decision S5).
   */
  async function claimSession(sessionId: string | null | undefined, handlerCtx: HandlerCtx, workingDirectory: string): Promise<void> {
    const shares = deps.shares
    if (!sessionId || !shares) return
    const resource = { kind: 'session', id: sessionId } as const
    const shareWithOrganization = !isChatFolder(workingDirectory)
    if (!sessionsAwaitingFolder.delete(sessionId)) {
      await shares.claimOwner(resource, handlerCtx.principal, { shareWithOrganization })
    } else if (shareWithOrganization) {
      await shares.shareWithOrganization(resource, handlerCtx.principal)
    }
  }

  server.register('watchSession', async (args, handlerCtx) => {
    const [input] = args
    // Asked before the watch, which makes any session known.
    const startsSession = !input?.agentSessionId && !(input?.sessionId && sessionRuntime.isKnownSession(input.sessionId))
    const resolved = sessionRuntime.watchSession(input ?? {}, requireClientId(handlerCtx))
    log.info('rpc_watch_session', { sessionId: resolved.sessionId, requested: input?.sessionId ?? null })
    // A guest or member can only watch a session that was shared with them, so a
    // claim here never gives them one; it records the owner of a brand-new session.
    // The watch does not know the session's folder, so a new session waits for
    // the prompt that names it before the organization can see it.
    const resource = { kind: 'session', id: resolved.sessionId } as const
    if (startsSession && deps.shares && isOrganizationSpace(handlerCtx.principal)) {
      sessionsAwaitingFolder.add(resolved.sessionId)
      await deps.shares.claimOwner(resource, handlerCtx.principal, { shareWithOrganization: false })
    } else {
      await deps.shares?.claimOwner(resource, handlerCtx.principal)
    }
    return resolved
  })

  server.register('unwatchSession', (args, handlerCtx) => {
    const [sessionId] = args
    log.info('rpc_unwatch_session', { sessionId })
    sessionsAwaitingFolder.delete(sessionId)
    sessionRuntime.unwatchSession(sessionId, requireClientId(handlerCtx))
  })

  server.register('createHeadlessSession', async (args, handlerCtx) => {
    const [request] = args
    log.info('rpc_create_headless_session', { provider: request.provider })
    request.cwd = resolveUnknownFolder(request.cwd, handlerCtx.principal)
    const created = await sessionRuntime.createSession(request, handlerCtx.actor)
    await claimSession(created.agentSessionId, handlerCtx, request.cwd)
    return created
  })

  server.register('bindRuntimeSession', async (args, handlerCtx) => {
    const [ctx] = args
    log.info('rpc_bind_runtime_session', {
      sessionId: ctx.session.sessionId,
      agentSessionId: ctx.session.agentSessionId,
    })
    resolveUnknownFolders(ctx, handlerCtx.principal)
    await claimSession(ctx.session.sessionId, handlerCtx, ctx.session.workingDirectory)
    return sessionRuntime.bindRuntimeSession(ctx, requireClientId(handlerCtx))
  })

  server.register('resetSession', (args) => {
    const [ctx] = args
    log.info('rpc_reset_session', { sessionId: ctx.session.sessionId })
    // Warm the same path the Files view queries: the worktree root when this
    // session has one, else the project directory. Warming the bare
    // workingDirectory missed entirely for worktree sessions, so their first
    // open paid full scan.
    const warmPath =
      sessionRuntime.getGitContext(ctx.session.sessionId)?.worktreePath ?? ctx.session.workingDirectory
    if (warmPath && warmPath !== '~') warmFinder(warmPath)
    sessionRuntime.resetSession(ctx)
  })

  server.register('switchSessionAgent', (args, handlerCtx) => {
    const [sessionId, provider, agentSessionId] = args
    log.info('rpc_switch_session_agent', { sessionId, provider, agentSessionId: agentSessionId ?? null })
    return sessionRuntime.switchSessionProvider(sessionId, provider, agentSessionId, handlerCtx.actor)
  })

  server.register('acceptPlan', (args, handlerCtx) => {
    const [ctx, request] = args
    log.info('rpc_accept_plan', { sessionId: ctx.session.sessionId, planId: request.planId, provider: request.provider ?? null })
    return sessionRuntime.acceptPlan(ctx, request, handlerCtx.actor)
  })

  server.register('prompt', async (args, handlerCtx) => {
    const [ctx, options] = args
    const sessionId = ctx.session.sessionId
    log.info('rpc_prompt', { sessionId })
    if (!sessionId) throw new Error('No sessionId provided — prompt rejected')
    resolveUnknownFolders(ctx, handlerCtx.principal)
    if (!options.allowBusyWorkingTree) refuseBusyStart(ctx, handlerCtx)
    await claimSession(sessionId, handlerCtx, ctx.session.workingDirectory)
    await admitTurn(ctx, handlerCtx.actor)
    // A recording sent to an agent is part of the transcript now, so the
    // retention sweep must not delete it. A failure here must not fail the turn.
    void recordingRetention().keepRecordingsSentIn(options.prompt).catch((error) => {
      log.warn('browser_recording_keep_failed', { sessionId, message: error instanceof Error ? error.message : String(error) })
    })
    try {
      // The turn runs on its author's provider seat (Step 2 plan §3.3).
      return await sessionRuntime.submitPrompt(ctx, options, {
        clientId: handlerCtx.clientId,
        deviceId: handlerCtx.deviceId,
        actor: handlerCtx.actor,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('prompt_failed', { sessionId, error: msg })
      throw err
    }
  })

  server.register('activityLease', (args, handlerCtx) => {
    const [foreground] = args
    // Foreground evidence gates watch-fired freshness work (dispatch-client
    // step 7); a returning lease flushes whatever went stale in the dark.
    const hadLease = activityLeases.hasForegroundLease()
    activityLeases.report(handlerCtx.clientId ?? 'unknown-client', foreground === true)
    if (!hadLease && foreground === true) sessionRuntime.flushDeferredGitRefreshes()
    return { ok: true }
  })

  server.register('retry', async (args, handlerCtx) => {
    const [ctx, options] = args
    log.info('rpc_retry', { sessionId: ctx.session.sessionId })
    resolveUnknownFolders(ctx, handlerCtx.principal)
    await admitTurn(ctx, handlerCtx.actor)
    return sessionRuntime.retry(ctx, options, handlerCtx.clientId, handlerCtx.actor)
  })

  // A conversation answers its own requests, and the requests of a session it
  // sent work to — the card that shows a child's question answers it for the
  // child. Access to the conversation itself is checked by the access policy.
  server.register('respondPermission', async (args, handlerCtx) => {
    const [ctx, askingSessionId, questionId, optionId, updatedPlan] = args
    log.info('rpc_respond_permission', { sessionId: ctx.session.sessionId, askingSessionId, questionId, optionId, hasUpdatedPlan: !!updatedPlan })
    if (!deps.orchestrator.mayAnswer(ctx.session.sessionId, askingSessionId)) return false
    if (!await mayAnswer(askingSessionId, handlerCtx.principal)) return false
    return sessionRuntime.respondToPermission(askingSessionId, questionId, optionId, updatedPlan, handlerCtx.actor)
  })

  server.register('respondQuestion', async (args, handlerCtx) => {
    const [ctx, askingSessionId, questionId, answers] = args
    log.info('rpc_respond_question', { sessionId: ctx.session.sessionId, askingSessionId, questionId })
    if (!deps.orchestrator.mayAnswer(ctx.session.sessionId, askingSessionId)) return false
    if (!await mayAnswer(askingSessionId, handlerCtx.principal)) return false
    return sessionRuntime.respondToQuestion(askingSessionId, questionId, answers, handlerCtx.actor)
  })

  server.register('rateLimitDecision', (args, handlerCtx) => {
    const [ctx, action] = args
    log.info('rpc_rate_limit_decision', { sessionId: ctx.session.sessionId, action })
    return sessionRuntime.resolveRateLimit(ctx, action, handlerCtx.actor)
  })

  server.register('cancelQueuedPrompt', (args, handlerCtx) => {
    const [ctx, queueId] = args
    log.info('rpc_cancel_queued_prompt', { sessionId: ctx.session.sessionId, queueId })
    return sessionRuntime.cancelQueuedPrompt(ctx, queueId, handlerCtx.actor)
  })

  server.register('editQueuedPrompt', (args, handlerCtx) => {
    const [ctx, queueId, text] = args
    log.info('rpc_edit_queued_prompt', { sessionId: ctx.session.sessionId, queueId })
    return sessionRuntime.editQueuedPrompt(ctx, queueId, text, handlerCtx.actor)
  })

  server.register('getPluginCommands', (args) => {
    const [workingDirectory, ctx] = args
    return sessionRuntime.listPluginCommands(agentIdFromContext(ctx), workingDirectory, ctx)
  })

  server.register('getThreadGoal', (args) => {
    const [threadId, ctx, provider] = args
    return sessionRuntime.getThreadGoal(provider ?? agentIdFromContext(ctx), threadId)
  })

  server.register('setThreadGoal', (args) => {
    const [request, ctx, provider] = args
    return sessionRuntime.setThreadGoal(provider ?? agentIdFromContext(ctx), request)
  })

  server.register('clearThreadGoal', (args) => {
    const [threadId, ctx, provider] = args
    return sessionRuntime.clearThreadGoal(provider ?? agentIdFromContext(ctx), threadId)
  })
}
