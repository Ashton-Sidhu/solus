import { randomId } from './random-id'
import { taskRecord, workRecord, workSummary, sessionRecord } from '@solus/contracts/solus-api/records'
import type { Task, TaskDetails } from '@solus/contracts/task-types'
import type { Work, WorkMeta, SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { WorkspaceSessionSearchResult, WorkspaceTask, WorkspaceWork } from '@solus/contracts/solus-api'
import { SolusApiClient, WorkspaceRequestError } from '@solus/contracts/solus-api/client'

type RecordMethods = Pick<SolusAPI, 'tasksGet' | 'tasksCreate' | 'tasksUpdate' | 'tasksDelete' | 'createWork' | 'saveWork' | 'loadWork' | 'listWorks' | 'deleteWork' | 'sessionRecordList' | 'sessionRecordSearch'>
type SessionSearchHitPart = Pick<WorkspaceSessionSearchResult['items'][number], 'snippet' | 'timestamp' | 'messageId' | 'rank'>

/** A record this host does not have. `MOVED` is not absence: the record is on
 *  another host, and the caller asks that one (cloud-sharing.md §3a). */
async function notFoundAsNull<T>(read: Promise<T>): Promise<T | null> {
  try { return await read }
  catch (error) { if (error instanceof WorkspaceRequestError && error.status === 404 && error.code !== 'MOVED') return null; throw error }
}

/** A session list filter as the Solus API's query strings. */
function sessionListFilters(filter: SessionRecordListFilter | undefined) {
  const flag = (value: boolean | undefined) => value === undefined ? undefined : value ? 'true' as const : 'false' as const
  return {
    provider: filter?.provider, projectPath: filter?.projectPath, repositoryKey: filter?.repositoryKey, includeWorktrees: flag(filter?.includeWorktrees), chats: flag(filter?.chats),
    archived: flag(filter?.archived), roots: flag(filter?.roots),
  }
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
    async tasksGet(id) {
      const [task, detail] = await Promise.all([client.request('getTask', { id }), extras(id)])
      return { ...detail, task: rememberTask(task) }
    },
    async tasksCreate(input) {
      const { source: _source, originAutomationId: _automation, ...body } = input
      return rememberTask(await client.request('createTask', { body, key: randomId() }))
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
      return rememberWork(await client.request('createWork', { body: { title, type, content: content ?? '', originSessionId: sessionId, agentProvider, projectKey: cwd, id }, key: randomId() }))
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
      // Paged by last activity, so the newest `limit` sessions are the first pages. A record
      // whose activity changes during the read can move between pages; the map keeps it once.
      const records = new Map<string, SessionRecord>()
      let cursor: string | undefined
      let indexing = false
      let order: 'activity' | undefined = 'activity'
      let filters = sessionListFilters(filter)
      for (;;) {
        let page
        try {
          page = await client.request('listSessions', { query: { ...filters, limit: 200, cursor, order } })
        } catch (error) {
          const refused = cursor === undefined && error instanceof WorkspaceRequestError && error.status === 400
          // A host older than the session list refuses `archived` and `roots`, and archives
          // nothing (docs/plans/session-archive.md): it has no archived sessions, and every
          // session it has is in the list.
          if (refused && (filters.archived || filters.roots)) {
            if (filters.archived === 'true') return { records: [], indexing: false }
            filters = { ...filters, archived: undefined, roots: undefined }
            continue
          }
          // A host older than `order` refuses it. It pages by creation, so every page is read.
          if (refused && order) { order = undefined; continue }
          throw error
        }
        for (const session of page.items) records.set(session.id, sessionRecord(session))
        indexing ||= page.indexing
        cursor = page.nextCursor ?? undefined
        if (!cursor || (order && filter?.limit !== undefined && records.size >= filter.limit)) break
      }
      // A host that refused `roots` answered every session.
      const sorted = [...records.values()].filter((record) => !filter?.roots || record.parentSessionId === null).sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId))
      return { records: filter?.limit === undefined ? sorted : sorted.slice(0, filter.limit), indexing }
    },
    async sessionRecordSearch(query) {
      const result = await client.request('searchSessions', { query: {
        q: query.query, projectRoot: query.projectRoot, repositoryKey: query.repositoryKey, provider: query.provider, limit: query.limit, offset: query.offset,
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
