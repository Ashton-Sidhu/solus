import { taskRecord, workRecord, workSummary, sessionRecord } from '@solus/contracts/solus-api/records'
import type { Task, TaskDetails } from '@solus/contracts/task-types'
import type { Work, WorkMeta, SessionRecord } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { WorkspaceSessionSearchResult, WorkspaceTask, WorkspaceWork } from '@solus/contracts/solus-api'
import { SolusApiClient, WorkspaceRequestError } from '@solus/contracts/solus-api/client'

type RecordMethods = Pick<SolusAPI, 'tasksGet' | 'tasksCreate' | 'tasksUpdate' | 'tasksDelete' | 'createWork' | 'saveWork' | 'loadWork' | 'listWorks' | 'deleteWork' | 'sessionRecordList' | 'sessionRecordSearch' | 'insightsList'>
type SessionSearchHitPart = Pick<WorkspaceSessionSearchResult['items'][number], 'snippet' | 'timestamp' | 'messageId' | 'rank'>

async function notFoundAsNull<T>(read: Promise<T>): Promise<T | null> {
  try { return await read }
  catch (error) { if (error instanceof WorkspaceRequestError && error.status === 404) return null; throw error }
}

/** Adapts the established UI records while their storage requests use the versioned HTTP contract. */
export function workspaceRecordMethods(client: SolusApiClient, extras: (id: string) => Promise<Omit<TaskDetails, 'task'>>): RecordMethods {
  // The last version each record was seen at, so a write can name it in If-Match.
  const taskVersions = new Map<string, string>()
  const workVersions = new Map<string, string>()
  const rememberTask = (task: WorkspaceTask): Task => { taskVersions.set(task.id, task.version); return taskRecord(task) }
  const rememberWork = (work: WorkspaceWork): Work => { workVersions.set(work.id, work.version); return workRecord(work) }
  const taskVersion = async (id: string) => taskVersions.get(id) ?? (await client.request('getTask', { id })).version
  const workVersion = async (id: string) => workVersions.get(id) ?? (await client.request('getWork', { id })).version
  return {
    insightsList: query => client.request('listInsights', { query }),
    async tasksGet(id) {
      const [task, detail] = await Promise.all([client.request('getTask', { id }), extras(id)])
      return { ...detail, task: rememberTask(task) }
    },
    async tasksCreate(input) {
      const { source: _source, originAutomationId: _automation, ...body } = input
      return rememberTask(await client.request('createTask', { body, key: crypto.randomUUID() }))
    },
    async tasksUpdate(id, body, expectedUpdatedAt) {
      const version = expectedUpdatedAt === undefined ? await taskVersion(id) : String(expectedUpdatedAt)
      return rememberTask(await client.request('updateTask', { id, body, version }))
    },
    async tasksDelete(id) {
      await client.request('deleteTask', { id, version: await taskVersion(id) })
      taskVersions.delete(id)
      return true
    },
    async createWork(title, type, content, _preview, sessionId, agentProvider, cwd, id) {
      return rememberWork(await client.request('createWork', { body: { title, type, content: content ?? '', originSessionId: sessionId, agentProvider, projectKey: cwd, id }, key: crypto.randomUUID() }))
    },
    // The caller names the record it read; a version read here at write time would make a blind save.
    async saveWork(id, updates, base) {
      const expectedContentVersion = updates.content === undefined ? undefined : base.contentVersion
      return rememberWork(await client.request('updateWork', { id, body: { title: updates.title, content: updates.content, expectedContentVersion }, version: base.updatedAt }))
    },
    loadWork: id => notFoundAsNull(client.request('getWork', { id }).then(rememberWork)),
    async listWorks() {
      const works: (WorkMeta & { id: string })[] = []
      let cursor: string | undefined
      do {
        const page = await client.request('listWorks', { query: { limit: 200, cursor } })
        for (const work of page.items) { if (!workVersions.has(work.id)) workVersions.set(work.id, work.version); works.push(workSummary(work)) }
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return works.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    },
    async deleteWork(id) {
      await client.request('deleteWork', { id, version: await workVersion(id) })
      workVersions.delete(id)
    },
    async sessionRecordList(filter) {
      const records: SessionRecord[] = []
      let cursor: string | undefined
      let indexing = false
      do {
        const page = await client.request('listSessions', { query: { limit: 200, cursor, provider: filter?.provider, projectPath: filter?.projectPath, includeWorktrees: filter?.includeWorktrees === undefined ? undefined : filter.includeWorktrees ? 'true' : 'false' } })
        for (const session of page.items) records.push(sessionRecord(session))
        indexing ||= page.indexing
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      records.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId))
      return { records: filter?.limit === undefined ? records : records.slice(0, filter.limit), indexing }
    },
    async sessionRecordSearch(query) {
      const result = await client.request('searchSessions', { query: {
        q: query.query, projectRoot: query.projectRoot, provider: query.provider, limit: query.limit, offset: query.offset,
        namesOnly: query.namesOnly === undefined ? undefined : query.namesOnly ? 'true' : 'false',
        activeSince: query.activeSince,
      } })
      // A session found by its name alone has no passage: an empty snippet and no message.
      const hit = ({ snippet = '', timestamp, messageId = -1, rank }: SessionSearchHitPart) => ({ snippet, ts: timestamp, messageId, rank })
      return {
        results: result.items.map(item => ({ ...hit(item), record: sessionRecord(item.session), additionalMatches: item.additionalMatches.map(hit) })),
        total: result.total,
        indexing: result.indexing,
      }
    },
  }
}
