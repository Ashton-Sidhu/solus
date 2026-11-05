import { readOwnSessionArtifacts } from './session-artifacts'
import { session as sessionTable } from './schema'
import { workspaceSessionQuerySchema, workspaceSessionSearchQuerySchema, workspacePageQuerySchema } from '@solus/contracts/solus-api'
import { trimTrailingSeparators } from '@solus/contracts/host-path'
import { cutText } from '@solus/contracts/text-cut'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import { SearchQuery } from '@solus/contracts/search-query'
import { isAnyOrganization, runnerPrincipalFor, type RecordScope } from '../../admission/principal'
import { sql, type SQL } from 'drizzle-orm'
import { encodePathAsFolder, isSolusWorktreePath, SOLUS_WORKTREE_ENCODED_MARKER, worktreeProjectRoot, type SessionRecord } from '@solus/contracts/types'
import { workspaceSessionAdmissionRequestSchema, workspaceUpdateSessionSchema } from '@solus/contracts/solus-api'
import type { WorkspaceSession, WorkspaceSessionChanged, WorkspaceSessionPullRequestList, WorkspaceSessionLinkList, WorkspaceUpdateSession, WorkspaceSessionAdmission, WorkspaceSessionAdmissionRequest, WorkspaceSessionPage, WorkspaceSessionQuery, WorkspaceSessionSearchQuery, WorkspaceSessionSearchResult, WorkspacePageQuery, WorkspaceTranscriptPage } from '@solus/contracts/solus-api'
import { getDatabase, type Db } from '../../db/database'
import { searchIndexFor } from '../../db/search-index'
import { sessionMessagesRebuilding } from '../../db/session-indexer'
import { matchSessionIndex, pageSessionMatches } from '../../db/session-search'
import { isApiMode } from '../../host/api-mode'
import { SolusApiError } from '../../admission/workspace-error'
import type { ShareManager } from '../../sharing/share-manager'
import { scopeClause } from '../scope'
import { apiScope, projectIdsForKeys, projectKeyForId, requireResource, requireScope } from '../workspace/context'
import { pageOf, readCursor, seekClause } from '../workspace/page'
import { workspaceResourceVisibility } from '../tasks/resource-visibility'
import { getSessionRecord, readSessionListPage, readSessionMetadataPage, sessionRecordsIndexing, upsertSessionRecord, type SessionPageReader } from './session-records'
import { readApiTranscript } from './api-transcript'
import { admitSession, SessionAdmissionConflict, type SessionAdmission } from './session-identity'
import { onSessionPullRequestsChanged, readSessionPullRequests } from './session-pull-requests'
import { sessionsWithPendingAsyncQuestion } from './async-questions'
import { SessionShelf, SessionViewer } from './session-states'
import { personalResourceState } from '../personal-state/schema'
import { UNSETTLED_SESSION_STATE } from '@solus/contracts/session-state'
import { actorFor, ownerKeyOf } from '../../admission/actor'
import { authorize } from '../../admission/access-policy'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'

/**
 * The words each session is also known by: the number and title of each pull
 * request linked to it, by session id (the search names a thread's session
 * before it asks). Every link in scope is read once, and the answer is kept
 * until a link changes: a search runs on each keystroke, a link changes rarely.
 */
let pullRequestNamesByScope = new WeakMap<Db, Map<string, Promise<Map<string, string>>>>()
onSessionPullRequestsChanged(() => { pullRequestNamesByScope = new WeakMap() })

function pullRequestNames(scope: RecordScope): Promise<Map<string, string>> {
  const db = getDatabase()
  let byScope = pullRequestNamesByScope.get(db)
  if (!byScope) pullRequestNamesByScope.set(db, byScope = new Map())
  const key = isAnyOrganization(scope) ? '' : scope
  let names = byScope.get(key)
  if (!names) {
    names = readSessionPullRequests(scope).then((bySession) =>
      new Map(Object.entries(bySession).map(([sessionId, links]) => [sessionId, links.map(link => `#${link.number} ${link.title}`).join('\n')])))
    byScope.set(key, names)
    names.catch(() => byScope.delete(key))
  }
  return names
}

