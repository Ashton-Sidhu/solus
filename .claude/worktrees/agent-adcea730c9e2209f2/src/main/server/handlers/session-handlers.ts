import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { WORKSPACE_DIR } from '../../workspace'
import type { ControlPlane } from '../../control-plane'
import type { AgentId, AgentMetadata, IpcContext, PromptOptions, RateLimitDecisionAction, ThreadGoalSetRequest } from '../../../shared/types'
import { AGENT_BIN } from '../../../shared/types'
import { getCliEnv, warmCliPath } from '../../cli-env'
import { createLogger } from '../../logger'
import { appVersion } from '../../platform/paths'
import { warmFinder } from '../file-finder'
import type { SolusServer } from '../server'
import type { HandlerCtx } from '../server'

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
const SOLUS_DIR = join(homedir(), '.solus')
const AGENT_BINARIES_FILE = join(SOLUS_DIR, 'agent-binaries.json')
type PersistedAgentBinaries = Partial<Record<AgentId, string | null>>
let _persistedBinaries: PersistedAgentBinaries | null = null

function loadPersistedBinaries(): PersistedAgentBinaries {
  if (_persistedBinaries) return _persistedBinaries
  try {
    const parsed = JSON.parse(readFileSync(AGENT_BINARIES_FILE, 'utf8'))
    _persistedBinaries = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    _persistedBinaries = {}
  }
  return _persistedBinaries!
}

function savePersistedBinaries(): void {
  try {
    mkdirSync(SOLUS_DIR, { recursive: true })
    writeFileSync(AGENT_BINARIES_FILE, JSON.stringify(_persistedBinaries ?? {}))
  } catch (err) {
    log.warn(`failed to persist agent-binaries.json: ${String(err)}`)
  }
}

