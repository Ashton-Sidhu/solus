import { sql } from 'drizzle-orm'
import { parseTaskKey, taskKey, taskSourceKey, type TaskRef, type TaskSource, type TaskStatusCategory } from '@solus/contracts/task-sources'
import type {
  Task,
  TaskAssigneeCandidate,
  TaskCreateInput,
  TaskDetails,
  TaskField,
  TaskMoveTarget,
  TaskSnapshot,
  TaskSummary,
  TaskUpdatePatch,
} from '@solus/contracts/task-types'
import type { RecordScope } from '../../admission/principal'
import { createLogger } from '../../logger'
import { deleteActivityFor } from '../activity/activity'
import { deleteThreadsOf } from '../comments/comment-threads'
import { deleteEdgesOf } from '../links/resource-links'
import { personalResourceState } from '../personal-state/schema'
import { removeNotificationsFor } from '../notifications/store'
import { LOCAL_ORGANIZATION_ID } from '../../host/host-category'
import { taskWriteError } from './providers/failures'
import { taskAdapters } from './providers/registry'
import type { ProviderTask, TaskHome } from './providers/types'
import { taskSourceItems, tasks } from './schema'
import { assetReferencesIn } from './task-assets'
import { notifyTaskAssignments } from './task-assignment'
import { taskAttachments } from './task-attachments'
import { stateColumnOf, storeProviderTask, storeTaskColumn } from './task-cache'
import {
  commentsForTask,
  discardUnsentComment,
  hasComment,
  markCommentFailed,
  markCommentSent,
  requireUnsentComment,
  storeProviderComments,
  storeSentComment,
  storeUnsentComment,
  taskThreads,
  type NewTaskComment,
} from './task-comments'
import { taskSessions } from './task-sessions'
import { loadTaskSource, loadTaskSources, sourceItemsOfTask, type StoredTaskSource } from './task-source-store'
import { readTaskSource } from './task-sources'
import { database, emitChanged, loadTask, loadTaskSummaries, taskHomeOf } from './task-store'

/**
 * The task itself, as GitHub or Jira owns it
 * (docs/plans/provider-owned-tasks.md §5). A read asks the provider and writes
 * the answer over the host's copy. A write goes to the provider first: on
 * success the copy takes the provider's answer and clients are told; on
 * failure the caller gets the error and the copy does not change. There is no
 * local write that waits for the provider, except a comment that was not sent.
 *
 * What Solus owns about a task (session links, links, snoozes) is in
 * `task-attachments.ts` and needs no copy of the task.
 */

const log = createLogger('main', 'task')

function refOf(taskId: string): TaskRef {
  const ref = parseTaskKey(taskId)
  if (!ref) throw new Error(`"${taskId}" is not a task of GitHub or Jira.`)
  return ref
}

/** Read one task from its provider with its comments, and write it over the host's copy. */
async function fetchTask(taskId: string): Promise<Task> {
  const ref = refOf(taskId)
  const answer = await taskAdapters().provider(ref.provider).fetch(ref)
  const task = await storeProviderTask(answer.task, { detail: true })
  await database().transaction((db) => storeProviderComments(db, taskId, answer.comments, answer.commentsTruncated))
  return task
}

/** The host's copy of a task; a task the host never read is read from its provider first. */
export async function cachedTask(taskId: string): Promise<Task> {
  return await loadTask(taskId) ?? await fetchTask(taskId)
}

/** The copy and what the adapter needs to write to it. */
async function writableTask(taskId: string): Promise<{ task: Task; home: TaskHome }> {
  const task = await cachedTask(taskId)
  const home = await taskHomeOf(taskId)
  if (!home) throw new Error(`Solus cannot write to task ${task.reference ?? taskId}: read it again.`)
  return { task, home }
}