/** The records of ten thousand sessions are asked for in lists of this many. */
const READABLE_CHUNK = 500

type SearchRequest = ReturnType<typeof workspaceSessionSearchQuerySchema.parse>
type SearchHit = WorkspaceSessionSearchResult['items'][number]['additionalMatches'][number]
/** One session's passages, best first, before its record is checked. A
 *  session that matched by its name alone has none. */
interface SessionHits { sessionId: string; passages: SearchHit[]; rank: number; reason?: SearchHit['reason'] }
/** One page of matching sessions and how many match in all. */
interface HitsPage { hits: SessionHits[]; total: number }

/** The longest name the API's session schema carries. A session with no
 *  title is named by its opening message, which can be any length; one
 *  longer name failed a client's check of the whole page, and the picker
 *  listed no session at all. */
const SESSION_NAME_LIMIT = 500

function withinNameLimit(text: string | null): string | null {
  if (text === null || text.length <= SESSION_NAME_LIMIT) return text
  // The schema counts UTF-16 units.
  return `${cutText(text, SESSION_NAME_LIMIT - 1)}…`
}

export class SessionApiOperations {
  constructor(private readonly shares: ShareManager) {}

  private async records(context: WorkspaceRequestContext, records: SessionRecord[]): Promise<WorkspaceSession[]> {
    const projects = await projectIdsForKeys(context, records.flatMap(session => session.projectRemote ? [session.projectRemote] : []))
    const links = records.length ? await readSessionPullRequests(apiScope(context), records.map(session => session.sessionId)) : {}
    const access = await this.shares.accessOf(context.principal, 'session', records.map(session => session.sessionId))
    // Questions wait on the host that runs the session; the workspace service keeps none.
    const asking = isApiMode() ? new Set<string>() : sessionsWithPendingAsyncQuestion(records.map(session => session.sessionId))
    return records.map(session => {
      const item: WorkspaceSession = {
        id: session.sessionId, home: context.home, organizationId: session.organizationId === 'local' ? null : session.organizationId,
        ownerKey: session.ownerKey, role: access.get(session.sessionId)?.role ?? 'none', version: String(session.lastActivityAt),
        createdAt: new Date(session.createdAt).toISOString(), updatedAt: new Date(session.lastActivityAt).toISOString(),
        provider: session.provider, title: withinNameLimit(session.title), customTitle: withinNameLimit(session.customTitle),
        projectId: session.projectRemote ? projects.get(session.organizationId)?.get(session.projectRemote) ?? null : null,
        projectPath: session.projectPath, projectRemote: session.projectRemote, runnerHostId: session.runnerHostId,
        status: session.status, model: session.model, reasoningEffort: session.reasoningEffort ?? null,
        parentSessionId: session.parentSessionId, rootSessionId: session.rootSessionId,
        publication: session.publication, size: session.size,
        cwd: session.cwd, slug: withinNameLimit(session.slug), isWorktree: session.isWorktree, branch: session.branch, projectRoot: session.projectRoot, delegation: session.delegation,
        place: session.place, startedBy: session.startedBy,
        state: session.state ?? null,
        view: session.view ?? null,
        listed: session.listed ?? true,
        pullRequests: links[session.sessionId] ?? [],
      }
      if (session.sharedBy !== undefined && session.grantedAt !== undefined) {
        item.sharedBy = session.sharedBy
        item.grantedAt = session.grantedAt
      }
      if (asking.has(session.sessionId)) item.hasPendingQuestion = true
      return item
    })
  }

  /** Who reads a page: the caller's person, for their view and list. */
  private reader(context: WorkspaceRequestContext): SessionPageReader {
    const { principal } = context
    return { personKey: ownerKeyOf(actorFor(principal)), teamIds: principal.kind === 'org-member' ? principal.teamIds : [], now: Date.now() }
  }

