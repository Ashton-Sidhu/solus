import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import { WORKSPACE_DIR } from '../../workspace'
import type { ControlPlane } from '../../control-plane'
import type { AgentId, AgentMetadata, IpcContext } from '../../../shared/types'
import { AGENT_BIN } from '../../../shared/types'
import { findOnPath, getCliEnv, warmCliPath } from '../../cli-env'
import { createLogger } from '../../logger'
import { appVersion, solusDir } from '../../platform/paths'
import { warmFinder } from '../file-finder'
import type { SolusServer } from '../server'
import type { HandlerCtx } from '../server'
import { setupProjectsRoot } from './setup-handlers'

const log = createLogger('main', 'session-handlers')
const execFileAsync = promisify(execFile)

export interface SessionDeps {
  controlPlane: ControlPlane
  agentIdFromContext(ctx?: IpcContext): AgentId
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
  const { controlPlane, agentIdFromContext } = deps

  server.register('start', async (_args, _handlerCtx) => {
    log.info('rpc_start')
    // No seq-reset here: `start` runs only at boot, when the renderer is already
    // performing a full bootstrapRuntimeTabs (createTab + bindRuntimeSession per
    // tab). Pushing seq-reset would trigger a redundant resyncRuntime that races
    // that bootstrap — doubling the WS calls and flickering the "Syncing…" badge.
    // Genuine reconnect gaps are still covered by the WS resume protocol
    // (handleResume → seq-reset) in transports/websocket.ts.
    // Ensure the default workspace exists before any session points its cwd at it.
    try {
      mkdirSync(WORKSPACE_DIR, { recursive: true })
    } catch (err) {
      log.warn('workspace_dir_create_failed', { workspaceDir: WORKSPACE_DIR, error: String(err) })
    }
    const agents = await Promise.all(
      controlPlane
        .getBackendIds()
        .map((id) => controlPlane.getMetadataFor(id))
        .filter((metadata): metadata is AgentMetadata => metadata !== undefined)
        .map(enrichAgentMetadata),
    )
    return { projectPath: setupProjectsRoot(), homePath: homedir(), workspacePath: WORKSPACE_DIR, version: appVersion(), agents }
  })

  function requireClientId(handlerCtx: HandlerCtx): string {
    if (!handlerCtx.clientId) throw new Error('Watching a session requires a connected client')
    return handlerCtx.clientId
  }

  server.register('watchSession', (args, handlerCtx) => {
    const [input] = args
    const resolved = controlPlane.watchSession(input ?? {}, requireClientId(handlerCtx))
    log.info('rpc_watch_session', { sessionId: resolved.sessionId, requested: input?.sessionId ?? null })
    return resolved
  })

  server.register('unwatchSession', (args, handlerCtx) => {
    const [sessionId] = args
    log.info('rpc_unwatch_session', { sessionId })
    controlPlane.unwatchSession(sessionId, requireClientId(handlerCtx))
  })

  server.register('createHeadlessSession', (args) => {
    const [request] = args
    log.info('rpc_create_headless_session', { provider: request.provider })
    return controlPlane.createSession(request)
  })

  server.register('bindRuntimeSession', (args, handlerCtx) => {
    const [ctx] = args
    log.info('rpc_bind_runtime_session', {
      sessionId: ctx.session.sessionId,
      agentSessionId: ctx.session.agentSessionId,
    })
    return controlPlane.bindRuntimeSession(ctx, requireClientId(handlerCtx))
  })

  server.register('resetSession', (args) => {
    const [ctx] = args
    log.info('rpc_reset_session', { sessionId: ctx.session.sessionId })
    // Warm the same path the Files view queries: the worktree root when this
    // session has one, else the project directory. Warming the bare
    // workingDirectory missed entirely for worktree sessions, so their first
    // open paid full scan.
    const warmPath =
      controlPlane.getGitContext(ctx.session.sessionId)?.worktreePath ?? ctx.session.workingDirectory
    if (warmPath && warmPath !== '~') warmFinder(warmPath)
    controlPlane.resetSession(ctx)
  })

  server.register('switchSessionAgent', (args) => {
    const [sessionId, provider, agentSessionId] = args
    log.info('rpc_switch_session_agent', { sessionId, provider, agentSessionId: agentSessionId ?? null })
    return controlPlane.switchSessionProvider(sessionId, provider, agentSessionId)
  })

  server.register('prompt', async (args, handlerCtx) => {
    const [ctx, options] = args
    const sessionId = ctx.session.sessionId
    log.info('rpc_prompt', { sessionId })
    if (!sessionId) throw new Error('No sessionId provided — prompt rejected')
    try {
      return await controlPlane.submitPrompt(ctx, options, {
        clientId: handlerCtx.clientId,
        deviceId: handlerCtx.deviceId,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('prompt_failed', { sessionId, error: msg })
      throw err
    }
  })

  server.register('retry', async (args, handlerCtx) => {
    const [ctx, options] = args
    log.info('rpc_retry', { sessionId: ctx.session.sessionId })
    return controlPlane.retry(ctx, options, handlerCtx.clientId)
  })

  server.register('respondPermission', (args) => {
    const [ctx, questionId, optionId, updatedPlan] = args
    log.info('rpc_respond_permission', { sessionId: ctx.session.sessionId, questionId, optionId, hasUpdatedPlan: !!updatedPlan })
    return controlPlane.respondToPermission(questionId, optionId, updatedPlan)
  })

  server.register('respondQuestion', (args) => {
    const [ctx, questionId, answers] = args
    log.info('rpc_respond_question', { sessionId: ctx.session.sessionId, questionId })
    return controlPlane.respondToQuestion(questionId, answers)
  })

  server.register('rateLimitDecision', (args) => {
    const [ctx, action] = args
    log.info('rpc_rate_limit_decision', { sessionId: ctx.session.sessionId, action })
    return controlPlane.resolveRateLimit(ctx, action)
  })

  server.register('cancelQueuedPrompt', (args) => {
    const [ctx, queueId] = args
    log.info('rpc_cancel_queued_prompt', { sessionId: ctx.session.sessionId, queueId })
    return controlPlane.cancelQueuedPrompt(ctx, queueId)
  })

  server.register('editQueuedPrompt', (args) => {
    const [ctx, queueId, text] = args
    log.info('rpc_edit_queued_prompt', { sessionId: ctx.session.sessionId, queueId })
    return controlPlane.editQueuedPrompt(ctx, queueId, text)
  })

  server.register('rewindFiles', async (args) => {
    const [ctx, checkpointId] = args
    log.info('rpc_rewind_files', { sessionId: ctx.session.sessionId, checkpointId })
    await controlPlane.rewindSessionFiles(ctx, checkpointId)
    return true
  })

  server.register('getPluginCommands', (args) => {
    const [workingDirectory, ctx] = args
    return controlPlane.listPluginCommands(agentIdFromContext(ctx), workingDirectory, ctx)
  })

  server.register('getThreadGoal', (args) => {
    const [threadId, ctx, provider] = args
    return controlPlane.getThreadGoal(provider ?? agentIdFromContext(ctx), threadId)
  })

  server.register('setThreadGoal', (args) => {
    const [request, ctx, provider] = args
    return controlPlane.setThreadGoal(provider ?? agentIdFromContext(ctx), request)
  })

  server.register('clearThreadGoal', (args) => {
    const [threadId, ctx, provider] = args
    return controlPlane.clearThreadGoal(provider ?? agentIdFromContext(ctx), threadId)
  })
}
