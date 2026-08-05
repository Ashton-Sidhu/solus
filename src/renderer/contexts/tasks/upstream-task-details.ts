import type { Task, TaskComment, TaskDetails, TaskSessionLink } from '../../../shared/task-types'

interface UpstreamComment {
  id?: unknown
  author?: { login?: unknown } | null
  body?: unknown
  createdAt?: unknown
}

function upstreamComments(task: Task): TaskComment[] {
  const raw = task.raw as { comments?: unknown } | null | undefined
  if (!Array.isArray(raw?.comments)) return []

  return raw.comments.flatMap((value, index) => {
    const comment = value as UpstreamComment
    if (typeof comment.body !== 'string' || typeof comment.createdAt !== 'string') return []
    const createdAt = Date.parse(comment.createdAt)
    if (Number.isNaN(createdAt)) return []
    return [{
      id: typeof comment.id === 'string' ? comment.id : `${task.providerId}:${task.id}:${index}`,
      taskId: task.id,
      author: typeof comment.author?.login === 'string' ? comment.author.login : null,
      source: 'external' as const,
      externalId: typeof comment.id === 'string' ? comment.id : null,
      body: comment.body,
      createdAt,
    }]
  })
}

/** Adapt a hydrated provider ticket to the local task page's detail contract. */
export function upstreamTaskDetails(
  task: Task,
  knownTasks: Task[],
  attempts: TaskSessionLink[],
): TaskDetails {
  const childIds = new Set(task.childIds ?? [])
  return {
    task,
    subtasks: knownTasks.filter((candidate) =>
      candidate.parentId === task.id || childIds.has(candidate.id)),
    comments: upstreamComments(task),
    attempts,
    links: [],
    events: [],
  }
}
