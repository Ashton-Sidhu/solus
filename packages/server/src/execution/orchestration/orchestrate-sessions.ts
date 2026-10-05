import { SessionExchangeStore } from '../../data/sessions/session-exchange-store'
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
    sessionIdFor: (id) => sessionRuntime.sessionIdFor(id),
    activeExchangeIdsFor: (sessionId) => sessionRuntime.activeExchangeIdsFor(sessionId),
    queuedExchanges: () => sessionRuntime.queuedExchanges(),
    agentSessionIdFor: (sessionId) => sessionRuntime.agentSessionIdFor(sessionId),
    sessionMeta: (agentSessionId) => getIndexedSession(agentSessionId),
    createSession: (order) => sessionRuntime.createSession(order),
    promptSession: (agentSessionId, prompt, delivery, order) => sessionRuntime.promptSession(agentSessionId, prompt, delivery, order),
    // The orchestrator acts as the host until P7 names whose turn it is (plans/012 §4).
    stopSession: (id) => sessionRuntime.stopSession(id, HOST_ACTOR),
    respondToPermission: (askingSessionId, questionId, optionId, updatedPlan) => sessionRuntime.respondToPermission(askingSessionId, questionId, optionId, updatedPlan, HOST_ACTOR),
    pendingInputEvents: (agentSessionId) => sessionRuntime.pendingInputEventsForSession(agentSessionId),
    replaceQueuedPrompt: (sessionId, queueId, text, reportExchangeIds, exchangeIds) => sessionRuntime.replaceQueuedPrompt(sessionId, queueId, text, reportExchangeIds, exchangeIds),
    hasQueuedPrompt: (sessionId, queueId) => sessionRuntime.hasQueuedPrompt(sessionId, queueId),
    cancelQueuedPrompt: (agentSessionId, queueId) => sessionRuntime.cancelQueuedPromptForSession(agentSessionId, queueId),
    turnEnding: async (provider, agentSessionId, projectScope) => {
      const messages = await sessionRuntime.loadSession(provider, agentSessionId, projectScope)
      return turnEnding(messages)
    },
    taskIdFor: async (sessionId) => (await taskIdForSession(ANY_ORGANIZATION, sessionId)) ?? undefined,
    isLead: (sessionId) => sessionIsLead(ANY_ORGANIZATION, sessionId),
    emit: (sessionId, event) => sessionRuntime.publish(sessionId, event),
    invalidatePlanCaches: (agentSessionId) => sessionRuntime.invalidatePlanCaches(agentSessionId),
    recordActivity: (subject, actor, kind) => sessionRuntime.recordActivity(subject, actor, kind),
    trackWork: (work) => sessionRuntime.trackUpdateWork(work),
  }, {
    findPullRequest: async (checkout, projectScope) => {
      if (!checkout.branch) return null
      const host = await codeHostFor(checkout.repoRoot ?? projectScope)
      const pullRequest = host ? await pullRequestForBranch(host, checkout.branch) : undefined
      return pullRequest ? { number: pullRequest.number, url: pullRequest.url } : null
    },
  }, sessionRuntime.orchestrationDirectory ? new SessionExchangeStore(sessionRuntime.orchestrationDirectory) : undefined)
  sessionRuntime.useOrchestration(orchestrator)
  return orchestrator
}
