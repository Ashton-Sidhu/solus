import type { TaskDetails, TaskLink, TaskSessionLink } from '../../shared/task-types'

/** Render the local task packet appended to the system prompt of every run on a
 *  task-backed session. Attempts are passed in rather than read off `details`:
 *  session links have exactly one reader, `taskSessions()`, whose join is what
 *  gives each link its display metadata. */
export function formatTaskContext(
  details: TaskDetails,
  parentDetails: TaskDetails | null = null,
  attempts: readonly TaskSessionLink[] = [],
): string {
  const { task, comments } = details
  const lines = [
    `[Working On Task — "${task.title}" (task_id: ${task.id}, status: ${task.status})]`,
  ]

  if (task.projectKey) lines.push(`Project: ${task.projectKey}`)
  if (task.labels.length) lines.push(`Labels: ${task.labels.join(', ')}`)
  if (task.assignee) lines.push(`Assignee: ${task.assignee}`)
  if (task.branch) lines.push(`Branch: ${task.branch}`)
  if (task.pr?.url) lines.push(`Pull request: ${task.pr.url}`)

  if (parentDetails) {
    lines.push(`Parent task: ${parentDetails.task.id} — ${parentDetails.task.title}`)
    const siblings = parentDetails.subtasks.filter((candidate) => candidate.id !== task.id)
    if (siblings.length) {
      lines.push('Sibling subtasks:')
      for (const sibling of siblings) {
        lines.push(`- ${sibling.id} [${sibling.status}] ${sibling.title}`)
      }
    }
  } else if (details.subtasks.length) {
    lines.push('Subtasks:')
    for (const subtask of details.subtasks) {
      lines.push(`- ${subtask.id} [${subtask.status}] ${subtask.title}`)
    }
  }

  if (details.links.length) {
    lines.push('Linked:')
    for (const link of details.links) lines.push(`- ${formatTaskLink(link)}`)
  }

  lines.push('', task.body.trim() || '(no description)')

  if (comments.length) {
    lines.push('', 'Comments:')
    for (const comment of comments) {
      lines.push(`- ${comment.author ?? 'unknown'}: ${comment.body.trim()}`)
    }
  }

  if (attempts.length) {
    lines.push('', 'Prior attempts:')
    for (const attempt of attempts) {
      // The link carries the indexed session name, so say which attempt this
      // was rather than making the agent match a bare UUID against nothing.
      const facts = [attempt.sessionTitle, attempt.branch, attempt.pr?.url]
        .filter(Boolean)
        .join(' — ')
      lines.push(`- session ${attempt.sessionId}${facts ? ` — ${facts}` : ''}`)
    }
  }

  lines.push(
    '',
    'Work contract:',
    '- Keep this task in progress while you work.',
    '- Leave a task comment when blocked or when durable handoff context matters.',
    '- Move the task to in_review when a pull request is ready for a human, or done when the work is complete without review.',
    '',
    `Call read_task with task_id "${task.id}" to refresh this packet; use comment_task and update_task_status for durable write-back.`,
  )

  return lines.join('\n')
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
      return `PR #${link.targetKey} — "${title}"${link.url ? ` — ${link.url}` : ''} (read_pr)`
    case 'automation':
      return `automation ${link.targetKey} — "${title}"${status} (read_automation)`
  }
}
