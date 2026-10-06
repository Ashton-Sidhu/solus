import type { IpcContext } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { resolveHomePath } from '../../platform/paths'
import { SPAN_SERVICES } from '../../data/insights/registries'
import { runInputFromContext } from '../agents/run-input'
import type { SessionRuntime } from '../session-runtime'

/** Resolve the current provider member, so a stale client cannot compact an old thread. */
function compactionTarget(rt: SessionRuntime, ctx: IpcContext) {
  const sessionId = ctx.session.sessionId
  const existing = rt.activeSessions.get(sessionId)
  const lineage = resolveSessionLineageById(sessionId)?.active
  const input = existing?.runInput ?? runInputFromContext(ctx)
  const provider = existing?.backendId ?? lineage?.provider ?? input.provider
  if (provider !== 'codex') throw new Error('Manual compaction is only supported for Codex sessions.')
  const threadId = existing ? existing.agentSessionId : lineage ? lineage.providerSessionId : input.agentSessionId
  if (!sessionId || !threadId || input.forked) {
    throw new Error('Send a first message before you compact this session.')
  }
  return { sessionId, threadId, input }
}

/** Starts compaction as a tracked run, without creating a model prompt or a restart prompt. */
export async function compactSession(rt: SessionRuntime, ctx: IpcContext, actor: Actor): Promise<void> {
  rt.assertNewWorkAllowed()
  const { sessionId, threadId, input } = compactionTarget(rt, ctx)
  const backend = rt.backendFor('codex')
  const controllers = rt.launcher.pendingSetupControllers
  if (rt.statuses.isSessionBusy(sessionId) || controllers.has(sessionId)
    || backend.isSessionRunning(threadId) || backend.getPendingHandles().some((handle) => handle.agentSessionId === threadId)) {
    throw new Error('Wait for the current turn to finish before you compact this session.')
  }
  // Reserve the session before seat resolution. A second command or prompt
  // must not start another run in the same provider thread.
  const controller = new AbortController()
  controllers.set(sessionId, controller)
  rt.agentSessionToSession.set(threadId, sessionId)
  let session = rt.activeSessions.get(sessionId)
  if (!session) {
    session = {
      sessionId, agentSessionId: threadId, backendId: 'codex',
      status: 'completed', pendingInputEvents: [],
      runInput: { ...input, provider: 'codex', agentSessionId: threadId },
      lastActivityAt: Date.now(), promptCount: 0,
    }
    rt.activeSessions.set(sessionId, session)
  }
  const turnId = crypto.randomUUID()
  session.activeTurnId = turnId
  session.lastActivityAt = Date.now()
  rt.statuses.setStatus(sessionId, 'connecting')
  try {
    const seat = await rt.seatForTurn(actor, 'codex')
    if (controller.signal.aborted || rt.isShuttingDown) throw new Error('Interrupted')
    const run = rt.runAgent({
      provider: 'codex', prompt: '', operation: 'compact', tools: [],
      cwd: resolveHomePath(input.workingDirectory),
      permissionMode: input.permissionMode, model: input.model,
      persistence: 'session', service: SPAN_SERVICES.sessions,
      conversation: { kind: 'resume', threadId }, seat: seat ?? undefined,
    }, { changedFiles: input.sessionChangedFiles })
    run.handle.sessionId = sessionId
    // ProviderEvents owns terminal status and event delivery. Return at launch;
    // the client must not wait on a long compaction RPC.
    void run.done.catch(() => {})
  } catch (error) {
    if (rt.activeSessions.get(sessionId)?.activeTurnId === turnId) {
      rt.statuses.setStatus(sessionId, controller.signal.aborted ? 'interrupted' : 'failed')
      rt.activeSessions.delete(sessionId)
    }
    throw error
  } finally {
    if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
  }
}
