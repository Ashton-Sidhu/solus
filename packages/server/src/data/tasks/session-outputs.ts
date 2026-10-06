import type { TaskLinkInput } from '@solus/contracts/task-types'
import type { RecordScope } from '../../admission/principal'
import { listPlanRefsForSessions } from '../../plans/plan-index'
import { listAutomations } from '../automations/automations-store'
import { listWorkRefsForSessions } from '../works/works'

/**
 * What a session made, as the links a task shows for it
 * (docs/plans/session-outputs.md).
 *
 * A session owns what it makes: each work, plan and automation records the
 * id of the session that made it (docs/plans/session-identity.md). A task
 * shows the outputs of the sessions that work on it, so a session that joins a
 * task brings them. This read is what the join asks.
 */

/**
 * The works, plans and automations a session made. An artifact is not one of
 * them: most are read once, so an artifact is on a task only when its maker
 * asked for that (`link_to_task`).
 */
export async function readSessionOutputs(scope: RecordScope, sessionId: string): Promise<TaskLinkInput[]> {
  const [works, plans, automations] = await Promise.all([
    listWorkRefsForSessions(scope, [sessionId]),
    listPlanRefsForSessions(scope, [sessionId]),
    listAutomations(),
  ])
  return [
    ...works.filter((work) => work.type !== 'artifact')
      .map((work): TaskLinkInput => ({ kind: 'work', targetKey: work.id, title: work.title })),
    ...plans.map((plan): TaskLinkInput => ({
      kind: 'plan', targetScope: plan.sessionId, targetKey: plan.planToolUseId, title: plan.title,
    })),
    ...automations
      .filter(({ createdBy }) => createdBy.kind === 'agent' && createdBy.sessionId === sessionId)
      .map((automation): TaskLinkInput => ({ kind: 'automation', targetKey: automation.id, title: automation.name })),
  ]
}
