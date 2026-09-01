import { createLogger } from '../logger'
import { loadWork } from '../folio/works'
import { findSession, getSessionController } from '../sessions/session-tools'
import type { TaskLinkedItemSnapshot, TaskSnapshot } from '@solus/contracts/task-types'

const log = createLogger('main', 'linked-content.ts')

/**
 * Attach the full content of a snapshot's content-bearing linked items (works,
 * plans) before it ships to a dispatched session — the execution host cannot
 * read this host's folio store or provider session files, so the shipped copy
 * is the only way `read_work`/`read_plan` can answer there
 * (docs/plans/dispatch-parity.md). PR and automation links ship nothing extra:
 * their facts already ride `details.links`.
 *
 * Best effort per item: a work or plan that no longer resolves is skipped with
 * a log line, never allowed to fail the prompt that ships the snapshot.
 */
export async function attachLinkedContent(snapshot: TaskSnapshot): Promise<TaskSnapshot> {
  const linked: TaskLinkedItemSnapshot[] = []
  for (const link of snapshot.details.links) {
    if (link.kind === 'work') {
      const work = await loadWork(link.targetKey).catch(() => null)
      if (!work) {
        log.warn('linked_work_unreadable', { taskId: snapshot.details.task.id, workId: link.targetKey })
        continue
      }
      linked.push({
        kind: 'work',
        key: work.id,
        scope: '',
        title: work.title,
        workType: work.type,
        content: work.content,
        updatedAt: work.updatedAt,
      })
    }
    if (link.kind === 'plan') {
      const content = await loadLinkedPlan(link.targetScope, link.targetKey)
      if (content === null) {
        log.warn('linked_plan_unreadable', {
          taskId: snapshot.details.task.id,
          planSessionId: link.targetScope,
          planToolUseId: link.targetKey,
        })
        continue
      }
      linked.push({
        kind: 'plan',
        key: link.targetKey,
        scope: link.targetScope,
        title: link.liveTitle ?? link.title,
        content,
      })
    }
  }
  return linked.length ? { ...snapshot, linked } : snapshot
}

/** A plan's markdown, read through the same controller path `read_plan` uses. */
async function loadLinkedPlan(sessionId: string, planToolUseId: string): Promise<string | null> {
  const controller = getSessionController()
  if (!controller || !sessionId || !planToolUseId) return null
  const meta = await findSession(sessionId)
  if (!meta) return null
  return controller.loadPlanContent(meta.provider, sessionId, meta.projectPath || meta.cwd, planToolUseId)
}
