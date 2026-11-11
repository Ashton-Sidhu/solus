import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { taskSourceKey } from '@solus/contracts/task-sources'
import { worktreeProjectRoot } from '@solus/contracts/types'
import type { RecordScope } from '../../admission/principal'
import { getDatabase } from '../../db/database'
import { createLogger } from '../../logger'
import { loadProjectConfig } from '../../project-config/project-config'
import { listProjects } from '../../project-config/projects-manifest'
import { resourceLinks } from '../links/schema'
import { scopeClause } from '../scope'
import { moveTask } from './task'
import { linkedPullRequestIsMerged, readTaskLinks, type PrLinkTarget } from './task-links'
import { taskSessions } from './task-sessions'
import { sourceItemsOfTask } from './task-source-store'
import { loadTask } from './task-store'

const log = createLogger('main', 'task-done-on-merge')

export interface MergedPullRequestCompletion {
  /** The code host's `updatedAt` of the merged pull request, for the log. */
  mergedAt: string
  /** Whether a Solus session is still mid-turn. Work merged under a session
   *  that is still working is not finished yet; the next poll asks again. */
  isSessionBusy: (sessionId: string) => boolean
  isMerged?: (target: PrLinkTarget) => Promise<boolean>
}

const taskIdRowSchema = z.object({ task_id: z.string() })

/**
 * Finish the work a merged pull request finished: move each task that links it
 * to the category `done` on its provider.
 *
 * A task is done when every pull request it links is merged. The pull request
 * named here is known merged. A task's other links answer from what PR sync
 * last saw, never from the network; a link it has not seen merged leaves the
 * task alone (`linkedPullRequestIsMerged`).
 *
 * A task has no project of its own. The rule is on for a task when a project
 * of this host (a listed project, or the checkout of one of the task's working
 * sessions) lists a source of the task and does not set `taskDoneOnMerge` to
 * false. A task that no such project lists is left alone: nobody asked Solus
 * to close it.
 *
 * This is the one place the rule lives. Called by the merge handler, which has
 * authoritative success, and by `PrSync` for a merge made outside Solus. A
 * provider that refuses the move is logged, and the other tasks still move.
 */
export async function completeTasksForMergedPullRequest(
  scope: RecordScope,
  repositoryScope: string,
  number: number,
  completion: MergedPullRequestCompletion,
): Promise<string[]> {
  const isMerged = completion.isMerged ?? linkedPullRequestIsMerged
  const db = getDatabase()
  const repository = repositoryScope.toLowerCase()
  const inScope = scopeClause(scope, sql`resource_links.organization_id`)
  // A task links the pull request itself, or reads it through a session that
  // owns the link (docs/plans/session-pull-requests.md).
  const rows = taskIdRowSchema.array().parse(await db.all(sql`
    SELECT DISTINCT resource_links.source_id AS task_id FROM ${resourceLinks}
    WHERE ${inScope} AND resource_links.source_kind = 'task' AND (
      (resource_links.target_kind = 'pr' AND resource_links.target_key = ${String(number)} AND resource_links.target_scope = ${repository})
      OR (resource_links.target_kind = 'session' AND resource_links.relation = 'works-on' AND resource_links.status = 'active'
        AND EXISTS (
          SELECT 1 FROM ${resourceLinks} AS owned
          WHERE owned.source_kind = 'session' AND owned.source_id = resource_links.target_key AND owned.target_kind = 'pr'
            AND owned.relation = 'pull-request' AND owned.status = 'active'
            AND owned.repository = ${repository} AND owned.number = ${number}
        ))
    )
  `))

  const completed: string[] = []
  for (const { task_id: taskId } of rows) {
    const task = await loadTask(taskId)
    // A task this host never read has no copy to judge, and no source that a project lists.
    if (!task || task.category === 'done') continue
    const working = ((await taskSessions(scope, taskId))[taskId] ?? []).filter((link) => link.role !== 'referenced')
    if (working.some((link) => completion.isSessionBusy(link.sessionId))) continue
    if (!(await doneOnMergeApplies(taskId, working.flatMap((link) => link.checkoutPath && !link.executionServerId ? [link.checkoutPath] : [])))) continue
    const others = (await readTaskLinks(db, scope, taskId)).flatMap((link) => {
      if (link.kind !== 'pr') return []
      const linkedNumber = Number(link.targetKey)
      if (!Number.isSafeInteger(linkedNumber) || linkedNumber <= 0) return []
      if (linkedNumber === number && link.targetScope === repository) return []
      return [{ projectScope: link.targetScope, number: linkedNumber }]
    })
    let allMerged = true
    for (const other of others) {
      if (await isMerged(other)) continue
      allMerged = false
      break
    }
    if (!allMerged) continue
    try {
      await moveTask(taskId, { category: 'done' })
      completed.push(taskId)
    } catch (error) {
      log.warn('task_done_on_merge_failed', { taskId, repository, number, mergedAt: completion.mergedAt, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return completed
}

/** A project of this host, or of one of these checkouts, lists a source of the task and keeps the rule on. */
async function doneOnMergeApplies(taskId: string, checkoutPaths: readonly string[]): Promise<boolean> {
  const taskSources = new Set((await sourceItemsOfTask(taskId)).map((item) => item.sourceKey))
  if (!taskSources.size) return false
  const listed = (await listProjects()).map((project) => project.path)
  for (const root of new Set([...checkoutPaths.map(worktreeProjectRoot), ...listed])) {
    const config = await loadProjectConfig(root)
    if (config?.taskDoneOnMerge === false) continue
    if (config?.taskSources?.some((source) => taskSources.has(taskSourceKey(source)))) return true
  }
  return false
}
