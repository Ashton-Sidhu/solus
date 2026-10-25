import { workspaceSessionQuerySchema, workspaceSessionSearchQuerySchema, workspacePageQuerySchema } from '@solus/contracts/solus-api'
import { trimTrailingSeparators } from '@solus/contracts/host-path'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import { markedPassage, queryWords } from '@solus/contracts/word-match'
import { runnerPrincipalFor, type RecordScope } from '../../admission/principal'
import { sql, type SQL } from 'drizzle-orm'
import { encodePathAsFolder, isSolusWorktreePath, SOLUS_WORKTREE_ENCODED_MARKER, type SessionRecord } from '@solus/contracts/types'
import { CHAT_ROOT_NAME } from '@solus/contracts/chat'
import { workspaceSessionAdmissionRequestSchema, workspaceUpdateSessionSchema } from '@solus/contracts/solus-api'
import type { WorkspaceSession, WorkspaceSessionChanged, WorkspaceSessionPullRequestList, WorkspaceUpdateSession, WorkspaceSessionAdmission, WorkspaceSessionAdmissionRequest, WorkspaceSessionPage, WorkspaceSessionQuery, WorkspaceSessionSearchQuery, WorkspaceSessionSearchResult, WorkspacePageQuery, WorkspaceTranscriptPage } from '@solus/contracts/solus-api'
import { getDatabase } from '../../db/database'
import { searchIndexFor } from '../../db/search-index'
import { sessionMessagesRebuilding } from '../../db/session-indexer'
import { searchSessionIndex } from '../../db/session-search'
import { isApiMode } from '../../host/api-mode'
import { SolusApiError } from '../../admission/workspace-error'
import type { ShareManager } from '../../sharing/share-manager'
import { scopeClause } from '../scope'
import { apiScope, projectIdsForKeys, projectKeyForId, requireResource, requireScope } from '../workspace/context'
import { pageOf, readCursor, seekClause } from '../workspace/page'
import { workspaceResourceVisibility } from '../tasks/resource-visibility'
import { getSessionRecord, readSessionMetadataPage, sessionListedClause, sessionRecordsIndexing, upsertSessionRecord } from './session-records'
import { readApiTranscript } from './api-transcript'
import { admitSessionRecord, SessionAdmissionConflict, type SessionAdmission } from './session-admissions'
import { resolveSessionLineageById } from './session-lineage'
import { readSessionPullRequests } from './session-pull-requests'
import { SessionShelf, SessionViewer } from './session-states'
import { UNSETTLED_SESSION_STATE } from '@solus/contracts/session-state'
import { actorFor, ownerKeyOf } from '../../admission/actor'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'

/**
 * The words each session is also known by: the number and title of each pull
 * request linked to it, keyed by every provider thread of the session, since
 * the transcript index names a session by its thread.
 */
async function pullRequestNames(scope: RecordScope): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const [sessionId, links] of Object.entries(await readSessionPullRequests(scope))) {
    const text = links.map(link => `#${link.number} ${link.title}`).join('\n')
    const threads = resolveSessionLineageById(sessionId)?.members.flatMap(member => member.providerSessionId ? [member.providerSessionId] : []) ?? []
    for (const id of [sessionId, ...threads]) names.set(id, text)
  }
  return names
}

type SearchQuery = ReturnType<typeof workspaceSessionSearchQuerySchema.parse>
type SearchHit = WorkspaceSessionSearchResult['items'][number]['additionalMatches'][number]
/** One session's passages, best first, before its record is checked. A
 *  session that matched by its name alone has none. */
interface SessionHits { sessionId: string; passages: SearchHit[]; rank: number }
/** One page of matching sessions and how many match in all. */
interface HitsPage { hits: SessionHits[]; total: number }

/** The longest name the API's session schema carries. A session with no
 *  title is named by its opening message, which can be any length; one
 *  longer name failed a client's check of the whole page, and the picker
 *  listed no session at all. */
const SESSION_NAME_LIMIT = 500

function withinNameLimit(text: string | null): string | null {
  if (text === null || text.length <= SESSION_NAME_LIMIT) return text
  // The schema counts UTF-16 units. Never end on half of a surrogate pair.
  let end = SESSION_NAME_LIMIT - 1
  if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1
  return `${text.slice(0, end)}…`
}

