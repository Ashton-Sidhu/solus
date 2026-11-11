import { clip } from '@solus/contracts/session-exchange'
import type { TaskEpic, TaskLink } from '@solus/contracts/task-types'
import type { AgentTaskLifecyclePolicy } from '@solus/contracts/types'

/** Characters of the epic's description read_task returns. The epic is
 *  context for this task, not the work itself; the agent can open the url. */
const EPIC_BODY_LIMIT = 2000

/** Render the task packet appended to the system prompt of every run on a
 *  task-backed session. It names the task and the rules the agent works under,
 *  and nothing that changes while the agent works: the state, body, comments
 *  and links come from read_task, once, into the transcript. A packet that
 *  changed on every status move or comment would re-send the whole cached
 *  prompt. The title is absent when the task cannot be read; the id still
 *  names it. It carries no lead contract: the lead contract is session-owned
 *  (data/sessions/lead-contract.ts) and does not come from a task. */
export function formatTaskContext(
  task: { id: string; title?: string },
  lifecyclePolicy: AgentTaskLifecyclePolicy = 'moderate',
): string {
  const title = task.title ? ` — "${task.title}"` : ''
  return [
    `[Working On Task${title} (task_id: ${task.id})]`,
    `Call read_task with task_id "${task.id}" before you start work. It returns the description, state, columns, comments, epic, and linked items. Call it again only to refresh them. It lists session IDs; use read_session for the status and history of a prior attempt.`,
    '',
    'Work contract:',
    ...workContract(lifecyclePolicy),
  ].join('\n')
}

/** The rules the agent works under, from the lifecycle policy. */
function workContract(lifecyclePolicy: AgentTaskLifecyclePolicy): string[] {
  const lines: string[] = []
  if (lifecyclePolicy === 'none') {
    lines.push(
      '- Do not change this task\'s status. The user controls its lifecycle.',
      '- Leave a task comment when blocked or when durable handoff context matters.',
      '- comment_task posts on GitHub or Jira. Use it for durable write-back.',
    )
  } else if (lifecyclePolicy === 'moderate') {
    lines.push(
      '- Keep this task active while you work.',
      '- Leave a task comment when blocked or when durable handoff context matters.',
      '- When a pull request is ready for a human, move the task to the review column of its board, if read_task shows one. Do not move it to done; the user closes completed work.',
      '- comment_task and update_task_status write to GitHub or Jira. Use them for permitted durable write-back.',
    )
  } else {
    lines.push(
      '- Keep this task active while you work.',
      '- Leave a task comment when blocked or when durable handoff context matters.',
      '- When a pull request is ready for a human, move the task to the review column of its board, if read_task shows one. Move it to done when the work is complete without review.',
      '- comment_task and update_task_status write to GitHub or Jira. Use them for durable write-back.',
    )
  }
  return lines
}

/** The epic this task belongs to: one line that names it, then its
 *  description on one indented line, clipped. */
export function formatTaskEpic(epic: TaskEpic): string[] {
  const ref = /^\d+$/.test(epic.externalId) ? `#${epic.externalId}` : epic.externalId
  const lines = [`Epic: ${epic.provider} ${ref} — "${epic.title}" — ${epic.url}`]
  const body = clip(epic.body, EPIC_BODY_LIMIT)
  if (body) lines.push(`  ${body}`)
  return lines
}

/** One linked item as the agent should address it: the id its read tool takes,
 *  the human title, and the live status when the link carries one. */
export function formatTaskLink(link: TaskLink): string {
  const title = link.liveTitle ?? link.title
  const status = link.liveStatus ? ` [${link.liveStatus}]` : ''
  switch (link.kind) {
    case 'work':
      return `work ${link.targetKey} — "${title}"${status} (read_work)`
    case 'plan':
      return `plan ${link.targetScope}__${link.targetKey} — "${title}"${status} (read_plan with session_id "${link.targetScope}")`
    case 'pr':
      // No Solus tool reads a pull request; the code host's own CLI does.
      return `PR #${link.targetKey} — "${title}"${link.url ? ` — ${link.url}` : ''} (gh pr view ${link.targetKey})`
    case 'automation':
      return `automation ${link.targetKey} — "${title}"${status} (read_automation)`
  }
}
