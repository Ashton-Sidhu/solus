import { sessionExecutionPhaseSchema, type SessionExecution, type SessionTurnOutcome } from '@solus/contracts/session-execution'
import type { DigestSubagent } from '@solus/contracts/session-digest'
import type { HostEventMap } from '@solus/contracts/host-events'
import { readSessionExecution, writeSessionExecution } from '../../data/sessions/session-executions'
import { afterDatabaseCommit } from '../../db/database'
import { organizationOfSession } from '../../data/sessions/session-records'
import { createLogger } from '../../logger'

const log = createLogger('SessionExecution', 'session-execution-recorder.ts')

type Status = HostEventMap['session.statusChanged']
type State = Omit<SessionExecution, 'revision'>
type PhaseDetails = Pick<NonNullable<SessionExecution['current']>, 'waitingForAgents' | 'rateLimitResetsAt'>
const empty: State = { current: null, lastTurn: null }

export class SessionExecutionRecorder {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly committed: (sessionId: string, toolId: string, execution: SessionExecution) => void) {}

  status(event: Status, runId: string | undefined, details: PhaseDetails = {}): void {
    const phase = sessionExecutionPhaseSchema.safeParse(event.status)
    this.update(event.sessionId, '', (previous) => {
      if (event.status === 'idle' && runId && previous.current?.runId === runId) {
        // A rate-limit release allows the held prompt to resume with its same id.
        if (previous.current.phase === 'rate_limited') {
          return { current: null, lastTurn: previous.lastTurn, hasPendingQuestion: event.hasPendingQuestion, delegatedRequest: event.delegatedRequest }
        }
        return settle({ ...previous, hasPendingQuestion: event.hasPendingQuestion, awaitingApproval: undefined, delegatedRequest: event.delegatedRequest }, runId, 'interrupted', event.at)
      }
      const current = phase.success && runId && (previous.lastTurn?.runId !== runId || event.at > previous.lastTurn.endedAt)
        ? { runId, phase: phase.data, startedAt: previous.current?.runId === runId ? previous.current.startedAt : event.at, ...details }
        : previous.current
      if (current?.runId === previous.current?.runId && current?.phase === previous.current?.phase
        && current?.waitingForAgents === previous.current?.waitingForAgents && current?.rateLimitResetsAt === previous.current?.rateLimitResetsAt
        && previous.hasPendingQuestion === event.hasPendingQuestion && previous.awaitingApproval === event.awaitingApproval
        && previous.delegatedRequest === event.delegatedRequest) return
      return { current, lastTurn: previous.lastTurn, hasPendingQuestion: event.hasPendingQuestion, awaitingApproval: event.awaitingApproval, delegatedRequest: event.delegatedRequest }
    })
  }

  settle(sessionId: string, runId: string, outcome: SessionTurnOutcome, endedAt: number): void {
    this.update(sessionId, '', (previous) => settle(previous, runId, outcome, endedAt))
  }

  subagent(sessionId: string, agent: DigestSubagent): void {
    this.update(sessionId, agent.id, (previous) => {
      if (agent.status === 'running') {
        if (previous.current || previous.lastTurn) return
        return { current: { runId: agent.id, phase: 'running', startedAt: agent.startedAt }, lastTurn: null }
      }
      const outcome = agent.status === 'stopped' ? 'interrupted' : agent.status
      if (previous.lastTurn?.outcome === outcome || previous.lastTurn?.outcome === 'interrupted') return
      const endedAt = agent.endedAt ?? agent.startedAt
      return { current: null, lastTurn: { runId: agent.id, startedAt: agent.startedAt, endedAt, outcome } }
    })
  }

  async settled(): Promise<void> {
    await Promise.all(this.queues.values())
  }

  private update(sessionId: string, toolId: string, change: (previous: State) => State | undefined): void {
    const next = (this.queues.get(sessionId) ?? Promise.resolve()).then(async () => {
      const organizationId = await organizationOfSession(sessionId)
      const previous = await readSessionExecution(organizationId, sessionId, toolId)
      const state = change(previous ?? empty)
      if (!state) return
      const execution = { ...state, revision: (previous?.revision ?? 0) + 1 }
      if (await writeSessionExecution(organizationId, sessionId, toolId, execution)) {
        await afterDatabaseCommit(async () => this.committed(sessionId, toolId, execution))
      }
    }).catch((error) => {
      log.warn('session_execution_update_failed', { sessionId, toolId, error: String(error) })
    })
    this.queues.set(sessionId, next)
    void next.then(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId)
    })
  }
}

function settle(previous: State, runId: string, outcome: SessionTurnOutcome, endedAt: number): State | undefined {
  if ((previous.lastTurn?.runId === runId && previous.current?.runId !== runId) || (previous.lastTurn && previous.lastTurn.endedAt > endedAt)) return
  // Another turn can start before the former turn's settlement event arrives.
  // Keep the new turn open and record the outcome of the earlier turn.
  const owned = previous.current?.runId === runId ? previous.current : null
  return {
    ...previous,
    current: owned ? null : previous.current,
    lastTurn: { runId, outcome, startedAt: owned?.startedAt ?? endedAt, endedAt },
  }
}