export class SessionApiOperations {
  constructor(private readonly shares: ShareManager) {}

  private async records(context: WorkspaceRequestContext, records: SessionRecord[]): Promise<WorkspaceSession[]> {
    const projects = await projectIdsForKeys(context, records.flatMap(session => session.projectRemote ? [session.projectRemote] : []))
    const links = records.length ? await readSessionPullRequests(apiScope(context), records.map(session => session.sessionId)) : {}
    const access = await this.shares.accessOf(context.principal, 'session', records.map(session => session.sessionId))
    return records.map(session => ({
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
      state: session.state ?? null,
      view: session.view ?? null,
      listed: session.listed ?? true,
      pullRequests: links[session.sessionId] ?? [],
    }))
  }

  /** Who reads a page: the caller's person, for their view and list. */
  private reader(context: WorkspaceRequestContext) {
    return { personKey: ownerKeyOf(actorFor(context.principal)), now: Date.now() }
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
   * Settle a session for every person (editor), or archive and snooze it in
   * the caller's own list (viewer). The access check runs before any write, so
   * a refused change writes nothing. The answer is what the change left: the
   * state when it settled or unsettled, the caller's view when it changed that.
   */
  async update(context: WorkspaceRequestContext, sessionId: string, input: WorkspaceUpdateSession): Promise<WorkspaceSessionChanged> {
    input = workspaceUpdateSessionSchema.parse(input)
    requireScope(context, 'sessions:write')
    await requireResource(this.shares, context, { kind: 'session', id: sessionId }, input.settled === undefined ? 'read' : 'edit')
    const changed: WorkspaceSessionChanged = {}
    const shelf = new SessionShelf(sessionId)
    if (input.settled === true) changed.state = await shelf.settle('person') ?? await shelf.state()
    if (input.settled === false) {
      await shelf.unsettle()
      changed.state = UNSETTLED_SESSION_STATE
    }
    if (input.archived !== undefined || input.snoozedUntil !== undefined) {
      const viewer = new SessionViewer(sessionId, this.personKey(context))
      if (input.archived === true) await viewer.archive()
      if (input.archived === false) await viewer.unarchive()
      if (input.snoozedUntil !== undefined) await viewer.snooze(input.snoozedUntil, input.snoozeNote)
      changed.view = await viewer.view()
    }
    return changed
  }

  async pullRequests(context: WorkspaceRequestContext, sessionId: string): Promise<WorkspaceSessionPullRequestList> {
    requireScope(context, 'sessions:read')
    await requireResource(this.shares, context, { kind: 'session', id: sessionId }, 'read')
    return { items: (await readSessionPullRequests(apiScope(context), [sessionId]))[sessionId] ?? [] }
  }

  /** The records a caller may read: its scope, then what sharing and parentage let it see. */
  private visible(context: WorkspaceRequestContext): SQL[] {
    return [scopeClause(apiScope(context), sql`session_records.organization_id`),
      workspaceResourceVisibility(context.principal, 'session', { id: sql`session_records.session_id`, organization: sql`session_records.organization_id`, owner: sql`session_records.owner_key` })]
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
      const admission = await admitSessionRecord({ organizationId: context.home.organizationId, admissionId: input.sessionId, hostId: delegation.hostId, ownerKey: context.principal.userId })
      if (input.record) await this.writeAdmittedRecord(admission, input.record)
      return { sessionId: admission.admissionId, organizationId: admission.organizationId, ownerKey: admission.ownerKey, hostId: admission.hostId, admittedAt: new Date(admission.createdAt).toISOString() }
    } catch (error) {
      if (error instanceof SessionAdmissionConflict) throw new SolusApiError(409, 'CONFLICT', error.message)
      throw error
    }
  }

