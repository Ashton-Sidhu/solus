import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import type { TaskCommentHit, TaskCommentSearchQuery } from '@solus/contracts/task-types'
import { SearchQuery } from '@solus/contracts/search-query'
import type { RecordScope } from '../../admission/principal'
import { getDatabase } from '../../db/database'
import { scopeClause } from '../scope'
import { commentThreads } from '../comments/schema'
import { tasks } from './schema'
import { TASK_HERE } from './task-store'

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
 * passage is the newest comment that holds the most words. Only Solus comments
 * are stored on the host; an upstream provider's comments are not searched.
 */
export async function searchTaskComments(scope: RecordScope, input: TaskCommentSearchQuery): Promise<TaskCommentHit[]> {
  const query = new SearchQuery(input.query)
  if (query.isEmpty) return []
  const like = (word: string) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
  // A coarse first pass in SQL; the word rule decides below.
  const anyWord = sql.join(query.required.map((word) => sql`LOWER(${commentThreads}.body) LIKE ${like(word)} ESCAPE '\\'`), sql` OR `)
  const project = input.projectKey ? sql` AND ${tasks}.project_key = ${input.projectKey}` : sql``
  const rows = commentRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${commentThreads}.thread_id, ${commentThreads}.subject_id AS task_id, ${commentThreads}.body, ${commentThreads}.created_at
    FROM ${commentThreads}
    JOIN ${tasks} ON ${tasks}.id = ${commentThreads}.subject_id AND ${tasks}.organization_id = ${commentThreads}.organization_id
    WHERE ${commentThreads}.subject_kind = 'task'
      AND ${scopeClause(scope, sql`${tasks}.organization_id`)} AND ${TASK_HERE}${project} AND (${anyWord})
    ORDER BY ${commentThreads}.created_at DESC
    LIMIT ${MAX_COMMENTS}
  `))
  const byTask = new Map<string, z.infer<typeof commentRowSchema>[]>()
  for (const row of rows) {
    const held = byTask.get(row.task_id)
    if (held) held.push(row)
    else byTask.set(row.task_id, [row])
  }
  const hits: TaskCommentHit[] = []
  for (const [taskId, comments] of byTask) {
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
