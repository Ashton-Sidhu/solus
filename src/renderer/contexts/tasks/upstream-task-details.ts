import type { Task, TaskComment, TaskDetails } from '../../../shared/task-types'
import { z } from 'zod'
import { forwardCompatibleArray } from '@client-core/forward-compat'

const upstreamCommentSchema = z.object({
  id: z.string().optional(),
  author: z.object({ login: z.string().optional() }).nullable().optional(),
  body: z.string(),
  createdAt: z.string(),
})

// Comments decode per element: one reshaped comment from a newer provider
// must drop alone, not blank every comment on the task.
const upstreamTaskSchema = z.object({
  comments: forwardCompatibleArray(upstreamCommentSchema).optional().catch(undefined),
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
