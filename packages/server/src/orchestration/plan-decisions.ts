import { randomUUID } from 'node:crypto'
import type { PlanAnnotations, PlanComment, SessionMeta } from '@solus/contracts/types'
import { extractPlanTitle } from '../agents/plan-text'
import { notifyAnnotationsChanged } from '../annotations/annotation-events'
import { loadAnnotations, saveAnnotations } from '../plans/annotations'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'

/**
 * Files a person's decision on another session's plan on the plan itself, so
 * the plans gallery shows it exactly as a decision taken in that session would.
 * A plan with no tool-use id has nothing to key on and is not annotated.
 */
export async function recordPlanDecision(
  meta: Pick<SessionMeta, 'sessionId' | 'projectPath' | 'cwd'>,
  plan: { planToolUseId?: string; planContent: string },
  status: 'accepted' | 'rejected',
  comment: string | undefined,
): Promise<boolean> {
  if (!plan.planToolUseId) return false
  const existing = await loadAnnotations(LOCAL_ORGANIZATION_ID, meta.sessionId, plan.planToolUseId)
  const title = extractPlanTitle(plan.planContent)
  const thread: PlanComment[] = comment
    // Anchored on the plan's own title line so the note lands somewhere real in
    // the rail; a decision on the whole plan quotes no selection.
    ? [{ id: randomUUID(), selectedText: title, comment, author: 'you', createdAt: Date.now() }]
    : []
  const annotations: PlanAnnotations = {
    version: 1,
    sessionId: meta.sessionId,
    projectPath: existing?.projectPath || meta.projectPath || meta.cwd,
    cwd: existing?.cwd || meta.cwd,
    planToolUseId: plan.planToolUseId,
    title: existing?.title || title,
    status,
    comments: [...(existing?.comments ?? []), ...thread],
    bookmarked: existing?.bookmarked ?? false,
    updatedAt: Date.now(),
  }
  if (existing?.bookmarkedAt !== undefined) annotations.bookmarkedAt = existing.bookmarkedAt
  await saveAnnotations(LOCAL_ORGANIZATION_ID, annotations)
  notifyAnnotationsChanged({ kind: 'plan', targetId: `${meta.sessionId}__${plan.planToolUseId}` })
  return true
}