  /** One record with the caller's view, or 404. */
  private async readOne(context: WorkspaceRequestContext, sessionId: string): Promise<WorkspaceSession> {
    const [record] = await readSessionMetadataPage(sql.join([...this.visible(context), sql`session_records.session_id = ${sessionId}`], sql` AND `), 1, 'created_at', this.reader(context))
    if (!record) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
    return (await this.records(context, [record]))[0]
  }

  /** The person a view belongs to. A host and a runner are no person, so they have none. */
  private personKey(context: WorkspaceRequestContext): string {
    const personKey = ownerKeyOf(actorFor(context.principal))
    if (!personKey) throw new SolusApiError(403, 'FORBIDDEN', 'A view of a session belongs to a person, and this credential acts for none.')
    return personKey
  }

  /**
   * A prompt reached the session on its machine (docs/plans/session-archive.md):
   * the session is active, and back in the list of the person the turn is for.
   * Only a host acting for that person reports it.
   */
  async admitTurn(context: WorkspaceRequestContext, sessionId: string): Promise<void> {
    requireScope(context, 'sessions:admit')
    if (!context.delegation) throw new SolusApiError(403, 'FORBIDDEN', 'Only a host acting for a person reports a turn.')
    await requireResource(this.shares, context, { kind: 'session', id: sessionId }, 'edit')
    await new SessionShelf(sessionId).recordPrompt(this.personKey(context))
  }

  /**
   * Settle, archive, and snooze a session in the caller's own list (viewer).
   * An editor's unsettle also ends a settle by the session's pull requests or
   * task, which every person sees. The access check runs before any write, so
   * a refused change writes nothing. The answer is what the change left: the
   * caller's view, and the shared state when the change ended its settle.
   */
  async update(context: WorkspaceRequestContext, sessionId: string, input: WorkspaceUpdateSession): Promise<WorkspaceSessionChanged> {
    input = workspaceUpdateSessionSchema.parse(input)
    requireScope(context, 'sessions:write')
    const resource = { kind: 'session', id: sessionId } as const
    await requireResource(this.shares, context, resource, 'read')
    const changed: WorkspaceSessionChanged = {}
    if (input.settled === false && !await authorize(context.principal, 'edit', resource, { name: 'session.edit', resources: this.shares })) {
      await new SessionShelf(sessionId).unsettle()
      changed.state = UNSETTLED_SESSION_STATE
    }
    if (input.settled !== undefined || input.archived !== undefined || input.snoozedUntil !== undefined) {
      const viewer = new SessionViewer(sessionId, this.personKey(context))
      if (input.settled === true) await viewer.settle()
      if (input.settled === false) await viewer.unsettle()
      if (input.archived === true) await viewer.archive()
      if (input.archived === false) await viewer.unarchive()
      if (input.snoozedUntil !== undefined) await viewer.snooze(input.snoozedUntil, input.snoozeNote)
      changed.view = await viewer.view()
    }
    return changed
  }

  async links(context: WorkspaceRequestContext, sessionId: string): Promise<WorkspaceSessionLinkList> {
    requireScope(context, 'sessions:read')
    await requireResource(this.shares, context, { kind: 'session', id: sessionId }, 'read')
    const items = await readOwnSessionArtifacts(apiScope(context), sessionId)
    return { items: items.map((item): WorkspaceSessionLinkList['items'][number] => {
      if (item.kind === 'pull-request') {
        const { link } = item
        const state = link.missing ? 'missing' : link.snapshot ? (link.snapshot.draft && link.snapshot.state === 'open' ? 'draft' : link.snapshot.state) : 'not yet synced'
        return { target: { kind: 'pr', url: link.url }, title: link.snapshot?.title || link.title || '', state, source: link.source }
      }
      if (item.kind === 'work') return { target: { kind: 'work', id: item.workId }, title: item.title }
      if (item.kind === 'automation') return { target: { kind: 'automation', id: item.automationId, hostId: item.hostId }, title: item.title }
      return { target: { kind: 'file', path: item.path, hostId: item.hostId }, title: item.title }
    }) }
  }

