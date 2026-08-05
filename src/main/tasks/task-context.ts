import type { TaskDetails } from '../../shared/task-types'

/** Render the local task packet appended to the system prompt of every run on a
 *  task-backed session. */
export function formatTaskContext(
  details: TaskDetails,
  parentDetails: TaskDetails | null = null,
): string {
  const { task, comments, attempts } = details
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
      const facts = [attempt.branch, attempt.pr?.url].filter(Boolean).join(' — ')
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
