import { sql } from 'drizzle-orm'
import { taskKey, taskSourceKey, type TaskSource } from '@solus/contracts/task-sources'
import type { Task } from '@solus/contracts/task-types'
import type { Db } from '../../db/database'
import { taskSourceItems, taskSources, tasks } from './schema'
import { loadTaskSources, sourceItemsOf, sourceItemsOfTask, type StoredTaskSource } from './task-source-store'
import { database, loadTask, pruneUnheldTasks, UNHELD_TASK_MAX_AGE_MS, refreshTaskCategories, storedTaskIds, upsertProviderTask, type TaskCategoryChange } from './task-store'
import type { TaskAssignment } from './task-assignment'
import { settleTaskSessions } from './task-settle'
import type { ProviderTask, SourceRead } from './providers/types'

/**
 * The writes of the task cache. A provider answer is the only thing that
 * changes a task's copy: a read of a source, a read of one task, or the answer
 * of a write that the provider took. Each write here also keeps `Task.category`
 * right and settles or reopens the task's sessions when it becomes or stops
 * being `done`.
 */

/**
 * The column of a task in a source whose columns are the task's own state: a
 * repository (`Open` / `Closed`), a Jira project (the status), a Jira board
 * (the column that lists the status). Undefined for a GitHub Project: its
 * column is a field of the board item, which a read of the task does not give.
 */
export function stateColumnOf(source: StoredTaskSource, task: ProviderTask): string | null | undefined {
  switch (source.source.kind) {
    case 'github-repo':
      return task.state.category === 'done' ? 'closed' : 'open'
    case 'jira-project':
      return task.stateId ?? null
    case 'jira-board': {
      if (source.writeState?.kind !== 'jira-board' || !task.stateId) return null
      const stateId = task.stateId
      return source.writeState.columns.find((column) => column.statusIds.includes(stateId))?.columnId ?? null
    }
    case 'github-project':
      return undefined
  }
}

/** Put a task in the columns its new state gives, in each source that lists it. */
async function followState(db: Db, task: ProviderTask): Promise<void> {
  const taskId = taskKey(task.ref)
  const items = await sourceItemsOfTask(taskId, db)
  const sources = await loadTaskSources(items.map((item) => item.sourceKey), db)
  for (const item of items) {
    const source = sources.get(item.sourceKey)
    const columnId = source ? stateColumnOf(source, task) : undefined
    if (columnId === undefined || columnId === item.columnId) continue
    await db.run(sql`
      UPDATE ${taskSourceItems} SET column_id = ${columnId} WHERE source_key = ${item.sourceKey} AND task_id = ${taskId}
    `)
  }
}

export interface StoreTaskOptions {
  /** The answer is a read of the task with its comments. */
  detail?: boolean
  /** Also put the task in this source: a task that a write just created or moved there. */
  place?: { sourceKey: string; columnId: string | null; itemId: string | null }
}

/** Write the provider's answer for one task over the host's copy, and answer the copy. */
export async function storeProviderTask(task: ProviderTask, options: StoreTaskOptions = {}): Promise<Task> {
  const taskId = taskKey(task.ref)
  const now = Date.now()
  const changes = await database().transaction(async (db) => {
    const created = !(await storedTaskIds(db, [taskId])).has(taskId)
    await upsertProviderTask(db, task, now)
    if (options.detail) await db.run(sql`UPDATE ${tasks} SET detail_fetched_at = ${now} WHERE id = ${taskId}`)
    await followState(db, task)
    if (options.place) {
      const { sourceKey, columnId, itemId } = options.place
      await db.run(sql`
        INSERT INTO ${taskSourceItems}(source_key, task_id, column_id, item_id, position)
        VALUES (${sourceKey}, ${taskId}, ${columnId}, ${itemId},
          COALESCE((SELECT MIN(position) FROM ${taskSourceItems} WHERE source_key = ${sourceKey}), 0) - 1)
        ON CONFLICT(source_key, task_id) DO UPDATE SET column_id = excluded.column_id, item_id = COALESCE(excluded.item_id, task_source_items.item_id)
      `)
    }
    return refreshTaskCategories(db, [taskId], created ? new Set([taskId]) : undefined)
  })
  await settleTaskSessions(changes)
  const stored = await loadTask(taskId)
  if (!stored) throw new Error(`Task ${taskId} was not stored.`)
  return stored
}