  async pullRequests(context: WorkspaceRequestContext, sessionId: string): Promise<WorkspaceSessionPullRequestList> {
    requireScope(context, 'sessions:read')
    await requireResource(this.shares, context, { kind: 'session', id: sessionId }, 'read')
    return { items: (await readSessionPullRequests(apiScope(context), [sessionId]))[sessionId] ?? [] }
  }

  /** The records a caller may read: its scope, then what sharing and parentage let it see. */
  private visible(context: WorkspaceRequestContext): SQL[] {
    return [scopeClause(apiScope(context), sql`session_records.organization_id`),
      workspaceResourceVisibility(context.principal, 'session', { id: sql`session_records.session_id`, organization: sql`session_records.organization_id`, owner: sql`session_records.created_by` })]
  }

  /**
   * Accepts one new organization session before its provider starts (organization-vms
   * §3). Only a credential exchanged from a host's delegated token reaches this
   * (plans/010-standard-oauth.md): its person becomes the owner, its host the executor.
   */
  async admit(context: WorkspaceRequestContext, input: WorkspaceSessionAdmissionRequest): Promise<WorkspaceSessionAdmission> {
    input = workspaceSessionAdmissionRequestSchema.parse(input)
    requireScope(context, 'sessions:admit')
    const delegation = context.delegation
    if (!delegation || context.home.kind !== 'organization' || context.principal.kind !== 'org-member') {
      throw new SolusApiError(403, 'FORBIDDEN', 'Only a host acting for a person admits a session.')
    }
    try {
      const admission = await admitSession({ organizationId: context.home.organizationId, admissionId: input.sessionId, hostId: delegation.hostId, ownerKey: context.principal.userId })
      if (input.record) await this.writeAdmittedRecord(admission, input.record)
      return { sessionId: admission.admissionId, organizationId: admission.organizationId, ownerKey: admission.ownerKey, hostId: admission.hostId, admittedAt: new Date(admission.createdAt).toISOString() }
    } catch (error) {
      if (error instanceof SessionAdmissionConflict) throw new SolusApiError(409, 'CONFLICT', error.message)
      throw error
    }
  }

  /**
   * The session's first facts are written where the session is admitted
   * (docs/plans/simplify-auth-and-sync.md §4.5): the admission made the row, and
   * this starts it, so an agent's first write that names the session finds its
   * record here. Later facts arrive in the host's delivery. A record that exists
   * is left as it is, so asking again changes nothing.
   */
  private async writeAdmittedRecord(admission: SessionAdmission, record: NonNullable<WorkspaceSessionAdmissionRequest['record']>): Promise<void> {
    const { organizationId, admissionId: sessionId, hostId, ownerKey } = admission
    if (await getSessionRecord(organizationId, sessionId)) return
    await upsertSessionRecord(organizationId, {
      sessionId, provider: record.provider, projectPath: record.projectPath, cwd: record.cwd, projectRoot: record.cwd ? worktreeProjectRoot(record.cwd) : null, lastActivityAt: admission.createdAt, runnerHostId: hostId, status: 'running',
    })
    // A new session is the organization's to open; a chat is its owner's alone until they share it (plan 004 D14).
    if (!record.privateToOwner) await this.shares.shareRunnerWrite({ kind: 'session', id: sessionId }, runnerPrincipalFor({ hostId, organizationId, ownerUserId: ownerKey, expiresAt: Date.now() }), ownerKey)
  }

  async get(context: WorkspaceRequestContext, sessionId: string): Promise<WorkspaceSession> {
    requireScope(context, 'sessions:read')
    await requireResource(this.shares, context, { kind: 'session', id: sessionId }, 'read')
    return this.readOne(context, sessionId)
  }

