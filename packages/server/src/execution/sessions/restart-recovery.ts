import { RunLedger, type ActiveRuns, type RestartRun } from '../../data/sessions/run-ledger'
import { RESTART_CONTINUATION_PROMPT, restartAuthority, restartContinuationError, restartRecoveryEnabled } from './restart-continuation'
import { hostUser } from '../../host/host-user'
import { type QueuedRequest } from './session-request-queue'
import { createLogger } from '../../logger'
import { settledSessionIds } from '../../data/sessions/session-states'
import { LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { organizationOfSession } from '../../data/sessions/session-records'
import { getIndexedSession } from '../../db/session-indexer'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import type { NormalizedEvent, SessionRunInput } from '@solus/contracts/types'
import { HOST_ACTOR, type Actor } from '../../admission/actor'
import type { SessionRuntime, SessionRunRequest } from '../session-runtime'

const log = createLogger('SessionRuntime', 'restart-recovery.ts')

/**
 * Restart receipts: what an active run needs to continue after a host
 * restart, and the continuation queued for it when the host starts again.
 */
export class RestartRecovery {
  readonly restartRuns: ActiveRuns | undefined

  constructor(private readonly rt: SessionRuntime, runLedger: RunLedger | undefined) {
    this.restartRuns = runLedger?.activeRuns
  }

  saveRestartRun(request: SessionRunRequest, organizationId: string | undefined): void {
    if (!this.restartRuns || this.rt.isShuttingDown || !restartRecoveryEnabled()
      || (organizationId !== undefined && organizationId !== LOCAL_ORGANIZATION_ID)
      || request.delegation || request.options.automationId || request.options.watchId) return
    const authority = restartAuthority(request.actor)
    if (request.input.agentSessionId && getIndexedSession(request.input.agentSessionId)?.delegation) return
    if (!authority) return
    const clientPromptId = request.options.clientPromptId?.startsWith('restart:')
      ? this.restartRuns.get(request.sessionId)?.clientPromptId : request.options.clientPromptId
    this.restartRuns.save({
      sessionId: request.sessionId, runId: request.runId!, input: request.input, state: 'starting',
      author: request.actor?.user ?? null, authority,
      prompt: request.options.displayPrompt ?? request.options.prompt,
      taskId: request.options.taskId, queueId: request.servedQueueId, backgroundTools: [],
      clientPromptId,
    })
  }

  /** Called once after host admission, seats and tools are wired. Client
   * reconnects never call this. Restored user queues stay held. */
  async recoverSessionsAfterRestart(): Promise<void> {
    if (!this.restartRuns || this.rt.isShuttingDown) return
    for (const saved of this.restartRuns.list()) {
      if (!restartRecoveryEnabled()) {
        this.restartRuns.remove(saved.sessionId, saved.runId)
        continue
      }
      const clientPromptId = `restart:${saved.runId}`
      if (this.rt.scheduler.requestQueue.hasPrompt(saved.sessionId, clientPromptId)) {
        if (saved.queueId) this.rt.scheduler.requestQueue.remove(saved.sessionId, saved.queueId)
        continue
      }
      // A run that waited for a person's answer is not interrupted work. The
      // restart ended the wait; the person answers with a new prompt.
      if (saved.state === 'awaiting_input') {
        this.restartRuns.remove(saved.sessionId, saved.runId)
        log.info('restart_continuation_skipped_awaiting_input', { sessionId: saved.sessionId, sourceRunId: saved.runId })
        continue
      }
      const settled = await settledSessionIds([saved.sessionId])
      if (settled.has(saved.sessionId) || this.rt.isShuttingDown) {
        this.restartRuns.remove(saved.sessionId, saved.runId)
        continue
      }
      const sourceThread = saved.input.agentSessionId
      if (await organizationOfSession(sourceThread ?? saved.sessionId) !== LOCAL_ORGANIZATION_ID) {
        this.restartRuns.remove(saved.sessionId, saved.runId)
        continue
      }
      const lineage = resolveSessionLineageById(saved.sessionId)?.active
      const error = restartContinuationError(saved, hostUser(), lineage)
      if (this.restartRuns.get(saved.sessionId)?.runId !== saved.runId) continue
      if (saved.state !== 'delivering' && !this.restartRuns.claim(saved)) continue
      this.queueRestartContinuation(saved, error)
    }
  }

  private queueRestartContinuation(saved: RestartRun, error?: string): void {
    // A delivering receipt without a queue entry is uncertain, never resent
    // automatically. The queue itself has its own durable start receipt.
    const prompt = RESTART_CONTINUATION_PROMPT
    const actor: Actor = saved.author === null ? HOST_ACTOR : {
      principal: { kind: 'local-owner', deviceId: null, deviceLabel: 'Host restart recovery' }, user: saved.author,
    }
    const input: SessionRunInput = { ...saved.input, forked: false,
      agentSessionId: saved.input.agentSessionId, permissionMode: this.rt.sessionPermissionModes.get(saved.sessionId) ?? saved.input.permissionMode }
    const entry: QueuedRequest = {
      queueId: crypto.randomUUID(), sessionId: saved.sessionId, prompt, enqueuedAt: Date.now(), reason: 'busy',
      held: !!error, error, author: saved.author ?? undefined, revision: 0,
      run: { sessionId: saved.sessionId, target: { kind: 'session', sessionId: saved.sessionId }, input,
        runId: crypto.randomUUID(), tools: [], actor,
        options: { prompt, displayPrompt: prompt, clientPromptId: `restart:${saved.runId}`, promptSource: 'agent', taskId: saved.taskId } },
      resolve() {}, reject() {},
    }
    try {
      this.rt.scheduler.requestQueue.enqueue(entry, 'first')
      if (saved.queueId) this.rt.scheduler.requestQueue.remove(saved.sessionId, saved.queueId)
      this.rt.scheduler.publishQueue(saved.sessionId)
      log.info('restart_continuation_queued', { sessionId: saved.sessionId, sourceRunId: saved.runId, held: !!error })
      if (!error) this.rt.scheduler.processQueueForSession(saved.sessionId)
    } catch (saveError) {
      log.error('restart_continuation_save_failed', { sessionId: saved.sessionId, error: String(saveError) })
      throw saveError
    }
  }

  recordRestartToolEvent(sessionId: string, event: NormalizedEvent): void {
    switch (event.type) {
      case 'tool_call_complete':
        if (!event.outcome && !event.completedAtMs) return
        break
      case 'tool_call':
      case 'tool_result':
      case 'subagent_report':
        break
      default:
        return
    }
    if (!this.restartRuns || this.rt.isShuttingDown || !restartRecoveryEnabled()) return
    const restartRun = this.restartRuns.get(sessionId)
    if (!restartRun) return
    const toolId = 'toolUseId' in event ? event.toolUseId : event.toolId
    if (event.type === 'tool_call') {
      if (restartRun.backgroundTools.length >= 32 || restartRun.backgroundTools.some((tool) => tool.toolId === toolId)) return
      restartRun.backgroundTools.push({ toolId: event.toolId, name: event.isSubagent ? `Child agent (${event.subagentType ?? event.toolName})` : event.toolName })
    } else {
      if (event.type === 'tool_result' && event.isAsyncLaunch) return
      const index = restartRun.backgroundTools.findIndex((tool) => tool.toolId === toolId)
      if (index === -1) return
      restartRun.backgroundTools.splice(index, 1)
    }
    this.restartRuns.save(restartRun)
  }
}
