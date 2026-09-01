import { getDb } from '../db'
import { resolveProjectKey } from '../project-config/project-config'
import type { TaskSessionLink } from '../../shared/task-types'

// task ↔ session links are a Solus-local concept (the relationship between a
// ticket and the agent run working on it), so they live in our own store rather
// than being written upstream — that keeps GitHub authoritative for content and
// works identically for the local provider. Mirrors the bound-work model, but
// the reverse map (task → sessions) is the durable bit: a session's `boundTaskId`
// is renderer state that resets on reload, whereas this survives so the card can
// always show "has an active session" and link back to it.
/** Record that `sessionId` was started from `taskId` in this project. Idempotent
 *  — re-linking the same pair just refreshes its timestamp so ordering stays
 *  most-recent-last. */
export async function linkTaskSession(cwd: string, taskId: string, sessionId: string): Promise<void> {
  const projectKey = resolveProjectKey(cwd)
  getDb().prepare(`
    INSERT INTO task_session_links(task_id, session_id, project_key, linked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id, session_id) DO UPDATE SET
      project_key = excluded.project_key,
      linked_at = excluded.linked_at
  `).run(taskId, sessionId, projectKey, Date.now())
}

/** All task → session links for a project, so the renderer can mark which tasks
 *  have live work and offer a jump-back. Empty when nothing's been linked yet. */
export async function taskSessions(cwd: string): Promise<Record<string, TaskSessionLink[]>> {
  const projectKey = resolveProjectKey(cwd)
  const rows = getDb().prepare(`
    SELECT task_id, session_id, linked_at
    FROM task_session_links
    WHERE project_key = ?
    ORDER BY rowid
  `).all(projectKey) as Array<{ task_id: string; session_id: string; linked_at: number }>
  const links: Record<string, TaskSessionLink[]> = {}
  for (const row of rows) {
    const taskLinks = links[row.task_id] ?? []
    taskLinks.push({ sessionId: row.session_id, linkedAt: row.linked_at })
    links[row.task_id] = taskLinks
  }
  return links
}
