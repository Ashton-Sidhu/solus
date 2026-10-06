import { createHash } from 'node:crypto'
import type { TaskTransfer } from '@solus/contracts/task-types'
import type { WorkTransfer } from '@solus/contracts/work-transfer'
import type { Attribution } from '@solus/contracts/user'
import { LOCAL_ORGANIZATION_ID, type RecordScope } from '../../admission/principal'
import { Work } from '../works/work'
import { exportWorkForCloud, markWorkMoved } from '../works/works'
import { Task } from './task'
import { createTask } from './task-store'
import { taskSessions } from './task-sessions'
import { setSessionCustomTitle } from '../../db/session-indexer'

/**
 * A Local task's upload into an organization (docs/plans/cloud-sharing.md §4),
 * the same shape as a work's: the host gives the task with its local comments,
 * its linked Local works, and what the task page shows of its sessions; the
 * client uploads them with its own sign-in; and the host keeps only the task's
 * location once the Solus API has it (§3a). The cloud copy keeps every id, so
 * each step is safe to repeat.
 */

type TaskSnapshot = Omit<TaskTransfer, 'fingerprint'>

/** Names the content, not the home: the same task here and in the cloud hashes the same. */
export function taskTransferFingerprint(snapshot: TaskSnapshot): string {
  return createHash('sha256').update(JSON.stringify({ task: snapshot.task, comments: snapshot.comments, workIds: snapshot.workIds, sessions: snapshot.sessions })).digest('hex')
}

async function snapshotOf(scope: RecordScope, taskId: string, hostInstallationId: string): Promise<{ snapshot: TaskSnapshot; localWorkIds: string[] }> {
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
    sessions: ((await taskSessions(scope, taskId))[taskId] ?? []).map((link) => ({
      sessionId: link.sessionId,
      role: link.role ?? 'working',
      linkedAt: link.linkedAt,
      title: link.sessionTitle,
      provider: link.provider,
      startedBy: link.startedBy ?? null,
      hostInstallationId,
    })),
  }
  return { snapshot, localWorkIds }
}

/** The Local task and each of its linked Local works, whole. Its sessions run on
 *  this host, which every client knows by `hostInstallationId`. */
export async function exportTaskForCloud(scope: RecordScope, taskId: string, hostInstallationId: string): Promise<{ task: TaskTransfer; works: WorkTransfer[] }> {
  const { snapshot, localWorkIds } = await snapshotOf(scope, taskId, hostInstallationId)
  const works = await Promise.all(localWorkIds.map((workId) => exportWorkForCloud(scope, workId)))
  return { task: { ...snapshot, fingerprint: taskTransferFingerprint(snapshot) }, works }
}

/**
 * After the upload: the task keeps only its location on this host (§3a), and
 * each uploaded work points at the organization with its content kept. The task
 * keeps its links, so its sessions still name it. A task that changed after it
 * was read is kept whole, and so is a work that changed.
 */
export async function markTaskMoved(scope: RecordScope, taskId: string, fingerprint: string, works: Array<{ workId: string; fingerprint: string }>, organizationId: string, hostInstallationId: string): Promise<void> {
  const { snapshot } = await snapshotOf(scope, taskId, hostInstallationId)
  if (taskTransferFingerprint(snapshot) !== fingerprint) throw new Error('The task changed while it was shared. Its local copy was kept.')
  for (const work of works) await markWorkMoved(scope, work.workId, work.fingerprint, organizationId)
  await (await Task.byId(scope, taskId)).moveTo({ organizationId })
}

/**
 * The Solus API's side: the task under its own id in the organization, with its
 * comments, its links to the works that arrived first, and its sessions. A
 * session is named and placed on the host that runs it; nothing of its content
 * is here. A task already there is the same upload again and is answered as it stands.
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
  for (const session of transfer.sessions) {
    const execution = { serverId: session.hostInstallationId, provider: session.provider ?? undefined }
    await task.linkSession(session.sessionId, session.role, { execution, startedBy: session.startedBy })
    if (session.title) await setSessionCustomTitle(session.sessionId, session.title)
  }
  return task
}