/** The host's copy of a task with its comments and its attachments in `scope`. */
export async function taskDetails(scope: RecordScope, taskId: string): Promise<TaskDetails> {
  const task = await loadTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found.`)
  return { task, comments: await commentsForTask(taskId), ...await taskAttachments(scope, taskId) }
}

/**
 * Read one task from its provider, with its comments and its attachments on
 * this host. When the provider does not answer and the host has a copy, the
 * answer is that copy with `fromCache`. `personKey` is the person who reads:
 * they are told when the read shows that the task became theirs.
 */
export async function getTask(scope: RecordScope, taskId: string, personKey?: string): Promise<TaskDetails> {
  const before = await loadTask(taskId)
  try {
    const task = await fetchTask(taskId)
    if (!before || before.updatedAt !== task.updatedAt || before.category !== task.category) emitChanged(taskId)
    if (personKey && before && task.assignee && task.assignee !== before.assignee) {
      const assignment = { taskId, title: task.title, provider: task.providerId, assignee: task.assignee, updatedAt: task.updatedAt }
      await notifyTaskAssignments([assignment], personKey).catch((error) => {
        log.warn('task_assignment_notify_failed', { taskId, error: error instanceof Error ? error.message : String(error) })
      })
    }
    return await taskDetails(scope, taskId)
  } catch (error) {
    if (!before) throw taskWriteError(error)
    log.warn('task_read_from_cache', { taskId, error: error instanceof Error ? error.message : String(error) })
    return { ...await taskDetails(scope, taskId), fromCache: true }
  }
}

/** What a dispatched prompt carries: the task as the host holds it, read on the
 * task's own host (docs/plans/dispatch-parity.md). The RPC layer attaches the
 * content of linked items (`attachLinkedContent`) before it ships. */
export async function taskSnapshot(scope: RecordScope, taskId: string): Promise<TaskSnapshot> {
  await cachedTask(taskId)
  return { details: await taskDetails(scope, taskId), sessions: (await taskSessions(scope, taskId))[taskId] ?? [] }
}

const PATCH_FIELDS: TaskField[] = ['title', 'body', 'labels', 'assignee', 'priority', 'dueDate']
const FIELD_NAMES = {
  title: 'the title',
  body: 'the description',
  labels: 'labels',
  assignee: 'the assignee',
  priority: 'the priority',
  dueDate: 'the due date',
} satisfies Record<TaskField, string>

/** Refuse a body with a local asset that the provider cannot hold for this task: it could never be sent. */
function assertPublishable(home: TaskHome, body: string): void {
  const blocked = taskAdapters().provider(home.provider).unpublishableAssets(home, body)
  if (!blocked.length) return
  const where = home.provider === 'jira' ? 'Jira' : home.kind === 'draft' ? 'A GitHub draft item' : 'GitHub'
  throw new Error(`${where} cannot hold .${blocked[0].extension} attachments. Remove the file, or add it on the provider.`)
}

/** The body to send: its local assets are uploaded to the provider first. */
async function publishedBody(home: TaskHome, body: string): Promise<string> {
  if (!assetReferencesIn(body).length) return body
  assertPublishable(home, body)
  const provider = taskAdapters().provider(home.provider)
  return provider.publishAssets(home, body)
}

/** Change a task's fields on the provider. A field the provider does not take for this task is refused. */
export async function updateTask(taskId: string, patch: TaskUpdatePatch): Promise<Task> {
  const { task, home } = await writableTask(taskId)
  const fields = PATCH_FIELDS.filter((field) => patch[field] !== undefined)
  if (!fields.length) return task
  const refused = fields.find((field) => !task.writableFields.includes(field))
  if (refused) throw new Error(`${task.reference ?? 'This task'} does not take a change of ${FIELD_NAMES[refused]} from Solus.`)
  if (patch.title !== undefined && !patch.title.trim()) throw new Error('Task title cannot be empty.')
  let updated: ProviderTask
  try {
    const body = patch.body === undefined ? undefined : await publishedBody(home, patch.body)
    updated = await taskAdapters().provider(home.provider).update(home, body === undefined ? patch : { ...patch, body })
  } catch (error) {
    throw taskWriteError(error)
  }
  const stored = await storeProviderTask(updated)
  emitChanged(taskId)
  return stored
}

/** The first column of a source that has the category: where a move to a category puts a board item. */
function firstColumnOf(source: StoredTaskSource, category: TaskStatusCategory): string | null {
  return source.columns.find((column) => column.category === category)?.id ?? null
}

/**
 * Move a task to one column of one source that lists it, or to a status
 * category. For a category the host chooses: a GitHub issue is closed or
 * reopened, and each GitHub Project that lists the task gets its first column
 * of that category; a Jira issue makes a legal transition to a status of that
 * category, and fails loudly when there is none.
 */
export async function moveTask(taskId: string, target: TaskMoveTarget): Promise<Task> {
  const { task, home } = await writableTask(taskId)
  const items = await sourceItemsOfTask(taskId)
  const sources = await loadTaskSources(items.map((item) => item.sourceKey))
  const adapters = taskAdapters()
  try {
    if ('sourceKey' in target) {
      const item = items.find((candidate) => candidate.sourceKey === target.sourceKey)
      const source = sources.get(target.sourceKey)
      if (!item || !source) throw new Error(`${task.reference ?? 'This task'} is not in that task source.`)
      if (!source.columns.some((column) => column.id === target.columnId)) throw new Error(`${source.label} has no such column.`)
      const moved = await adapters.source(source.source.kind).move({
        source: source.source, writeState: source.writeState, home, itemId: item.itemId, columnId: target.columnId,
      })
      if (moved) await storeProviderTask(moved)
      await storeTaskColumn(taskId, target.sourceKey, target.columnId)
    } else if (home.provider === 'jira') {
      if (task.state.category !== target.category) await storeProviderTask(await adapters.provider('jira').setState(home, target.category))
    } else {
      const wantsDone = target.category === 'done'
      if (home.kind === 'issue' && (task.state.category === 'done') !== wantsDone) {
        await storeProviderTask(await adapters.provider('github').setState(home, target.category))
      }
      for (const item of items) {
        const source = sources.get(item.sourceKey)
        if (source?.source.kind !== 'github-project') continue
        const columnId = firstColumnOf(source, target.category)
        if (!columnId || columnId === item.columnId) continue
        await adapters.source('github-project').move({ source: source.source, writeState: source.writeState, home, itemId: item.itemId, columnId })
        await storeTaskColumn(taskId, item.sourceKey, columnId)
      }
    }
  } catch (error) {
    throw taskWriteError(error)
  } finally {
    // A move of several boards can stop part way: clients read what the copy holds now.
    emitChanged(taskId)
  }
  const moved = await loadTask(taskId)
  if (!moved) throw new Error(`Task ${taskId} not found.`)
  return moved
}

const STATUS_CATEGORIES: readonly TaskStatusCategory[] = ['open', 'active', 'done']

/** A status that a caller named in words, as the move it means. */
export interface NamedTaskStatus {
  target: TaskMoveTarget
  /** The status category the move gives the task. */
  category: TaskStatusCategory
}

/**
 * Read a status that a caller names in words: a status category (`open`,
 * `active`, `done`) or the name of a column of a source that lists the task.
 * This is what an agent and a dispatched session send. A name that is neither
 * is refused with the columns the task can take.
 */
export async function namedTaskStatus(taskId: string, status: string): Promise<NamedTaskStatus> {
  const wanted = status.trim().toLowerCase()
  const category = STATUS_CATEGORIES.find((candidate) => candidate === wanted)
  if (category) return { target: { category }, category }
  await cachedTask(taskId)
  const items = await sourceItemsOfTask(taskId)
  const sources = await loadTaskSources(items.map((item) => item.sourceKey))
  for (const item of items) {
    const column = sources.get(item.sourceKey)?.columns.find((candidate) => candidate.name.toLowerCase() === wanted)
    if (column) return { target: { sourceKey: item.sourceKey, columnId: column.id }, category: column.category }
  }
  const names = [...new Set(items.flatMap((item) => sources.get(item.sourceKey)?.columns.map((column) => column.name) ?? []))]
  throw new Error(`"${status}" is not a status of this task. Use open, active or done${names.length ? `, or a column: ${names.join(', ')}` : ''}.`)
}

/** Move a task to a status that a caller names in words (`namedTaskStatus`). */
export async function moveTaskToStatus(taskId: string, status: string): Promise<Task> {
  return moveTask(taskId, (await namedTaskStatus(taskId, status)).target)
}

/**
 * Create a task on the provider, in one of the person's task sources. The
 * caller names the source; no project is needed. `personKey` is whose
 * connection reads the source when the host has not read it yet.
 */
export async function createTask(input: TaskCreateInput, personKey: string): Promise<Task> {
  const title = input.title.trim()
  if (!title) throw new Error('Task title cannot be empty.')
  const { source } = input
  const sourceKey = taskSourceKey(source)
  // A board write needs what a read of the board gives (the Project's id, the board's project).
  let stored = await loadTaskSource(sourceKey)
  if (stored?.fetchedAt == null) {
    await readTaskSource(source, personKey)
    stored = await loadTaskSource(sourceKey)
  }
  if (input.columnId !== undefined && !stored?.columns.some((column) => column.id === input.columnId)) {
    throw new Error(`${stored?.label ?? 'This task source'} has no such column.`)
  }
  let task: Task
  try {
    const item = await taskAdapters().source(source.kind).create({
      source,
      writeState: stored?.writeState ?? null,
      draft: {
        title, body: input.body, columnId: input.columnId, assignee: input.assignee,
        dueDate: input.dueDate, priority: input.priority, labels: input.labels,
      },
    })
    task = await storeProviderTask(item.task, { place: { sourceKey, columnId: item.columnId, itemId: item.itemId } })
  } catch (error) {
    throw taskWriteError(error)
  }
  emitChanged(task.id)
  return task
}

/**
 * Delete a draft item from its GitHub Project. An issue is closed or moved,
 * never deleted. The attachments of the draft go with it: nothing can name it
 * again.
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  const { task, home } = await writableTask(taskId)
  if (task.kind !== 'draft') throw new Error(`${task.reference ?? 'This task'} is an issue. Close it or move it; Solus deletes only a draft item.`)
  try {
    await taskAdapters().provider(home.provider).remove(home)
  } catch (error) {
    throw taskWriteError(error)
  }
  await database().transaction(async (db) => {
    await db.run(sql`DELETE FROM ${tasks} WHERE id = ${taskId}`)
    await db.run(sql`DELETE FROM ${taskSourceItems} WHERE task_id = ${taskId}`)
    // None of these has a foreign key to the row: the task key is polymorphic.
    await deleteEdgesOf(db, 'task', taskId)
    await deleteThreadsOf(db, taskThreads(taskId))
    await deleteActivityFor({ kind: 'task', id: taskId }, db)
    await db.run(sql`DELETE FROM ${personalResourceState} WHERE resource_kind = 'task' AND resource_id = ${taskId}`)
    // A notification about a task is the reader's own, in Local (`notifyTaskAssignments`).
    await removeNotificationsFor(db, LOCAL_ORGANIZATION_ID, { kind: 'task', taskId })
  })
  emitChanged()
  return true
}

/** Mark the host's copy of a task read or not read. */
export async function markTaskRead(taskId: string, read: boolean): Promise<Task> {
  await database().run(sql`UPDATE ${tasks} SET last_read_at = ${read ? Date.now() : null} WHERE id = ${taskId}`)
  const task = await loadTask(taskId)
  if (!task) throw new Error(`Task ${taskId} not found.`)
  emitChanged(taskId)
  return task
}

/** Send one comment to the provider. Throws when the provider does not take it. */
async function sendComment(home: TaskHome, body: string) {
  const published = await publishedBody(home, body)
  return taskAdapters().provider(home.provider).comment(home, published)
}

/**
 * Post a comment to the provider. A comment the provider did not take stays on
 * this host as `unsent` with the reason, and shows in the answer; a body with
 * an asset the provider cannot hold is refused, because it could never be sent.
 */
export async function commentOnTask(scope: RecordScope, taskId: string, input: NewTaskComment): Promise<TaskDetails> {
  const body = input.body.trim()
  if (!body) throw new Error('Task comment cannot be empty.')
  const { home } = await writableTask(taskId)
  if (input.id && await hasComment(taskId, input.id)) return taskDetails(scope, taskId)
  assertPublishable(home, body)
  try {
    await storeSentComment(taskId, { ...input, body }, await sendComment(home, body))
  } catch (error) {
    const sendError = taskWriteError(error).message
    log.warn('task_comment_not_sent', { taskId, error: sendError })
    await storeUnsentComment(taskId, { ...input, body }, sendError)
  }
  emitChanged(taskId)
  return taskDetails(scope, taskId)
}

/** Send an unsent comment again. It stays unsent, with the new reason, when the provider refuses it again. */
export async function retryTaskComment(scope: RecordScope, taskId: string, commentId: string): Promise<TaskDetails> {
  const { home } = await writableTask(taskId)
  const thread = await requireUnsentComment(taskId, commentId)
  try {
    await markCommentSent(taskId, thread, await sendComment(home, thread.body))
  } catch (error) {
    const sendError = taskWriteError(error).message
    log.warn('task_comment_not_sent', { taskId, commentId, error: sendError })
    await markCommentFailed(taskId, thread, sendError)
  }
  emitChanged(taskId)
  return taskDetails(scope, taskId)
}

/** Discard an unsent comment. A sent comment is deleted on the provider, not here. */
export async function deleteTaskComment(scope: RecordScope, taskId: string, commentId: string): Promise<TaskDetails> {
  await requireUnsentComment(taskId, commentId)
  if (await discardUnsentComment(taskId, commentId)) emitChanged(taskId)
  return taskDetails(scope, taskId)
}

/** The people the provider permits to be assigned: for one task, or for a new task in one source. */
export async function listTaskAssignees(target: { taskId: string } | { source: TaskSource }): Promise<TaskAssigneeCandidate[]> {
  try {
    if ('taskId' in target) {
      const { home } = await writableTask(target.taskId)
      return await taskAdapters().provider(home.provider).assignees(home)
    }
    return await taskAdapters().source(target.source.kind).assignees(target.source)
  } catch (error) {
    throw taskWriteError(error)
  }
}

/**
 * Ask the provider for the tasks of these sources that match `query`:
 * the only way to reach a task that a truncated source did not list. Each
 * found task gets a copy on this host, so a link or a session can name it. A
 * source that fails is left out; when each source fails the first error is
 * thrown.
 */
export async function searchTasks(sources: readonly TaskSource[], query: string): Promise<TaskSummary[]> {
  const text = query.trim()
  if (!text) return []
  const stored = await loadTaskSources(sources.map(taskSourceKey))
  const found = new Map<string, { sourceKey: string; columnId: string | null }>()
  let firstError: Error | null = null
  let answered = false
  for (const source of sources) {
    const sourceKey = taskSourceKey(source)
    try {
      for (const task of await taskAdapters().source(source.kind).search(source, text)) {
        const taskId = taskKey(task.ref)
        await storeProviderTask(task)
        const held = stored.get(sourceKey)
        if (!found.has(taskId)) found.set(taskId, { sourceKey, columnId: (held ? stateColumnOf(held, task) : null) ?? null })
      }
      answered = true
    } catch (error) {
      log.warn('task_search_failed', { sourceKey, error: error instanceof Error ? error.message : String(error) })
      firstError ??= taskWriteError(error)
    }
  }
  if (!answered && firstError) throw firstError
  // A task past the cap of a source has no placement on this host: it is named in the source that found it.
  return (await loadTaskSummaries([...found.keys()])).map((task) => {
    const place = found.get(task.id)
    return task.placements.length || !place ? task : { ...task, placements: [place] }
  })
}
