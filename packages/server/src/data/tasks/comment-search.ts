import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import type { TaskCommentHit, TaskCommentSearchQuery } from '@solus/contracts/task-types'
import { holdsEveryWord, markedPassage, queryWords, wordStartIndex } from '@solus/contracts/word-match'
import type { RecordScope } from '../../admission/principal'
import { getDatabase } from '../../db/database'
import { scopeClause } from '../scope'
import { taskComments, tasks } from './schema'

const commentRowSchema = z.object({
  id: z.string(),
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
  const words = queryWords(input.query)
  if (!words.length) return []
  const like = (word: string) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
  const anyWord = sql.join(words.map((word) => sql`LOWER(${taskComments}.body) LIKE ${like(word)} ESCAPE '\\'`), sql` OR `)
  const project = input.projectKey ? sql` AND ${tasks}.project_key = ${input.projectKey}` : sql``
  const rows = commentRowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${taskComments}.id, ${taskComments}.task_id, ${taskComments}.body, ${taskComments}.created_at
    FROM ${taskComments}
    JOIN ${tasks} ON ${tasks}.id = ${taskComments}.task_id
    WHERE ${scopeClause(scope, sql`${tasks}.organization_id`)}${project} AND (${anyWord})
    ORDER BY ${taskComments}.created_at DESC
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
    const lowered = comments.map((comment) => comment.body.toLocaleLowerCase())
    if (!holdsEveryWord(lowered.join('\n'), words)) continue
    // Newest first already; the first comment with the most words wins.
    let best = 0
    let bestCount = -1
    lowered.forEach((body, index) => {
      const count = words.filter((word) => wordStartIndex(body, word) >= 0).length
      if (count > bestCount) { best = index; bestCount = count }
    })
    const comment = comments[best]!
    hits.push({
      taskId,
      commentId: comment.id,
      snippet: markedPassage(comment.body, words, SNIPPET_HIT_OPEN, SNIPPET_HIT_CLOSE),
      createdAt: comment.created_at,
    })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}