async function probeAgentBinary(agentId: AgentId): Promise<string | null> {
  const bin = AGENT_BIN[agentId]
  if (!bin) return null
  try {
    // Wait for the async PATH warmup instead of letting getCliEnv() fall back to
    // the synchronous login-shell probes, which would block the main process.
    await warmCliPath()
    const { stdout } = await execFileAsync('which', [bin], { encoding: 'utf8', env: getCliEnv(), timeout: 3000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function resolveAgentBinary(agentId: AgentId): Promise<string | null> {
  if (_agentBinaryCache.has(agentId)) return _agentBinaryCache.get(agentId)!

  const persisted = loadPersistedBinaries()
  const persistedPath = persisted[agentId]
  if (persistedPath && existsSync(persistedPath)) {
    _agentBinaryCache.set(agentId, persistedPath)
    // Self-heal in the background: if the binary moved/upgraded, update the
    // cache and the persisted file for the next lookup/launch.
    void probeAgentBinary(agentId).then((fresh) => {
      if (fresh !== persistedPath) {
        _agentBinaryCache.set(agentId, fresh)
        persisted[agentId] = fresh
        savePersistedBinaries()
      }
    })
    return persistedPath
  }

  const result = await probeAgentBinary(agentId)
  _agentBinaryCache.set(agentId, result)
  persisted[agentId] = result
  savePersistedBinaries()
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
    log.info('RPC start')
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
      log.warn(`failed to create workspace dir ${WORKSPACE_DIR}: ${String(err)}`)
    }
    const agents = await Promise.all(
      controlPlane
        .getBackendIds()
        .map((id) => controlPlane.getMetadataFor(id))
        .filter((metadata): metadata is AgentMetadata => metadata !== undefined)
        .map(enrichAgentMetadata),
    )
    return { projectPath: process.cwd(), homePath: homedir(), workspacePath: WORKSPACE_DIR, version: appVersion(), agents }
  })

  function tabOwner(handlerCtx: HandlerCtx): { clientId: string; deviceId?: string } {
    if (!handlerCtx.clientId) throw new Error('Tab ownership requires a connected client')
    return {
      clientId: handlerCtx.clientId,
      deviceId: handlerCtx.deviceId,
    }
  }

  server.register('createTab', (args, handlerCtx) => {
    const [clientTabId] = args as [string | undefined]
    const tabId = controlPlane.createTab(clientTabId, tabOwner(handlerCtx))
    log.info(`RPC createTab → ${tabId}`)
    return { tabId }
  })

  function bindRuntimeSession(args: unknown[], handlerCtx: HandlerCtx) {
    const [ctx] = args as [IpcContext]
    const sessionId = ctx.session.agentSessionId
    if (!sessionId) return null
    log.info(`RPC bindRuntimeSession: tab=${ctx.session.tabId} session=${sessionId}`)
    return controlPlane.bindRuntimeSession(ctx.session.tabId, sessionId, tabOwner(handlerCtx))
  }

  server.register('bindRuntimeSession', bindRuntimeSession)

  server.register('startAgentSession', async (args, handlerCtx) => {
    const [ctx, options] = args as [IpcContext, PromptOptions]
    log.info(`RPC startAgentSession: tab=${ctx.session.tabId || 'headless'}`)
    return controlPlane.startAgentSession(ctx, options, handlerCtx.deviceId)
  })

  server.register('dispatchToAgentSession', async (args, handlerCtx) => {
    const [ctx, agentSessionId, options] = args as [IpcContext, string, PromptOptions]
    log.info(`RPC dispatchToAgentSession: session=${agentSessionId} tab=${ctx.session.tabId || 'headless'}`)
    return controlPlane.dispatchToAgentSession(ctx, agentSessionId, options, handlerCtx.deviceId)
  })

  server.register('resetTabSession', (args, handlerCtx) => {
    const [ctx] = args as [IpcContext]
    log.info(`RPC resetTabSession: ${ctx.session.tabId}`)
    // Warm the same path the Files view queries: the worktree root when this tab
    // has one, else the project directory. Warming the bare workingDirectory
    // missed entirely for worktree sessions, so their first open paid full scan.
    const warmPath =
      controlPlane.getGitContext(ctx.session.tabId)?.worktreePath ?? ctx.session.workingDirectory
    if (warmPath && warmPath !== '~') warmFinder(warmPath)
    controlPlane.resetTabSession(ctx, tabOwner(handlerCtx))
  })

  server.register('prompt', async (args, handlerCtx) => {
    const [ctx, options] = args as [IpcContext, PromptOptions]
    const tabId = ctx.session.tabId
    log.info(`RPC prompt: tab=${tabId}`)
    if (!tabId) throw new Error('No tabId provided — prompt rejected')
    try {
      await controlPlane.submitPrompt(ctx, options, handlerCtx.deviceId)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`prompt error: ${msg}`)
      throw err
    }
  })

  server.register('stopTab', (args) => {
    const [ctx] = args as [IpcContext]
    log.info(`RPC stopTab: ${ctx.session.tabId}`)
    return controlPlane.cancelTab(ctx)
  })

  server.register('retry', async (args) => {
    const [ctx, options] = args as [IpcContext, PromptOptions]
    log.info(`RPC retry: tab=${ctx.session.tabId}`)
    return controlPlane.retry(ctx, options)
  })

  server.register('closeTab', (args, handlerCtx) => {
    const [ctx] = args as [IpcContext]
    log.info(`RPC closeTab: ${ctx.session.tabId}`)
    controlPlane.closeTab(ctx, tabOwner(handlerCtx))
  })

  server.register('respondPermission', (args) => {
    const [ctx, questionId, optionId, updatedPlan] = args as [IpcContext, string, string, string | undefined]
    log.info(`RPC respondPermission: tab=${ctx.session.tabId} question=${questionId} option=${optionId}${updatedPlan ? ' (with edited plan)' : ''}`)
    return controlPlane.respondToPermission(ctx, questionId, optionId, updatedPlan)
  })

  server.register('respondQuestion', (args) => {
    const [ctx, questionId, answers] = args as [IpcContext, string, Record<string, string>]
    log.info(`RPC respondQuestion: tab=${ctx.session.tabId} question=${questionId}`)
    return controlPlane.respondToQuestion(ctx, questionId, answers)
  })

  server.register('rateLimitDecision', (args) => {
    const [ctx, action] = args as [IpcContext, RateLimitDecisionAction]
    log.info(`RPC rateLimitDecision: tab=${ctx.session.tabId} action=${action}`)
    return controlPlane.resolveRateLimit(ctx, action)
  })

  server.register('cancelQueuedPrompt', (args) => {
    const [ctx, queueId] = args as [IpcContext, string]
    log.info(`RPC cancelQueuedPrompt: tab=${ctx.session.tabId} queueId=${queueId}`)
    return controlPlane.cancelQueuedPrompt(ctx, queueId)
  })

  server.register('rewindFiles', async (args) => {
    const [ctx, checkpointId] = args as [IpcContext, string]
    log.info(`RPC rewindFiles: tab=${ctx.session.tabId} checkpoint=${checkpointId}`)
    await controlPlane.rewindTabFiles(ctx, checkpointId)
    return true
  })

  server.register('getPluginCommands', (args) => {
    const [workingDirectory, ctx] = args as [string, IpcContext | undefined]
    return controlPlane.listPluginCommands(agentIdFromContext(ctx), workingDirectory, ctx)
  })

  server.register('getThreadGoal', (args) => {
    const [threadId, ctx, provider] = args as [string, IpcContext | undefined, AgentId | undefined]
    return controlPlane.getThreadGoal(provider ?? agentIdFromContext(ctx), threadId)
  })

  server.register('setThreadGoal', (args) => {
    const [request, ctx, provider] = args as [ThreadGoalSetRequest, IpcContext | undefined, AgentId | undefined]
    return controlPlane.setThreadGoal(provider ?? agentIdFromContext(ctx), request)
  })

  server.register('clearThreadGoal', (args) => {
    const [threadId, ctx, provider] = args as [string, IpcContext | undefined, AgentId | undefined]
    return controlPlane.clearThreadGoal(provider ?? agentIdFromContext(ctx), threadId)
  })
}
