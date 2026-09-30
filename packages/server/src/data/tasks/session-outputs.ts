import type { TaskLinkInput } from '@solus/contracts/task-types'
import type { RecordScope } from '../../admission/principal'
import { listPlanRefsForSessions } from '../../plans/plan-index'
import { listAutomations } from '../automations/automations-store'
import { resolveSessionLineageById, stableSessionIdForProviderThread } from '../sessions/session-lineage'
import { listWorkRefsForSessions } from '../works/works'

/**
 * What a session made, as the links a task shows for it
 * (docs/plans/session-outputs.md).
 *
 * A session owns what it makes: each work, plan and automation records the
 * session that made it. A task shows the outputs of the sessions that work on
 * it, so a session that joins a task brings them. This read is what the join
 * asks.
 */

/**
 * Every id one session is known by: Solus's session id, and each provider
 * thread of its lineage. A work and a plan record the provider thread; a task
 * records either.
 */
function sessionIdForms(sessionId: string): string[] {
  const stableSessionId = stableSessionIdForProviderThread(sessionId) ?? sessionId
  const threads = resolveSessionLineageById(stableSessionId)?.members.map((member) => member.providerSessionId) ?? []
  return [...new Set([sessionId, stableSessionId, ...threads].filter((id): id is string => !!id))]
}

/**
 * The works, plans and automations a session made. An artifact is not one of
 * them: most are read once, so an artifact is on a task only when its maker
 * asked for that (`link_to_task`).
 */
export async function readSessionOutputs(scope: RecordScope, sessionId: string): Promise<TaskLinkInput[]> {
  const sessionIds = sessionIdForms(sessionId)
  const [works, plans, automations] = await Promise.all([
    listWorkRefsForSessions(scope, sessionIds),
    listPlanRefsForSessions(scope, sessionIds),
    listAutomations(),
  ])
  return [
    ...works.filter((work) => work.type !== 'artifact')
      .map((work): TaskLinkInput => ({ kind: 'work', targetKey: work.id, title: work.title })),
    ...plans.map((plan): TaskLinkInput => ({
      kind: 'plan', targetScope: plan.sessionId, targetKey: plan.planToolUseId, title: plan.title,
    })),
    ...automations
      .filter(({ createdBy }) => createdBy.kind === 'agent' && sessionIds.includes(createdBy.sessionId))
      .map((automation): TaskLinkInput => ({ kind: 'automation', targetKey: automation.id, title: automation.name })),
  ]
}
