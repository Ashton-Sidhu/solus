import type { ExchangeOutcome } from '@solus/contracts/session-exchange'
import type { AgentId, WireNormalizedEvent } from '@solus/contracts/types'
import { createLogger } from '../../logger'
import type { RemoteHost } from './remote-hosts'
import type { ResolvedInput } from './session-outputs'
import type { RunExchanges, SessionOrchestrator } from './session-orchestrator'

const log = createLogger('orchestration', 'remote-runs.ts')

/** The run hooks a remote child drives: the same ones a local run calls. */
export type RunHooks = Pick<SessionOrchestrator, 'runStarted' | 'inputRequested' | 'inputResolved' | 'runEvent' | 'runSettled'>

/** A run followed on another host: `watching` settles once host B watches the
 *  session for this host, and `stop` ends the follow. */
export interface RemoteRunFollow {
  watching: Promise<void>
  stop: () => void
  /** The prompt waits in host B's queue under this id. */
  queuedAs: (queueId: string) => void
}

/**
 * Follows one run of a session on another host and reports it through the
 * same hooks a local run uses (docs/plans/cross-host-sessions.md §5.4), so the
 * sender's card, notices, waits and report behave as for a local child. Host B
 * sends the session's events to this host as it does to a watching client.
 *
 * Start it before the session starts, and start the session once `watching`
 * resolves: a watch made first cannot miss a turn that ends at once. The
 * follow ends when the turn settles, or when `stop` is called.
 *
 * With `promptId`, the session already exists and may be in another turn. The
 * follow hears nothing until host B echoes the prompt (`user_message` with that
 * `clientPromptId`): the turn after the echo is the prompt's. A queued prompt
 * that host B drops — a Stop drains the queue — is never echoed; the turn that
 * ends after it was dropped settles it as interrupted.
 */
export function followRemoteRun(remote: RemoteHost, run: RunExchanges, provider: AgentId, hooks: RunHooks, promptId?: string): RemoteRunFollow {
  const { sessionId } = run
  /** What each open request asked, so its answer can say what was decided. */
  const requests = new Map<string, Extract<WireNormalizedEvent, { type: 'permission_request' | 'question_request' | 'plan' }>>()
  let result: { text: string; durationMs: number } | null = null
  let ended = false
  let echoed = promptId === undefined
  let queueId: string | undefined
  let dropped = false

  const watch = async () => { await remote.call('the session watch', () => remote.api.watchSession({ sessionId })) }

  const end = () => {
    if (ended) return
    ended = true
    unsubscribe()
    stopRewatch()
    void remote.api.unwatchSession(sessionId).catch(() => {})
  }

  const settle = (outcome: ExchangeOutcome) => {
    end()
    hooks.runSettled({ ...run, outcome, resultText: result?.text, durationMs: result?.durationMs, provider })
  }

  /** Before the echo, only the prompt's own place in host B's queue matters. */
  const awaitEcho = (event: WireNormalizedEvent) => {
    if (event.type === 'user_message' && event.clientPromptId === promptId) echoed = true
    else if (event.type === 'prompt_dequeued' && queueId !== undefined && event.queueId === queueId) dropped = true
    else if (event.type === 'turn_settled' && dropped) settle('interrupted')
  }

  const receive = (event: WireNormalizedEvent) => {
    if (!echoed) return awaitEcho(event)
    switch (event.type) {
      case 'status_change':
        if (event.status === 'running') hooks.runStarted(run)
        return
      case 'permission_request':
      case 'question_request':
        // An answer that arrives as a new message is not a turn waiting on a person.
        if (event.type === 'question_request' && event.responseMode === 'message') return
        requests.set(event.questionId, event)
        hooks.inputRequested(run, event)
        return
      case 'plan':
        hooks.runEvent(run, event)
        if (event.questionId) {
          requests.set(event.questionId, event)
          hooks.inputRequested(run, event)
        }
        return
      case 'permission_resolved': {
        const asked = requests.get(event.questionId)
        requests.delete(event.questionId)
        if (asked) hooks.inputResolved(run, resolvedPermission(asked, event.decision))
        return
      }
      case 'question_answered':
        requests.delete(event.answer.questionId)
        hooks.inputResolved(run, { kind: 'question', questions: event.answer.questions, answers: event.answer.answers })
        return
      case 'work_created':
      case 'artifact_created':
      case 'session_changed_files_updated':
        hooks.runEvent(run, event)
        return
      case 'task_complete':
        result = { text: event.result, durationMs: event.durationMs }
        return
      case 'turn_settled':
        settle(settledOutcome(event.outcome))
        return
      default:
        return
    }
  }

  const unsubscribe = remote.events.subscribe('session.eventReceived', (payload) => {
    if (payload.sessionId === sessionId && !ended) receive(payload.event)
  })
  // A new connection to host B is a new client there: it watches again.
  const stopRewatch = remote.onReconnected(() => {
    if (ended) return
    watch().catch((error) => log.warn('remote_watch_failed', { sessionId, hostId: remote.hostId, error: String(error) }))
  })
  return { watching: watch(), stop: end, queuedAs: (id) => { queueId = id } }
}

function settledOutcome(outcome: 'completed' | 'failed' | 'interrupted' | 'dead'): ExchangeOutcome {
  return outcome === 'dead' ? 'failed' : outcome
}

function resolvedPermission(
  asked: Extract<WireNormalizedEvent, { type: 'permission_request' | 'question_request' | 'plan' }>,
  decision: 'approved' | 'approved_for_session' | 'denied' | undefined,
): ResolvedInput {
  const allowed = decision === 'approved' || decision === 'approved_for_session'
  if (asked.type === 'plan') return { kind: 'plan', allowed, edited: false }
  if (asked.type === 'question_request') return { kind: 'question', questions: asked.questions, answers: {} }
  return { kind: 'permission', toolName: asked.toolName, allowed }
}
