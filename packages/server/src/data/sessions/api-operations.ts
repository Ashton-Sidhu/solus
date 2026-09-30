import { workspaceSessionQuerySchema, workspaceSessionSearchQuerySchema, workspacePageQuerySchema } from '@solus/contracts/solus-api'
import { SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import { markedPassage, queryWords } from '@solus/contracts/word-match'
import type { RecordScope } from '../../admission/principal'
import { sql, type SQL } from 'drizzle-orm'
import { encodePathAsFolder, isSolusWorktreePath, SOLUS_WORKTREE_ENCODED_MARKER, type SessionRecord } from '@solus/contracts/types'
import { workspaceSessionAdmissionRequestSchema } from '@solus/contracts/solus-api'
import type { WorkspaceSession, WorkspaceSessionAdmission, WorkspaceSessionAdmissionRequest, WorkspaceSessionPage, WorkspaceSessionQuery, WorkspaceSessionSearchQuery, WorkspaceSessionSearchResult, WorkspacePageQuery, WorkspaceTranscriptPage } from '@solus/contracts/solus-api'
import { getDatabase } from '../../db/database'
import { hostUserKey } from '../../host/host-user'
import { searchIndexFor } from '../../db/search-index'
import { sessionMessagesRebuilding } from '../../db/session-indexer'
import { searchSessionIndex } from '../../db/session-search'
import { isApiMode } from '../../host/api-mode'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import type { ShareManager } from '../../sharing/share-manager'
import { scopeClause } from '../scope'
import { apiScope, projectIdsForKeys, projectKeyForId, requireResource, requireScope } from '../workspace/context'
import { pageOf, readCursor, seekClause } from '../workspace/page'
import { workspaceResourceVisibility } from '../tasks/resource-visibility'
import { getSessionRecord, readSessionMetadataPage, sessionRecordsIndexing } from './session-records'
import { readApiTranscript } from './api-transcript'
import { admitSessionRecord, SessionAdmissionConflict } from './session-admissions'
import { resolveSessionLineageById } from './session-lineage'
import { readSessionPullRequests } from './session-pull-requests'

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
    return records.map(session => ({
      id: session.sessionId, home: context.home, organizationId: session.organizationId === 'local' ? null : session.organizationId,
      ownerUserId: session.ownerUserId ?? hostUserKey(), version: String(session.lastActivityAt),
      createdAt: new Date(session.createdAt).toISOString(), updatedAt: new Date(session.lastActivityAt).toISOString(),
      provider: session.provider, title: withinNameLimit(session.title), customTitle: withinNameLimit(session.customTitle),
      projectId: session.projectRemote ? projects.get(session.organizationId)?.get(session.projectRemote) ?? null : null,
      projectPath: session.projectPath, projectRemote: session.projectRemote, runnerHostId: session.runnerHostId,
      status: session.status, model: session.model, reasoningEffort: session.reasoningEffort ?? null,
      parentSessionId: session.parentSessionId, rootSessionId: session.rootSessionId,
      publication: session.publication, size: session.size,
      cwd: session.cwd, slug: withinNameLimit(session.slug), isWorktree: session.isWorktree, branch: session.branch, projectRoot: session.projectRoot, delegation: session.delegation,
    }))
  }

  /** The records a caller may read: its scope, then what sharing and parentage let it see. */
  private visible(context: WorkspaceRequestContext): SQL[] {
    return [scopeClause(apiScope(context), sql`session_records.organization_id`),
      workspaceResourceVisibility(context.principal, 'session', sql`session_records.session_id`, sql`session_records.organization_id`)]
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
      const admission = await admitSessionRecord({ organizationId: context.home.organizationId, admissionId: input.sessionId, hostId: delegation.hostId, ownerUserId: context.principal.userId })
      return { sessionId: admission.admissionId, organizationId: admission.organizationId, ownerUserId: admission.ownerUserId, hostId: admission.hostId, admittedAt: new Date(admission.createdAt).toISOString() }
    } catch (error) {
      if (error instanceof SessionAdmissionConflict) throw new SolusApiError(409, 'CONFLICT', error.message)
      throw error
    }
  }

  async get(context: WorkspaceRequestContext, sessionId: string): Promise<WorkspaceSession> {
    requireScope(context, 'sessions:read')
    await requireResource(this.shares, context, { kind: 'session', id: sessionId }, 'viewer')
    const record = await getSessionRecord(apiScope(context), sessionId)
    if (!record) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
    return (await this.records(context, [record]))[0]
  }

  async list(context: WorkspaceRequestContext, query: WorkspaceSessionQuery): Promise<WorkspaceSessionPage> {
    query = workspaceSessionQuerySchema.parse(query)
    requireScope(context, 'sessions:read')
    const filters = [...this.visible(context),
      seekClause(sql`session_records.created_at`, sql`session_records.session_id`, readCursor(query.cursor))]
    if (query.projectId) filters.push(sql`project_remote = ${await projectKeyForId(context, query.projectId)}`)
    if (query.projectPath !== undefined) {
      const normalized = query.projectPath.replace(/\/$/, '')
      const encoded = encodePathAsFolder(normalized)
      filters.push(query.includeWorktrees === 'true' && !isSolusWorktreePath(normalized)
        ? sql`(project_path = ${encoded} OR project_path LIKE ${encoded + SOLUS_WORKTREE_ENCODED_MARKER + '%'})`
        : sql`project_path = ${encoded}`)
    }
    if (query.provider) filters.push(sql`provider = ${query.provider}`)
    const page = pageOf(await this.records(context, await readSessionMetadataPage(sql.join(filters, sql` AND `), query.limit + 1)), query.limit, item => ({ time: Date.parse(item.createdAt), id: item.id }))
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
      sql`session_records.session_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`], sql` AND `), ids.length)
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
