import type { Task, TaskComment, TaskDetails } from '../../../shared/task-types'
import { z } from 'zod'

const upstreamTaskSchema = z.object({
  comments: z.array(z.object({
    id: z.string().optional(),
    author: z.object({ login: z.string().optional() }).nullable().optional(),
    body: z.string(),
    createdAt: z.string(),
  })).optional(),
})

function upstreamComments(task: Task): TaskComment[] {
  const parsed = upstreamTaskSchema.safeParse(task.raw)
  if (!parsed.success) return []

  return (parsed.data.comments ?? []).flatMap((comment, index) => {
    const createdAt = Date.parse(comment.createdAt)
    if (Number.isNaN(createdAt)) return []
    return [{
      id: comment.id ?? `${task.providerId}:${task.id}:${index}`,
      taskId: task.id,
      author: comment.author?.login ?? null,
      source: 'external' as const,
      externalId: comment.id ?? null,
      body: comment.body,
      createdAt,
    }]
  })
}

/** Adapt a hydrated provider ticket to the local task page's detail contract. */
export function upstreamTaskDetails(task: Task, knownTasks: Task[]): TaskDetails {
  const childIds = new Set(task.childIds ?? [])
  return {
    task,
    subtasks: knownTasks.filter((candidate) =>
      candidate.parentId === task.id || childIds.has(candidate.id)),
    comments: upstreamComments(task),
    links: [],
    events: [],
  }
}
