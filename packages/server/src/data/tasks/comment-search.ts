import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import type { TaskCommentHit, TaskCommentSearchQuery } from '@solus/contracts/task-types'
import { SearchQuery } from '@solus/contracts/search-query'
import { getDatabase } from '../../db/database'
import { commentThreads } from '../comments/schema'
import { listTasks, type TaskReader } from './task-store'

const commentRowSchema = z.object({
  thread_id: z.string(),
  task_id: z.string(),
  body: z.string(),
  created_at: z.coerce.number(),
})

/** Comments read for one query at most. A task board holds far fewer. */
const MAX_COMMENTS = 2000
const MAX_HITS = 200

/**
 * The tasks whose comments hold every word of a query
 * (docs/plans/unified-search.md §7). A task's comments are read as one text,
 * as a session's messages are: the words need not share one comment. The
 * passage is the newest comment that holds the most words. The host holds the
 * comments of the tasks that were opened on it, so only those are searched,
 * and only the tasks the reader sees answer. A task has no project of its own,
 * so `projectKey` does not narrow the search.
 */
export async function searchTaskComments(reader: TaskReader, input: TaskCommentSearchQuery): Promise<TaskCommentHit[]> {
  const query = new SearchQuery(input.query)
  if (query.isEmpty) return []
  const like = (word: string) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
  // A coarse first pass in SQL; the word rule decides below.
  const anyWord = sql.join(query.required.map((word) => sql`LOWER(${commentThreads}.body) LIKE ${like(word)} ESCAPE '\\'`), sql` OR `)
  const rows = commentRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${commentThreads}.thread_id, ${commentThreads}.subject_id AS task_id, ${commentThreads}.body, ${commentThreads}.created_at
    FROM ${commentThreads}
    WHERE ${commentThreads}.subject_kind = 'task' AND (${anyWord})
    ORDER BY ${commentThreads}.created_at DESC
    LIMIT ${MAX_COMMENTS}
  `))
  const byTask = new Map<string, z.infer<typeof commentRowSchema>[]>()
  for (const row of rows) {
    const held = byTask.get(row.task_id)
    if (held) held.push(row)
    else byTask.set(row.task_id, [row])
  }
  const visible = new Set((await listTasks(reader, [...byTask.keys()])).map((task) => task.id))
  const hits: TaskCommentHit[] = []
  for (const [taskId, comments] of byTask) {
    if (!visible.has(taskId)) continue
    // Read in their own case: lower-casing first would hide camelCase words.
    if (!query.holdsEveryWord(comments.map((comment) => comment.body).join('\n'))) continue
    // Newest first already; the first comment with the most words wins.
    let best = 0
    let bestCount = -1
    comments.forEach((comment, index) => {
      const count = query.heldWords(comment.body)
      if (count > bestCount) { best = index; bestCount = count }
    })
    const comment = comments[best]!
    hits.push({
      taskId,
      commentId: comment.thread_id,
      snippet: query.passage(comment.body, SNIPPET_HIT_OPEN, SNIPPET_HIT_CLOSE),
      createdAt: comment.created_at,
    })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}
