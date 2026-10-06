import { randomUUID } from 'node:crypto'
import type { PlanAnnotations, PlanComment, SessionMeta } from '@solus/contracts/types'
import type { Attribution } from '@solus/contracts/user'
import { extractPlanTitle } from '../agents/plan-text'
import { notifyAnnotationsChanged } from '../../annotations/annotation-events'
import { loadAnnotations, saveAnnotations } from '../../plans/annotations'
import { ANY_ORGANIZATION } from '../../admission/principal'

/**
 * Files a person's decision on another session's plan on the plan itself, so
 * the plans gallery shows it exactly as a decision taken in that session would.
 * A plan with no tool-use id has nothing to key on and is not annotated.
 */
export async function recordPlanDecision(
  sessionId: string,
  meta: Pick<SessionMeta, 'projectPath' | 'cwd'>,
  plan: { planToolUseId?: string; planContent: string },
  status: 'accepted' | 'rejected',
  comment: string | undefined,
  /** Who decided: the note is theirs. */
  by: Attribution,
): Promise<boolean> {
  if (!plan.planToolUseId) return false
  const existing = await loadAnnotations(ANY_ORGANIZATION, sessionId, plan.planToolUseId)
  const title = extractPlanTitle(plan.planContent)
  const thread: PlanComment[] = comment
    // Anchored on the plan's own title line so the note lands somewhere real in
    // the rail; a decision on the whole plan quotes no selection.
    ? [{ id: randomUUID(), selectedText: title, comment, author: by, createdAt: Date.now() }]
    : []
  const annotations: PlanAnnotations = {
    version: 1,
    sessionId,
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
  await saveAnnotations(ANY_ORGANIZATION, annotations)
  notifyAnnotationsChanged({ kind: 'plan', targetId: `${sessionId}__${plan.planToolUseId}` })
  return true
}