  async list(context: WorkspaceRequestContext, query: WorkspaceSessionQuery): Promise<WorkspaceSessionPage> {
    query = workspaceSessionQuerySchema.parse(query)
    requireScope(context, 'sessions:read')
    const byActivity = query.order === 'activity'
    const time = byActivity ? 'last_activity_at' : 'created_at'
    const filters = [...this.visible(context),
      seekClause(sql`session_records.${sql.identifier(time)}`, sql`session_records.session_id`, readCursor(query.cursor))]
    if (query.projectId) filters.push(sql`project_remote = ${await projectKeyForId(context, query.projectId)}`)
    if (query.repositoryKey) filters.push(sql`project_remote = ${query.repositoryKey}`)
    if (query.projectPath !== undefined) {
      const normalized = trimTrailingSeparators(query.projectPath)
      const encoded = encodePathAsFolder(normalized)
      filters.push(query.includeWorktrees === 'true' && !isSolusWorktreePath(normalized)
        ? sql`(project_path = ${encoded} OR project_path LIKE ${encoded + SOLUS_WORKTREE_ENCODED_MARKER + '%'})`
        : sql`project_path = ${encoded}`)
    }
    if (query.chats === 'true') filters.push(sql`session_records.place = 'chat'`)
    if (query.provider) filters.push(sql`provider = ${query.provider}`)
    // Top-level sessions, or the ones one session started; the caller's session list
    // unless they ask for every session they may read (docs/plans/session-archive.md).
    const reader = this.reader(context)
    filters.push(query.parentSessionId ? sql`session_records.parent_session_id = ${query.parentSessionId}` : sql`session_records.parent_session_id IS NULL`)
    const where = sql.join(filters, sql` AND `)
    const records = query.scope === 'list' && !query.parentSessionId
      ? await readSessionListPage(where, query.limit + 1, time, reader)
      : await readSessionMetadataPage(where, query.limit + 1, time, reader)
    const page = pageOf(await this.records(context, records), query.limit,
      item => ({ time: Date.parse(byActivity ? item.updatedAt : item.createdAt), id: item.id }))
    return { ...page, indexing: sessionRecordsIndexing() }
  }

  /**
   * The sessions a caller may open that match a query, one page at a time
   * (docs/plans/unified-search.md). A machine answers from its own transcript
   * index; the workspace service, which has no transcript files, answers from
   * the transcripts its runners mirrored. Either way a hit counts only when its
   * record is one the caller may read.
   */
  async search(context: WorkspaceRequestContext, input: WorkspaceSessionSearchQuery): Promise<WorkspaceSessionSearchResult> {
    const query = workspaceSessionSearchQuerySchema.parse(input)
    requireScope(context, 'sessions:read')
    const workspace = isApiMode()
    const { hits, total } = workspace ? await this.mirroredHits(context, query) : await this.indexedHits(context, query)
    const indexing = sessionRecordsIndexing() || (!workspace && sessionMessagesRebuilding())
    if (hits.length === 0) return { items: [], total, indexing }
    const ids = [...new Set(hits.map(hit => hit.sessionId))]
    const records = await readSessionMetadataPage(sql.join([...this.visible(context),
      sql`session_records.session_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`], sql` AND `), ids.length, 'created_at', this.reader(context))
    const sessions = new Map((await this.records(context, records)).map(session => [session.id, session]))
    const items: WorkspaceSessionSearchResult['items'] = []
    for (const hit of hits) {
      const session = sessions.get(hit.sessionId)
      if (!session) continue
      const [best, ...others] = hit.passages
      items.push(best
        ? { ...best, reason: hit.reason, session, additionalMatches: others }
        : { timestamp: Date.parse(session.updatedAt), rank: hit.rank, reason: hit.reason, session, additionalMatches: [] })
    }
    return { items, total, indexing }
  }

  /**
   * Of the named sessions, the ones the caller may read, each with when the
   * caller last read it (a sign of use that reorders message matches), or null.
   * One primary-key read per session named, in lists of `READABLE_CHUNK`.
   */
  private async readableViews(context: WorkspaceRequestContext, sessionIds: readonly string[]): Promise<Map<string, number | null>> {
    const { personKey } = this.reader(context)
    const views = new Map<string, number | null>()
    for (let start = 0; start < sessionIds.length; start += READABLE_CHUNK) {
      const chunk = sessionIds.slice(start, start + READABLE_CHUNK)
      const rows = await getDatabase().all<{ session_id: string; viewed_at: number | null }>(sql`
        SELECT session_records.session_id, reader_view.viewed_at FROM ${sessionTable}
        LEFT JOIN ${personalResourceState} AS reader_view
          ON reader_view.resource_kind = 'session' AND reader_view.resource_id = session_records.session_id
          AND reader_view.organization_id = session_records.organization_id AND reader_view.created_by = ${personKey ?? ''}
        WHERE ${sql.join(this.visible(context), sql` AND `)} AND session_records.started_at IS NOT NULL
          AND session_records.session_id IN (${sql.join(chunk.map(id => sql`${id}`), sql`, `)})`)
      for (const row of rows) views.set(row.session_id, row.viewed_at)
    }
    return views
  }

