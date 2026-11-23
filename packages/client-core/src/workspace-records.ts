import { randomId } from './random-id'
import { workRecord, workSummary, sessionRecord } from '@solus/contracts/solus-api/records'
import type { Work, WorkListingMeta, SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { WorkspaceSessionSearchResult, WorkspaceWork } from '@solus/contracts/solus-api'
import { SolusApiClient, WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { pullRequestIdentityOf } from '@solus/contracts/session-pull-requests'

type RecordMethods = Pick<SolusAPI, 'createWork' | 'saveWork' | 'loadWork' | 'listWorks' | 'deleteWork' | 'sessionRecordList' | 'sessionRecordGet' | 'sessionRecordSearch' | 'sessionCloudList' | 'sessionTurnDiff' | 'sessionUpdate' | 'sessionPullRequests' | 'sessionPullRequestPut' | 'sessionPullRequestDelete'>
type SessionSearchHitPart = Pick<WorkspaceSessionSearchResult['items'][number], 'snippet' | 'timestamp' | 'messageId' | 'rank' | 'reason' | 'target'>

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
    scope: filter?.scope, parentSessionId: filter?.parentSessionId,
  }
}

/** Adapts the established UI records while their storage requests use the versioned HTTP contract. */
export function workspaceRecordMethods(client: SolusApiClient): RecordMethods {
  // The last version each record was seen at, so a write can name it in If-Match.
  // The newest list and archive pages can be revalidated independently. The host
  // hashes the complete authorized answer, including its next cursor and indexing flag.
  const pages = new Map<string, { revision: string; records: SessionRecord[]; nextCursor: string | null; indexing: boolean }>()
  const workVersions = new Map<string, string>()
  const rememberWork = (work: WorkspaceWork): Work => { workVersions.set(work.id, work.version); return workRecord(work) }
  const workVersion = async (id: string) => workVersions.get(id) ?? (await client.request('getWork', { id })).version
  return {
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
      const works: WorkListingMeta[] = []
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
      let completeRevision: string | undefined
      let order: 'activity' | undefined = 'activity'
      const filters = sessionListFilters(filter)
      for (;;) {
        const query = { ...filters, limit: 200, cursor, order }
        const key = JSON.stringify(query)
        const saved = pages.get(key)
        const disk = !cursor && filter?.limit === undefined && filter?.knownRevision
        const known = disk || saved?.revision
        let revision: string | undefined
        let response
        try {
          const input = { query, onEntityTag: (tag: string) => { revision = tag } }
          response = known ? await client.request('listSessions', { ...input, ifNoneMatch: known }) : await client.request('listSessions', input)
        } catch (error) {
          if (order && cursor === undefined && error instanceof WorkspaceRequestError && error.status === 400) { order = undefined; continue }
          throw error
        }
        if (!response && disk) return { records: [], indexing: false, unchanged: true, revision: disk }
        const page = response ? { records: response.items.map(sessionRecord), nextCursor: response.nextCursor, indexing: response.indexing } : saved
        if (!page) throw new Error('The host confirmed a session list that is no longer cached.')
        if (response && revision) {
          pages.delete(key)
          pages.set(key, { ...page, revision })
          if (pages.size > 4) pages.delete(pages.keys().next().value!)
        }
        if (!cursor && !page.nextCursor && filter?.limit === undefined) completeRevision = response ? revision : saved?.revision
        for (const record of page.records) records.set(record.sessionId, record)
        indexing ||= page.indexing
        cursor = page.nextCursor ?? undefined
        if (!cursor || (order && filter?.limit !== undefined && records.size >= filter.limit)) break
      }
      const sorted = [...records.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.sessionId.localeCompare(b.sessionId))
      return { records: filter?.limit === undefined ? sorted : sorted.slice(0, filter.limit), indexing, ...(completeRevision && { revision: completeRevision }) }
    },
    async sessionRecordGet(sessionId) {
      try { return sessionRecord(await client.request('getSession', { id: sessionId })) }
      catch (error) {
        // A session the caller may not read, or no longer may: refused or not found.
        if (error instanceof WorkspaceRequestError && (error.status === 403 || (error.status === 404 && error.code !== 'MOVED'))) return null
        throw error
      }
    },
    sessionCloudList: async () => (await client.request('listMySessions')).items,
    sessionTurnDiff: (sessionId, turnIndex) => client.request('sessionTurnDiff', { id: sessionId, params: { turnIndex: String(turnIndex) } }),
    // A session's home keeps its list state and its pull requests (docs/plans/session-archive.md).
    sessionUpdate: (sessionId, change) => client.request('updateSession', { id: sessionId, body: change }),
    async sessionPullRequests(sessionId) {
      return (await client.request('listSessionPullRequests', { id: sessionId })).items
    },
    async sessionPullRequestPut(sessionId, url) {
      if (!pullRequestIdentityOf(url)) throw new Error('That URL does not name a pull request.')
      await client.request('putLink', { body: { from: { kind: 'session', id: sessionId }, to: { kind: 'pr', url } } })
    },
    async sessionPullRequestDelete(sessionId, pullRequest) {
      // The link is keyed by repository and number; this URL names them.
      const url = `https://${pullRequest.repository}/pull/${pullRequest.number}`
      await client.request('deleteLink', { body: { from: { kind: 'session', id: sessionId }, to: { kind: 'pr', url } } })
    },
    async sessionRecordSearch(query) {
      const result = await client.request('searchSessions', { query: {
        q: query.query, projectRoot: query.projectRoot, repositoryKey: query.repositoryKey, provider: query.provider, limit: query.limit, offset: query.offset,
        namesOnly: query.namesOnly === undefined ? undefined : query.namesOnly ? 'true' : 'false',
        chats: query.chats ? 'true' : undefined,
        activeSince: query.activeSince,
      } })
      // A session found by its name alone has no passage: an empty snippet and no message.
      const hit = ({ snippet = '', timestamp, messageId = -1, rank, reason, target }: SessionSearchHitPart) => ({ snippet, ts: timestamp, messageId, rank, reason, target })
      return {
        results: result.items.map(item => ({ ...hit(item), record: sessionRecord(item.session), additionalMatches: item.additionalMatches.map(hit) })),
        total: result.total,
        indexing: result.indexing,
      }
    },
  }
}