  /**
   * The session record is written where the session is admitted
   * (docs/plans/simplify-auth-and-sync.md §4.5): an agent's first write that names
   * the session finds it here. Later facts arrive in the host's delivery. A record
   * that exists is left as it is, so asking again changes nothing.
   */
  private async writeAdmittedRecord(admission: SessionAdmission, record: NonNullable<WorkspaceSessionAdmissionRequest['record']>): Promise<void> {
    const { organizationId, admissionId: sessionId, hostId, ownerKey } = admission
    if (await getSessionRecord(organizationId, sessionId)) return
    await upsertSessionRecord(organizationId, {
      sessionId, provider: record.provider, projectPath: record.projectPath, cwd: record.cwd, lastActivityAt: admission.createdAt, runnerHostId: hostId, status: 'running',
    }, { organizationId, published: true, ownerKey })
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
    // A chat's folder is `solus-chats/<id>`, which the provider spells `-solus-chats-<id>`.
    if (query.chats === 'true') filters.push(sql`project_path LIKE ${`%${encodePathAsFolder(`/${CHAT_ROOT_NAME}/`)}%`}`)
    if (query.provider) filters.push(sql`provider = ${query.provider}`)
    // Top-level sessions, or the ones one session started; the caller's session list
    // unless they ask for every session they may read (docs/plans/session-archive.md).
    const reader = this.reader(context)
    filters.push(query.parentSessionId ? sql`session_records.parent_session_id = ${query.parentSessionId}` : sql`session_records.parent_session_id IS NULL`)
    if (query.scope === 'list' && !query.parentSessionId) filters.push(sessionListedClause(reader))
    const page = pageOf(await this.records(context, await readSessionMetadataPage(sql.join(filters, sql` AND `), query.limit + 1, time, reader)), query.limit,
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
        ? { ...best, session, additionalMatches: others }
        : { timestamp: Date.parse(session.updatedAt), rank: hit.rank, session, additionalMatches: [] })
    }
    return { items, total, indexing }
  }

  private async indexedHits(context: WorkspaceRequestContext, query: SearchQuery): Promise<HitsPage> {
    // A machine's index knows its checkouts, not their repositories: it is searched by `projectRoot`.
    if (query.repositoryKey) throw new SolusApiError(400, 'INVALID_REQUEST', 'A machine searches one project by projectRoot; repositoryKey is answered by the workspace service.')
    const page = searchSessionIndex(query.q, {
      projectRoot: query.projectRoot,
      providers: query.provider ? [query.provider] : undefined,
      namesOnly: query.namesOnly === 'true',
      activeSince: query.activeSince,
      metadata: await pullRequestNames(apiScope(context)),
      limit: query.limit,
      offset: query.offset,
    })
    return {
      total: page.total,
      hits: page.results.map(result => ({
        sessionId: result.session.sessionId,
        rank: result.rank,
        passages: [...(result.messageId >= 0 ? [result] : []), ...result.additionalMatches ?? []]
          .map(hit => ({ snippet: hit.snippet, timestamp: hit.ts, messageId: hit.messageId, rank: hit.rank })),
      })),
    }
  }

  private async mirroredHits(context: WorkspaceRequestContext, query: SearchQuery): Promise<HitsPage> {
    const records = [...this.visible(context)]
    if (query.projectRoot) records.push(sql`session_records.project_root = ${query.projectRoot}`)
    if (query.repositoryKey) records.push(sql`session_records.project_remote = ${query.repositoryKey}`)
    if (query.provider) records.push(sql`session_records.provider = ${query.provider}`)
    if (query.activeSince !== undefined) records.push(sql`session_records.last_activity_at >= ${query.activeSince}`)
    const db = getDatabase()
    const words = queryWords(query.q)
    const page = await searchIndexFor(db.engine).searchSessions(db, {
      words, namesOnly: query.namesOnly === 'true', records: sql.join(records, sql` AND `), limit: query.limit, offset: query.offset,
    })
    return {
      total: page.total,
      hits: page.sessions.map((session, index) => {
        // The service ranks in SQL: a session's rank is its place in the whole answer.
        const rank = query.offset + index
        return {
          sessionId: session.sessionId,
          rank,
          passages: session.passages.map(passage => ({
            snippet: markedPassage(passage.content, words, SNIPPET_HIT_OPEN, SNIPPET_HIT_CLOSE),
            timestamp: Math.max(0, Math.trunc(passage.timestamp ?? 0)),
            messageId: passage.position,
            rank,
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