  private async indexedHits(context: WorkspaceRequestContext, query: SearchRequest): Promise<HitsPage> {
    // A machine's index knows its checkouts, not their repositories: it is searched by `projectRoot`.
    if (query.repositoryKey) throw new SolusApiError(400, 'INVALID_REQUEST', 'A machine searches one project by projectRoot; repositoryKey is answered by the workspace service.')
    const match = matchSessionIndex(query.q, {
      projectRoot: query.projectRoot,
      chats: query.chats === 'true',
      providers: query.provider ? [query.provider] : undefined,
      namesOnly: query.namesOnly === 'true',
      activeSince: query.activeSince,
      metadata: await pullRequestNames(apiScope(context)),
    })
    // The records are read for the matched sessions alone, never for the whole store.
    const views = await this.readableViews(context, match.matched.map(({ candidate }) => candidate.sessionId))
    const viewedAt = new Map<string, number>()
    for (const [sessionId, at] of views) if (at !== null) viewedAt.set(sessionId, at)
    const page = pageSessionMatches(match, { sessionIds: new Set(views.keys()), viewedAt, limit: query.limit, offset: query.offset })
    return {
      total: page.total,
      hits: page.results.map(result => ({
        sessionId: result.session.sessionId,
        rank: result.rank,
        reason: result.reason,
        passages: [...(result.messageId >= 0 ? [result] : []), ...result.additionalMatches ?? []]
          .map(hit => ({ snippet: hit.snippet, timestamp: hit.ts, messageId: hit.messageId, rank: hit.rank, target: hit.target })),
      })),
    }
  }

  private async mirroredHits(context: WorkspaceRequestContext, query: SearchRequest): Promise<HitsPage> {
    const records = [...this.visible(context)]
    if (query.projectRoot) records.push(sql`session_records.project_root = ${query.projectRoot}`)
    if (query.repositoryKey) records.push(sql`session_records.project_remote = ${query.repositoryKey}`)
    if (query.chats === 'true') records.push(sql`session_records.place = 'chat'`)
    if (query.provider) records.push(sql`session_records.provider = ${query.provider}`)
    if (query.activeSince !== undefined) records.push(sql`session_records.last_activity_at >= ${query.activeSince}`)
    records.push(sql`session_records.started_at IS NOT NULL`)
    const db = getDatabase()
    const search = new SearchQuery(query.q)
    const page = await searchIndexFor(db.engine).searchSessions(db, {
      query: search, namesOnly: query.namesOnly === 'true', records: sql.join(records, sql` AND `), limit: query.limit, offset: query.offset, metadata: await pullRequestNames(apiScope(context)),
    })
    return {
      total: page.total,
      hits: page.sessions.map((session) => {
        const rank = session.rank
        return {
          sessionId: session.sessionId,
          rank,
          reason: session.reason,
          passages: session.passages.map(passage => ({
            snippet: search.passage(passage.content, SNIPPET_HIT_OPEN, SNIPPET_HIT_CLOSE),
            timestamp: Math.max(0, Math.trunc(passage.timestamp ?? 0)),
            messageId: passage.position,
            rank,
            target: passage.target,
          })),
        }
      }),
    }
  }

  async messages(context: WorkspaceRequestContext, sessionId: string, query: WorkspacePageQuery): Promise<WorkspaceTranscriptPage> {
    query = workspacePageQuerySchema.parse(query)
    await this.get(context, sessionId)
    return readApiTranscript(context, sessionId, query)
  }
}
