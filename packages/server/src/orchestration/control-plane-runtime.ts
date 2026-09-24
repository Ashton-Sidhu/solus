import type { ControlPlane } from '../control-plane'
import { getIndexedSession } from '../db/session-indexer'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
import { taskIdForSession } from '../tasks/task-sessions'
import { codeHostFor, pullRequestForBranch } from '../prs/code-host'
import { SessionOrchestrator, turnEnding } from './session-orchestrator'

/** The host's session orchestrator, running its turns on `controlPlane` and
 *  hearing back from it through the control plane's hooks. */
export function orchestrateSessions(controlPlane: ControlPlane): SessionOrchestrator {
  const orchestrator = new SessionOrchestrator({
    sessionIdFor: (id) => controlPlane.sessionIdFor(id),
    agentSessionIdFor: (sessionId) => controlPlane.agentSessionIdFor(sessionId),
    sessionMeta: (agentSessionId) => getIndexedSession(agentSessionId),
    createSession: (order) => controlPlane.createSession(order),
    promptSession: (agentSessionId, prompt, delivery, order) => controlPlane.promptSession(agentSessionId, prompt, delivery, order),
    stopSession: (id) => controlPlane.stopSession(id),
    respondToPermission: (askingSessionId, questionId, optionId, updatedPlan) => controlPlane.respondToPermission(askingSessionId, questionId, optionId, updatedPlan),
    pendingInputEvents: (agentSessionId) => controlPlane.pendingInputEventsForSession(agentSessionId),
    replaceQueuedPrompt: (sessionId, queueId, text) => controlPlane.replaceQueuedPrompt(sessionId, queueId, text),
    hasQueuedPrompt: (sessionId, queueId) => controlPlane.hasQueuedPrompt(sessionId, queueId),
    cancelQueuedPrompt: (agentSessionId, queueId) => controlPlane.cancelQueuedPromptForSession(agentSessionId, queueId),
    turnEnding: async (provider, agentSessionId, projectScope) => {
      const messages = await controlPlane.loadSession(provider, agentSessionId, projectScope)
      return turnEnding(messages)
    },
    taskIdFor: async (sessionId) => (await taskIdForSession(LOCAL_ORGANIZATION_ID, sessionId)) ?? undefined,
    emit: (sessionId, event) => controlPlane.publish(sessionId, event),
    invalidatePlanCaches: (agentSessionId) => controlPlane.invalidatePlanCaches(agentSessionId),
    trackWork: (work) => controlPlane.trackUpdateWork(work),
  }, {
    findPullRequest: async (checkout, projectScope) => {
      if (!checkout.branch) return null
      const host = await codeHostFor(checkout.repoRoot ?? projectScope)
      const pullRequest = host ? await pullRequestForBranch(host, checkout.branch) : undefined
      return pullRequest ? { number: pullRequest.number, url: pullRequest.url } : null
    },
  })
  controlPlane.useOrchestration(orchestrator)
  return orchestrator
}
