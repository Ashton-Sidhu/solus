import { cutText } from '@solus/contracts/text-cut'
import type { SessionRuntime } from '../session-runtime'
import { HOST_ACTOR, type AgentVia } from '../../admission/actor'
import { getIndexedSession } from '../../db/session-indexer'
import { ANY_ORGANIZATION, recordScopeOf } from '../../admission/principal'
import { getCodebase } from '../../data/codebases/codebases'
import { taskIdForSession } from '../../data/tasks/task-sessions'
import { codeHostFor, pullRequestForHead, pushHeadFor } from '../../prs/code-host'
import { lastTurnEnding } from './exchange-reports'
import { SessionOrchestrator } from './session-orchestrator'

/** The host's session orchestrator, running its turns on `sessionRuntime` and
 *  hearing back from it through the control plane's hooks. */
export function orchestrateSessions(sessionRuntime: SessionRuntime): SessionOrchestrator {
  const orchestrator = new SessionOrchestrator({
    activeExchangeIdsFor: (sessionId) => sessionRuntime.activeExchangeIdsFor(sessionId),
    queuedExchanges: () => sessionRuntime.scheduler.queuedExchanges(),
    sessionMeta: (sessionId) => getIndexedSession(sessionId),
    // The session that starts another is its first prompt's sender.
    createSession: (order) => {
      const senderSessionId = order.sourceSessionId ?? order.delegation?.parentSessionId
      return sessionRuntime.dispatch.createSession(senderSessionId ? { ...order, sender: { kind: 'agent', ...senderAgent(senderSessionId) } } : order)
    },
    // A prompt one agent sends acts for the person the sender works for; with no sender, the target's.
    promptSession: (sessionId, prompt, delivery, { senderSessionId, ...order }) => sessionRuntime.dispatch.promptSession(sessionId, prompt, delivery, {
      ...order,
      actor: senderSessionId ? sessionRuntime.actorOfSession(senderSessionId) : undefined,
      sender: senderSessionId ? { kind: 'agent', ...senderAgent(senderSessionId) } : undefined,
    }),
    // An agent's stop acts for the person its sender works for, and names the
    // sender, so the stopped turn says an agent ended it. With no sender, the host's.
    stopSession: (id, senderSessionId) => senderSessionId
      ? sessionRuntime.stopSession(id, sessionRuntime.actorOfSession(senderSessionId) ?? HOST_ACTOR, senderAgent(senderSessionId))
      : sessionRuntime.stopSession(id, HOST_ACTOR),
    respondToPermission: (askingSessionId, questionId, optionId, updatedPlan) => sessionRuntime.inputRequests.respondToPermission(askingSessionId, questionId, optionId, updatedPlan, HOST_ACTOR),
    pendingInputEvents: (sessionId) => sessionRuntime.inputRequests.pendingInputEventsForSession(sessionId),
    replaceQueuedPrompt: (sessionId, queueId, text, reportExchangeIds, exchangeIds) => sessionRuntime.scheduler.replaceQueuedPrompt(sessionId, queueId, text, reportExchangeIds, exchangeIds),
    hasQueuedPrompt: (sessionId, queueId) => sessionRuntime.scheduler.hasQueuedPrompt(sessionId, queueId),
    cancelQueuedPrompt: (sessionId, queueId) => sessionRuntime.scheduler.cancelQueued(sessionId, queueId),
    turnEnding: (provider, sessionId, projectScope) => lastTurnEnding((limit) => sessionRuntime.history.loadSession(provider, sessionId, projectScope, limit)),
    turnOrganization: (sessionId) => sessionRuntime.turnOrganization(sessionId),
    codebase: (codebaseId, senderSessionId) => {
      const actor = (senderSessionId ? sessionRuntime.actorOfSession(senderSessionId) : undefined) ?? HOST_ACTOR
      return getCodebase(recordScopeOf(actor.principal), codebaseId)
    },
    taskIdFor: async (sessionId) => (await taskIdForSession(ANY_ORGANIZATION, sessionId)) ?? undefined,
    emit: (sessionId, event) => sessionRuntime.publish(sessionId, event),
    invalidatePlanCaches: (sessionId) => sessionRuntime.history.invalidatePlanCaches(sessionId),
    recordActivity: (subject, actor, kind) => sessionRuntime.recordActivity(subject, actor, kind),
    trackWork: (work) => sessionRuntime.trackUpdateWork(work),
    repliesEnded: (senderSessionId) => sessionRuntime.providerEvents.endBackgroundWait(senderSessionId),
  }, {
    findPullRequest: async (checkout, projectScope) => {
      if (!checkout.branch) return null
      const scope = checkout.repoRoot ?? projectScope
      const host = await codeHostFor(scope)
      const pullRequest = host ? await pullRequestForHead(host, await pushHeadFor(host, scope, checkout.branch)) : undefined
      return pullRequest ? { number: pullRequest.number, url: pullRequest.url } : null
    },
  }, sessionRuntime.runLedger)
  sessionRuntime.useOrchestration(orchestrator)
  return orchestrator
}

/** The agent session that sends a prompt or asks for a stop, named as it reads now. */
function senderAgent(sessionId: string): AgentVia {
  const meta = getIndexedSession(sessionId)
  const agent: AgentVia = { sessionId }
  if (meta?.provider) agent.provider = meta.provider
  const title = meta?.customTitle || meta?.slug || (meta?.firstMessage && cutText(meta.firstMessage, 80))
  if (title) agent.title = title
  return agent
}