/** What one read of a source changed in the cache. */
export interface StoredSourceRead {
  /** Each task whose row in a list changed, and the tasks that left the source. */
  changed: string[]
  /** Each task the host had a copy of whose assignee changed, with the new assignee. */
  assigned: TaskAssignment[]
}

/**
 * Write one read of a source over the cache: its tasks, where it puts each
 * one, and its own label and columns. The items of the source are replaced, so
 * a task the source does not list any more leaves it; its copy is deleted when
 * nothing else holds it, and so is each old copy that nothing holds, such as a
 * task that only a search found (`pruneUnheldTasks`).
 */
export async function storeSourceRead(source: TaskSource, read: SourceRead, now = Date.now()): Promise<StoredSourceRead> {
  const sourceKey = taskSourceKey(source)
  const changed = new Set<string>()
  const assigned: TaskAssignment[] = []
  let categoryChanges: TaskCategoryChange[] = []
  await database().transaction(async (db) => {
    const before = new Map((await sourceItemsOf(sourceKey, db)).map((item) => [item.taskId, item.columnId]))
    const taskIds = read.items.map((item) => taskKey(item.task.ref))
    const stored = await storedTaskIds(db, taskIds)
    const created = new Set(taskIds.filter((taskId) => !stored.has(taskId)))
    await db.run(sql`DELETE FROM ${taskSourceItems} WHERE source_key = ${sourceKey}`)
    const placed = new Set<string>()
    for (const [position, item] of read.items.entries()) {
      const taskId = taskKey(item.task.ref)
      // A provider can list one task two times; the first place stands.
      if (placed.has(taskId)) continue
      placed.add(taskId)
      const upsert = await upsertProviderTask(db, item.task, now)
      if (upsert.changed) changed.add(taskId)
      if (upsert.previousAssignee !== undefined && item.task.assignee && item.task.assignee !== upsert.previousAssignee) {
        assigned.push({ taskId, title: item.task.title, provider: item.task.ref.provider, assignee: item.task.assignee, updatedAt: item.task.updatedAt })
      }
      if (!before.has(taskId) || before.get(taskId) !== item.columnId) changed.add(taskId)
      await db.run(sql`
        INSERT INTO ${taskSourceItems}(source_key, task_id, column_id, item_id, position)
        VALUES (${sourceKey}, ${taskId}, ${item.columnId}, ${item.itemId}, ${position})
      `)
    }
    for (const taskId of before.keys()) if (!placed.has(taskId)) changed.add(taskId)
    await db.run(sql`
      INSERT INTO ${taskSources}(source_key, source, label, columns, write_state, fetched_at, truncated)
      VALUES (${sourceKey}, ${JSON.stringify(source)}, ${read.label}, ${JSON.stringify(read.columns)},
        ${read.writeState ? JSON.stringify(read.writeState) : null}, ${now}, ${read.truncated ? 1 : 0})
      ON CONFLICT(source_key) DO UPDATE SET
        label = excluded.label, columns = excluded.columns, write_state = excluded.write_state,
        fetched_at = excluded.fetched_at, truncated = excluded.truncated
    `)
    // The columns of the source can change the category of a task that left it too.
    categoryChanges = await refreshTaskCategories(db, [...placed, ...before.keys()], created)
    const pruned = new Set(await pruneUnheldTasks(db, [...before.keys()].filter((taskId) => !placed.has(taskId)), now - UNHELD_TASK_MAX_AGE_MS))
    for (const taskId of pruned) changed.add(taskId)
    categoryChanges = categoryChanges.filter((change) => !pruned.has(change.taskId))
  })
  for (const change of categoryChanges) changed.add(change.taskId)
  await settleTaskSessions(categoryChanges)
  return { changed: [...changed], assigned }
}

/**
 * Set the column of a task in one source, after the provider took the move.
 * A draft item has no state of its own: its state is its column.
 */
export async function storeTaskColumn(taskId: string, sourceKey: string, columnId: string): Promise<void> {
  const changes = await database().transaction(async (db) => {
    await db.run(sql`
      UPDATE ${taskSourceItems} SET column_id = ${columnId} WHERE source_key = ${sourceKey} AND task_id = ${taskId}
    `)
    const column = (await loadTaskSources([sourceKey], db)).get(sourceKey)?.columns.find((candidate) => candidate.id === columnId)
    if (column) {
      await db.run(sql`
        UPDATE ${tasks} SET state_name = ${column.name}, state_category = ${column.category} WHERE id = ${taskId} AND kind = 'draft'
      `)
    }
    return refreshTaskCategories(db, [taskId])
  })
  await settleTaskSessions(changes)
}
