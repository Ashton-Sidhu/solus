import { workspaceTaskQuerySchema, workspaceCreateTaskSchema, workspaceUpdateTaskSchema } from '@solus/contracts/solus-api'
import { sql } from 'drizzle-orm'
import type { Task as TaskRecord } from '@solus/contracts/task-types'
import type { WorkspaceCreateTask, WorkspaceTask, WorkspaceTaskPage, WorkspaceTaskQuery, WorkspaceUpdateTask } from '@solus/contracts/solus-api'
import { requestAttribution, workspaceAuthorityKey, type WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import { getDatabase } from '../../db/database'
import { hostUserKey } from '../../host/host-user'
import type { ShareManager } from '../../sharing/share-manager'
import { scopeClause } from '../scope'
import { apiOrganization, apiScope, projectIdsForKeys, projectKeyForId, requireResource, requireScope } from '../workspace/context'
import { pageOf, readCursor, seekClause } from '../workspace/page'
import { canonicalRequest, createWithReceipt } from '../workspace/receipts'
import { createTask, loadTaskRecord, readTaskMetadataPage } from './task-store'
import { Task } from './task'
import { tasks, taskSessionLinks } from './schema'
import { workspaceResourceVisibility } from './resource-visibility'
import { getSessionRecord } from '../sessions/session-records'

export class TaskApiOperations {
  constructor(private readonly shares: ShareManager) {}

  private async records(context: WorkspaceRequestContext, records: TaskRecord[]): Promise<WorkspaceTask[]> {
    const owners = await this.shares.ownersOf('task', records.map(task => task.id))
    const projects = await projectIdsForKeys(context, records.flatMap(task => task.projectKey ? [task.projectKey] : []))
    return records.map(task => ({
      id: task.id, home: context.home, organizationId: task.organizationId === 'local' ? null : task.organizationId ?? null,
      ownerUserId: owners.get(task.id) ?? hostUserKey(), version: String(task.updatedAt),
      createdAt: new Date(task.createdAt ?? task.updatedAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString(),
      title: task.title, body: task.body, projectKey: task.projectKey ?? null,
      projectId: task.projectKey ? projects.get(task.organizationId ?? 'local')?.get(task.projectKey) ?? null : null,
      status: task.status, assignee: task.assignee ?? null, priority: task.priority ?? null,
      labels: task.labels ?? [], dueDate: task.dueDate ?? null, originSessionId: task.originSessionId ?? null,
      shortId: task.shortId ?? null, titleSource: task.titleSource, source: task.source,
      originAutomationId: task.originAutomationId, triagedAt: task.triagedAt, doneAt: task.doneAt,
      lastReadAt: task.lastReadAt, pr: task.pr, mirroredTicket: task.mirroredTicket,
    }))
  }

  private async read(context: WorkspaceRequestContext, taskId: string): Promise<WorkspaceTask> {
    const task = await loadTaskRecord(apiScope(context), taskId)
    if (!task) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
    return (await this.records(context, [task]))[0]
  }

  async get(context: WorkspaceRequestContext, taskId: string): Promise<WorkspaceTask> {
    requireScope(context, 'tasks:read')
    await requireResource(this.shares, context, { kind: 'task', id: taskId }, 'viewer')
    return this.read(context, taskId)
  }

  async list(context: WorkspaceRequestContext, query: WorkspaceTaskQuery): Promise<WorkspaceTaskPage> {
    query = workspaceTaskQuerySchema.parse(query)
    requireScope(context, 'tasks:read')
    const filters = [scopeClause(apiScope(context), sql`tasks.organization_id`),
      workspaceResourceVisibility(context.principal, 'task', sql`tasks.id`, sql`tasks.organization_id`),
      seekClause(sql`tasks.created_at`, sql`tasks.id`, readCursor(query.cursor))]
    if (query.projectId) filters.push(sql`tasks.project_key = ${await projectKeyForId(context, query.projectId)}`)
    if (query.projectKey !== undefined) filters.push(sql`tasks.project_key = ${query.projectKey}`)
    if (query.scope === 'inbox') filters.push(sql`tasks.project_key IS NULL AND tasks.status = 'inbox'`)
    if (query.scope === 'project') filters.push(sql`tasks.project_key IS NOT NULL`)
    if (query.scope === 'up_next') filters.push(sql`tasks.status IN ('todo', 'in_progress', 'in_review')`)
    if (query.status) filters.push(sql`tasks.status = ${query.status}`)
    if (query.sessionId) {
      await requireResource(this.shares, context, { kind: 'session', id: query.sessionId }, 'viewer')
      filters.push(sql`EXISTS(SELECT 1 FROM ${taskSessionLinks} WHERE task_id = tasks.id AND session_id = ${query.sessionId})`)
    }
    const records = await readTaskMetadataPage(sql.join(filters, sql` AND `), query.limit + 1)
    const summaries = (await this.records(context, records)).map(({ body: _body, ...summary }) => summary)
    return pageOf(summaries, query.limit, item => ({ time: Date.parse(item.createdAt), id: item.id }))
  }

  async create(context: WorkspaceRequestContext, input: WorkspaceCreateTask, key: string): Promise<WorkspaceTask> {
    input = workspaceCreateTaskSchema.parse(input)
    requireScope(context, 'tasks:write')
    if (context.principal.kind === 'guest') throw new SolusApiError(403, 'FORBIDDEN', 'Guests cannot create root tasks.')
    const projectKey = input.projectId ? await projectKeyForId(context, input.projectId) : input.projectKey ?? null
    if (input.originSessionId) {
      await requireResource(this.shares, context, { kind: 'session', id: input.originSessionId }, 'editor')
      if (!await getSessionRecord(apiScope(context), input.originSessionId) && !context.actingAgent) throw new SolusApiError(404, 'NOT_FOUND', 'Parent session not found.')
    }
    return createWithReceipt(workspaceAuthorityKey(context), 'task', key, canonicalRequest(input), async () => {
      const { projectId: _projectId, ...fields } = input
      const task = await createTask(apiOrganization(context), { ...fields, projectKey, source: context.actingAgent ? 'agent' : 'user' }, undefined, requestAttribution(context))
      await this.shares.claimOwner({ kind: 'task', id: task.id }, context.principal)
      return (await this.records(context, [task]))[0]
    }, async taskId => {
      await requireResource(this.shares, context, { kind: 'task', id: taskId }, 'editor')
      return this.read(context, taskId)
    })
  }

  /** Holds the row for the transaction and refuses a write against a version the caller has not seen. */
  private async locked(context: WorkspaceRequestContext, taskId: string, version: string): Promise<Task> {
    const db = getDatabase()
    const rows = await db.all(sql`SELECT id FROM ${tasks} WHERE id = ${taskId} AND ${scopeClause(apiScope(context))} ${db.engine === 'postgres' ? sql`FOR UPDATE` : sql``}`)
    if (!rows.length) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
    const task = await Task.byId(apiScope(context), taskId)
    if (String(task.record().updatedAt) !== version) throw new SolusApiError(412, 'STALE_VERSION', 'Read the latest version before saving.')
    return task
  }

  async update(context: WorkspaceRequestContext, taskId: string, input: WorkspaceUpdateTask, version: string): Promise<WorkspaceTask> {
    input = workspaceUpdateTaskSchema.parse(input)
    requireScope(context, 'tasks:write')
    return getDatabase().transaction(async () => {
      await requireResource(this.shares, context, { kind: 'task', id: taskId }, 'editor')
      const task = await this.locked(context, taskId, version)
      const { projectId, projectKey: suppliedProjectKey, ...patch } = input
      const projectKey = projectId === undefined ? suppliedProjectKey : await projectKeyForId(context, projectId)
      const updated = await task.update({ ...patch, projectKey }, requestAttribution(context))
      return (await this.records(context, [updated.record()]))[0]
    })
  }

  async delete(context: WorkspaceRequestContext, taskId: string, version: string): Promise<void> {
    requireScope(context, 'tasks:write')
    await getDatabase().transaction(async () => {
      await requireResource(this.shares, context, { kind: 'task', id: taskId }, 'owner')
      const task = await this.locked(context, taskId, version)
      await task.delete(); await this.shares.forget({ kind: 'task', id: taskId })
    })
  }
}
