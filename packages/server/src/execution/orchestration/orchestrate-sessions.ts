import type { SessionRuntime } from '../session-runtime'
import { HOST_ACTOR } from '../../admission/actor'
import { getIndexedSession } from '../../db/session-indexer'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { sessionIsLead, taskIdForSession } from '../../data/tasks/task-sessions'
import { codeHostFor, pullRequestForBranch } from '../../prs/code-host'
import { SessionOrchestrator, turnEnding } from './session-orchestrator'

/** The host's session orchestrator, running its turns on `sessionRuntime` and
 *  hearing back from it through the control plane's hooks. */
export function orchestrateSessions(sessionRuntime: SessionRuntime): SessionOrchestrator {
  const orchestrator = new SessionOrchestrator({
    activeExchangeIdsFor: (sessionId) => sessionRuntime.activeExchangeIdsFor(sessionId),
    queuedExchanges: () => sessionRuntime.scheduler.queuedExchanges(),
    sessionMeta: (sessionId) => getIndexedSession(sessionId),
    createSession: (order) => sessionRuntime.dispatch.createSession(order),
    // A prompt one agent sends acts for the person the sender works for; with no sender, the target's.
    promptSession: (sessionId, prompt, delivery, { senderSessionId, ...order }) => sessionRuntime.dispatch.promptSession(sessionId, prompt, delivery, {
      ...order,
      actor: senderSessionId ? sessionRuntime.actorOfSession(senderSessionId) : undefined,
    }),
    // The orchestrator acts as the host until P7 names whose turn it is (plans/012 §4).
    stopSession: (id) => sessionRuntime.stopSession(id, HOST_ACTOR),
    respondToPermission: (askingSessionId, questionId, optionId, updatedPlan) => sessionRuntime.inputRequests.respondToPermission(askingSessionId, questionId, optionId, updatedPlan, HOST_ACTOR),
    pendingInputEvents: (sessionId) => sessionRuntime.inputRequests.pendingInputEventsForSession(sessionId),
    replaceQueuedPrompt: (sessionId, queueId, text, reportExchangeIds, exchangeIds) => sessionRuntime.scheduler.replaceQueuedPrompt(sessionId, queueId, text, reportExchangeIds, exchangeIds),
    hasQueuedPrompt: (sessionId, queueId) => sessionRuntime.scheduler.hasQueuedPrompt(sessionId, queueId),
    cancelQueuedPrompt: (sessionId, queueId) => sessionRuntime.scheduler.cancelQueued(sessionId, queueId),
    turnEnding: async (provider, sessionId, projectScope) => {
      const messages = await sessionRuntime.history.loadSession(provider, sessionId, projectScope)
      return turnEnding(messages)
    },
    taskIdFor: async (sessionId) => (await taskIdForSession(ANY_ORGANIZATION, sessionId)) ?? undefined,
    isLead: (sessionId) => sessionIsLead(ANY_ORGANIZATION, sessionId),
    emit: (sessionId, event) => sessionRuntime.publish(sessionId, event),
    invalidatePlanCaches: (sessionId) => sessionRuntime.history.invalidatePlanCaches(sessionId),
    recordActivity: (subject, actor, kind) => sessionRuntime.recordActivity(subject, actor, kind),
    trackWork: (work) => sessionRuntime.trackUpdateWork(work),
  }, {
    findPullRequest: async (checkout, projectScope) => {
      if (!checkout.branch) return null
      const host = await codeHostFor(checkout.repoRoot ?? projectScope)
      const pullRequest = host ? await pullRequestForBranch(host, checkout.branch) : undefined
      return pullRequest ? { number: pullRequest.number, url: pullRequest.url } : null
    },
  }, sessionRuntime.runLedger)
  sessionRuntime.useOrchestration(orchestrator)
  return orchestrator
}
