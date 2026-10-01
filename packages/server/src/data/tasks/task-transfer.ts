import { createHash } from 'node:crypto'
import type { TaskTransfer } from '@solus/contracts/task-types'
import type { WorkTransfer } from '@solus/contracts/work-transfer'
import type { Attribution } from '@solus/contracts/user'
import { LOCAL_ORGANIZATION_ID, type RecordScope } from '../../admission/principal'
import { Work } from '../works/work'
import { exportWorkForCloud, removePushedWork } from '../works/works'
import { Task } from './task'
import { createTask } from './task-store'

/**
 * A Local task's upload into an organization (docs/plans/cloud-sharing.md §4),
 * the same shape as a work's: the host gives the task with its local comments
 * and its linked Local works, the client uploads them with its own sign-in, and
 * the host removes them once the Solus API has them. The cloud copy keeps every
 * id, so each step is safe to repeat.
 */

type TaskSnapshot = Omit<TaskTransfer, 'fingerprint'>

/** Names the content, not the home: the same task here and in the cloud hashes the same. */
export function taskTransferFingerprint(snapshot: TaskSnapshot): string {
  return createHash('sha256').update(JSON.stringify({ task: snapshot.task, comments: snapshot.comments, workIds: snapshot.workIds })).digest('hex')
}

async function snapshotOf(scope: RecordScope, taskId: string): Promise<{ snapshot: TaskSnapshot; localWorkIds: string[] }> {
  const task = await Task.byId(scope, taskId)
  if (task.organizationId !== LOCAL_ORGANIZATION_ID) throw new Error('This task already belongs to an organization.')
  const details = await task.details()
  const linkedWorkIds = [...new Set(details.links.filter((link) => link.kind === 'work').map((link) => link.targetKey))]
  const localWorkIds: string[] = []
  for (const workId of linkedWorkIds) {
    if ((await Work.find(scope, workId))?.organizationId === LOCAL_ORGANIZATION_ID) localWorkIds.push(workId)
  }
  const snapshot: TaskSnapshot = {
    task: {
      id: task.id,
      title: task.title,
      projectKey: task.projectKey ?? null,
      body: task.body,
      status: task.status,
      priority: task.priority ?? null,
      labels: task.labels,
      dueDate: task.dueDate ?? null,
      source: task.source ?? null,
      originSessionId: task.originSessionId ?? null,
      createdAt: task.createdAt ?? Date.now(),
    },
    comments: details.comments
      .filter((comment) => comment.source === 'local')
      .map((comment) => ({ id: comment.id, body: comment.body, author: comment.author ?? null, originSessionId: comment.originSessionId ?? null })),
    workIds: localWorkIds,
  }
  return { snapshot, localWorkIds }
}

/** The Local task and each of its linked Local works, whole. */
export async function exportTaskForCloud(scope: RecordScope, taskId: string): Promise<{ task: TaskTransfer; works: WorkTransfer[] }> {
  const { snapshot, localWorkIds } = await snapshotOf(scope, taskId)
  const works = await Promise.all(localWorkIds.map((workId) => exportWorkForCloud(scope, workId)))
  return { task: { ...snapshot, fingerprint: taskTransferFingerprint(snapshot) }, works }
}

/**
 * After the upload: the task and each uploaded work leave this host. A task
 * that changed after it was read is kept, and so is a work that changed.
 */
export async function removeUploadedTask(scope: RecordScope, taskId: string, fingerprint: string, works: Array<{ workId: string; fingerprint: string }>): Promise<void> {
  const { snapshot } = await snapshotOf(scope, taskId)
  if (taskTransferFingerprint(snapshot) !== fingerprint) throw new Error('The task changed while it was shared. Its local copy was kept.')
  for (const work of works) await removePushedWork(scope, work.workId, work.fingerprint)
  await (await Task.byId(scope, taskId)).delete()
}

/**
 * The Solus API's side: the task under its own id in the organization, with its
 * comments and its links to the works that arrived first. A task already there
 * is the same upload again and is answered as it stands.
 */
export async function importTaskFromHost(organizationId: string, transfer: TaskTransfer, by: Attribution): Promise<Task> {
  const { fingerprint, ...snapshot } = transfer
  if (taskTransferFingerprint(snapshot) !== fingerprint) throw new Error('The task snapshot is incomplete.')
  const existing = await Task.byId(organizationId, transfer.task.id).catch(() => null)
  if (existing) return existing
  const { id, createdAt, source, ...fields } = transfer.task
  await createTask(organizationId, { ...fields, source: source ?? 'user' }, { id, now: createdAt }, by)
  const task = await Task.byId(organizationId, id)
  for (const comment of transfer.comments) {
    await task.comment(comment.body, { id: comment.id, by: comment.author ?? by, originSessionId: comment.originSessionId })
  }
  for (const workId of transfer.workIds) {
    if (await Work.find(organizationId, workId)) await task.link({ kind: 'work', targetKey: workId }, by)
  }
  return task
}
