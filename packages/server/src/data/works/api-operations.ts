import { workspaceWorkQuerySchema, workspaceWorkSearchQuerySchema, workspaceCreateWorkSchema, workspaceImportWorkSchema, workspacePublishWorkSchema, workspaceRequestWorkReviewSchema, workspaceUpdateWorkSchema } from '@solus/contracts/solus-api'
import { importDocFromUrl, publishWork, pullWorkUpstream, type PublishWorkOptions } from './work-sync'
import { docProviderAdapter } from '../../docs/registry'
import { searchWorks } from './work-search'
import { linkWorkToSessionTasks } from './work-tasks'
import { sql } from 'drizzle-orm'
import { workPreview } from '@solus/contracts/work-preview'
import type { Work as WorkRecord, WorkMeta } from '@solus/contracts/types'
import type { WorkspaceCreateWork, WorkspaceImportWork, WorkspacePublishWork, WorkspaceRequestWorkReview, WorkspaceWorkReview, WorkspaceWorkUpstream, WorkspaceUpdateWork, WorkspaceWork, WorkspaceWorkSummary, WorkspaceWorkPage, WorkspaceWorkQuery, WorkspaceWorkSearchQuery, WorkspaceWorkSearchResult } from '@solus/contracts/solus-api'
import { requestAttribution, workspaceAuthorityKey, type WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import { getDatabase } from '../../db/database'
import { hostUserKey } from '../../host/host-user'
import type { ShareManager } from '../../sharing/share-manager'
import { scopeClause } from '../scope'
import { apiOrganization, apiScope, projectIdsForKeys, projectKeyForId, requireResource, requireScope } from '../workspace/context'
import { pageOf, readCursor, seekClause } from '../workspace/page'
import { canonicalRequest, createWithReceipt } from '../workspace/receipts'
import { workspaceResourceVisibility } from '../tasks/resource-visibility'
import { getSessionRecord } from '../sessions/session-records'
import { works } from './schema'
import { createWork, loadWork, readWorkMetadataPage } from './works'
import { Work, WorkContentInvalidError, WorkVersionConflictError } from './work'
import { announceWorkDeleted } from './work-events'
import { requestWorkReview, shareWithReviewers } from './work-reviews'
import { actorFor } from '../../admission/actor'

/** The domain's refusals, as the API answers them. */
async function domainAnswer<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (error instanceof WorkVersionConflictError) throw new SolusApiError(412, 'STALE_VERSION', error.message)
    if (error instanceof WorkContentInvalidError) throw new SolusApiError(400, 'INVALID_REQUEST', error.message.slice(0, 1000))
    throw error
  }
}

export class WorkApiOperations {
  constructor(private readonly shares: ShareManager) {}

  private async summaries(context: WorkspaceRequestContext, records: (WorkMeta & { id: string })[]): Promise<WorkspaceWorkSummary[]> {
    const owners = await this.shares.ownersOf('work', records.map(work => work.id))
    const projects = await projectIdsForKeys(context, records.map(work => work.cwd))
    return records.map(work => ({
      id: work.id, home: context.home, organizationId: work.organizationId === 'local' ? null : work.organizationId,
      ownerUserId: owners.get(work.id) ?? hostUserKey(), version: work.updatedAt,
      createdAt: work.createdAt, updatedAt: work.updatedAt, title: work.title, type: work.type,
      preview: work.preview, sessionIds: work.sessionIds ?? (work.sessionId ? [work.sessionId] : []),
      projectId: projects.get(work.organizationId)?.get(work.cwd) ?? null, pinned: work.pinned ?? false,
      editable: work.mirroredDoc?.provider !== 'gdrive', cwd: work.cwd, agentProvider: work.agentProvider, mirroredDoc: work.mirroredDoc,
    }))
  }

  /** `version` is the record's ETag; `contentVersion` is the body's own version. */
  private async records(context: WorkspaceRequestContext, records: WorkRecord[]): Promise<WorkspaceWork[]> {
    const summaries = await this.summaries(context, records)
    return summaries.map((summary, index) => {
      const { content, contentVersion, contentHash, contentAuthor } = records[index]!
      return { ...summary, content, contentVersion, contentHash, contentAuthor }
    })
  }

  private async read(context: WorkspaceRequestContext, workId: string): Promise<WorkRecord> {
    const work = await loadWork(apiScope(context), workId)
    if (!work) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
    return work
  }

  async version(context: WorkspaceRequestContext, workId: string): Promise<string> {
    requireScope(context, 'works:read')
    await requireResource(this.shares, context, { kind: 'work', id: workId }, 'viewer')
    const work = await Work.find(apiScope(context), workId)
    if (!work) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
    return work.updatedAt
  }

  async get(context: WorkspaceRequestContext, workId: string): Promise<WorkspaceWork> {
    requireScope(context, 'works:read')
    await requireResource(this.shares, context, { kind: 'work', id: workId }, 'viewer')
    return (await this.records(context, [await this.read(context, workId)]))[0]
  }

  async list(context: WorkspaceRequestContext, query: WorkspaceWorkQuery): Promise<WorkspaceWorkPage> {
    query = workspaceWorkQuerySchema.parse(query)
    requireScope(context, 'works:read')
    const filters = [scopeClause(apiScope(context), sql`works.organization_id`),
      workspaceResourceVisibility(context.principal, 'work', sql`works.id`, sql`works.organization_id`),
      seekClause(sql`works.created_at`, sql`works.id`, readCursor(query.cursor))]
    if (query.projectId) filters.push(sql`cwd = ${await projectKeyForId(context, query.projectId)}`)
    if (query.type) filters.push(sql`type = ${query.type}`)
    if (query.sessionId) {
      await requireResource(this.shares, context, { kind: 'session', id: query.sessionId }, 'viewer')
      // Additional session links are stored in the portable JSON metadata.
      const db = getDatabase()
      filters.push(db.engine === 'postgres'
        ? sql`(session_id = ${query.sessionId} OR (meta::jsonb->'sessionIds') ? ${query.sessionId})`
        : sql`(session_id = ${query.sessionId} OR EXISTS (SELECT 1 FROM json_each(meta, '$.sessionIds') WHERE value = ${query.sessionId}))`)
    }
    const records = await readWorkMetadataPage(sql.join(filters, sql` AND `), query.limit + 1)
    return pageOf(await this.summaries(context, records), query.limit, item => ({ time: Date.parse(item.createdAt), id: item.id }))
  }

  /** Content search in the caller's scope; a hit the caller may not open is dropped before it is answered. */
  async search(context: WorkspaceRequestContext, input: WorkspaceWorkSearchQuery): Promise<WorkspaceWorkSearchResult> {
    const query = workspaceWorkSearchQuerySchema.parse(input)
    requireScope(context, 'works:read')
    const hits = await searchWorks(apiScope(context), query.q, { type: query.type, limit: query.limit })
    const visible = await this.shares.filterVisible(context.principal, 'work', hits, (hit) => hit.id)
    return { items: visible.map(({ id, title, type, updatedAt, snippet }) => ({ id, title: title.slice(0, 500), type, updatedAt, snippet: snippet.slice(0, 2000) })) }
  }

  async create(context: WorkspaceRequestContext, input: WorkspaceCreateWork, key: string): Promise<WorkspaceWork> {
    input = workspaceCreateWorkSchema.parse(input)
    requireScope(context, 'works:write')
    if (context.principal.kind === 'guest') throw new SolusApiError(403, 'FORBIDDEN', 'Guests cannot create root works.')
    const projectKey = input.projectId ? await projectKeyForId(context, input.projectId) : input.projectKey ?? null
    const session = await this.parentSession(context, input.originSessionId)
    return createWithReceipt(workspaceAuthorityKey(context), 'work', key, canonicalRequest(input), async () => {
      if (input.id && await loadWork(apiScope(context), input.id)) throw new SolusApiError(409, 'CONFLICT', 'This work already exists.')
      const work = await domainAnswer(() => createWork(apiOrganization(context), input.title, input.type, input.content,
        workPreview(input.type, input.content), input.originSessionId ?? undefined, session?.provider ?? input.agentProvider ?? 'claude-code', projectKey ?? '~', input.id, requestAttribution(context)))
      await this.shares.claimOwner({ kind: 'work', id: work.id }, context.principal)
      if (context.actingAgent?.linkWorkToTask !== false) await linkWorkToSessionTasks(apiScope(context), work)
      return (await this.records(context, [work]))[0]
    }, async workId => {
      await requireResource(this.shares, context, { kind: 'work', id: workId }, 'editor')
      return (await this.records(context, [await this.read(context, workId)]))[0]
    })
  }

  /** The session a new work names, which the caller must be able to edit; an agent's own session may not have reached this service yet. */
  private async parentSession(context: WorkspaceRequestContext, originSessionId: string | null | undefined) {
    if (!originSessionId) return null
    await requireResource(this.shares, context, { kind: 'session', id: originSessionId }, 'editor')
    const session = await getSessionRecord(apiScope(context), originSessionId)
    if (!session && !context.actingAgent) throw new SolusApiError(404, 'NOT_FOUND', 'Parent session not found.')
    return session
  }

  /**
   * An upstream document imported as a work linked to its source (organization-vms §3):
   * read with the caller's own account connection — for an agent run, its person's —
   * and owned by the caller in the caller's organization.
   */
  async import(context: WorkspaceRequestContext, input: WorkspaceImportWork, key: string): Promise<WorkspaceWork> {
    input = workspaceImportWorkSchema.parse(input)
    requireScope(context, 'works:write')
    if (context.principal.kind === 'guest') throw new SolusApiError(403, 'FORBIDDEN', 'Guests cannot import works.')
    const session = await this.parentSession(context, input.originSessionId)
    return createWithReceipt(workspaceAuthorityKey(context), 'work', key, canonicalRequest(input), async () => {
      let imported
      try {
        imported = await importDocFromUrl(apiOrganization(context), input.url, { cwd: input.projectKey ?? '~', sessionId: input.originSessionId ?? undefined, agentProvider: session?.provider })
      } catch (error) {
        // The link cannot be read: not a supported document, or the person's connection is missing or refused.
        throw new SolusApiError(400, 'INVALID_REQUEST', (error instanceof Error ? error.message : String(error)).slice(0, 1000))
      }
      await this.shares.claimOwner({ kind: 'work', id: imported.work.id }, context.principal)
      if (context.actingAgent?.linkWorkToTask !== false) await linkWorkToSessionTasks(apiScope(context), imported.work)
      return (await this.records(context, [imported.work]))[0]
    }, async workId => {
      await requireResource(this.shares, context, { kind: 'work', id: workId }, 'editor')
      return (await this.records(context, [await this.read(context, workId)]))[0]
    })
  }

  /**
   * Publishes the work to its upstream document with the caller's own account
   * connection — for an agent run, its person's — or creates that document on the
   * first publish. A changed upstream is answered as a conflict, never overwritten
   * unless the caller asked.
   */
  async publish(context: WorkspaceRequestContext, workId: string, input: WorkspacePublishWork): Promise<WorkspaceWorkUpstream> {
    input = workspacePublishWorkSchema.parse(input)
    requireScope(context, 'works:write')
    await requireResource(this.shares, context, { kind: 'work', id: workId }, 'editor')
    const work = await this.read(context, workId)
    const options: PublishWorkOptions = {}
    if (input.overwrite) options.force = true
    if (!work.mirroredDoc) {
      if (!input.provider || !input.scope) throw new SolusApiError(400, 'INVALID_REQUEST', 'This work has never been published. Pass provider and scope (a Confluence space key or a Drive folder id) the first time.')
      const adapter = docProviderAdapter(input.provider)
      const status = await adapter.status()
      if (!status.connected) throw new SolusApiError(400, 'INVALID_REQUEST', status.reason ?? `${input.provider} is not connected.`)
      options.destination = { provider: adapter.id, scope: input.scope, label: input.scope }
    }
    const result = await publishWork(apiScope(context), workId, options)
    if (result.ok) return { outcome: 'published', title: work.title, url: result.link.url, lossyParts: result.lossyParts ?? [] }
    if (result.conflict) return { outcome: 'conflict', title: work.title, url: result.link.url, lossyParts: [] }
    throw new SolusApiError(400, 'INVALID_REQUEST', result.error.slice(0, 1000))
  }

  /** Replaces the work's content with its upstream document's, read with the caller's own connection; the previous content stays as a revision. */
  async pullUpstream(context: WorkspaceRequestContext, workId: string): Promise<WorkspaceWorkUpstream> {
    requireScope(context, 'works:write')
    await requireResource(this.shares, context, { kind: 'work', id: workId }, 'editor')
    const result = await pullWorkUpstream(apiScope(context), workId)
    if (!result.ok) throw new SolusApiError(400, 'INVALID_REQUEST', result.error.slice(0, 1000))
    return { outcome: 'pulled', title: result.title, url: result.link.url, lossyParts: result.lossyParts ?? [] }
  }

  /** Asks members to review the body at the version the caller read. The API
   *  knows only ids; a client shows each reviewer by their directory name. */
  async requestReview(context: WorkspaceRequestContext, workId: string, input: WorkspaceRequestWorkReview): Promise<WorkspaceWorkReview> {
    input = workspaceRequestWorkReviewSchema.parse(input)
    requireScope(context, 'works:write')
    await requireResource(this.shares, context, { kind: 'work', id: workId }, 'editor')
    // One transaction: a refused request gives nobody access.
    const review = await getDatabase().transaction(async () => {
      const requested = await domainAnswer(() => requestWorkReview(apiScope(context), workId, {
        reviewers: input.reviewerIds.map((userId) => ({ userId, displayName: userId })),
        message: input.message,
        expectedContentVersion: input.expectedContentVersion,
      }, actorFor(context.principal).user))
      await shareWithReviewers(this.shares, context.principal, workId, input.reviewerIds)
      return requested
    })
    return {
      state: review.state,
      reviewers: review.reviewers.map(({ reviewerId, displayName, decision, isStale, isAwaiting }) => ({ reviewerId, displayName, decision, isStale, isAwaiting })),
    }
  }

  /** Holds the row for the transaction and refuses a write against a version the caller has not seen. */
  private async locked(context: WorkspaceRequestContext, workId: string, version: string): Promise<WorkRecord> {
    const db = getDatabase()
    await db.all(sql`SELECT id FROM ${works} WHERE id = ${workId} AND ${scopeClause(apiScope(context))} ${db.engine === 'postgres' ? sql`FOR UPDATE` : sql``}`)
    const work = await this.read(context, workId)
    if (work.updatedAt !== version) throw new SolusApiError(412, 'STALE_VERSION', 'Read the latest version before saving.')
    return work
  }

  async update(context: WorkspaceRequestContext, workId: string, input: WorkspaceUpdateWork, version: string): Promise<WorkspaceWork> {
    input = workspaceUpdateWorkSchema.parse(input)
    requireScope(context, 'works:write')
    return getDatabase().transaction(async () => {
      await requireResource(this.shares, context, { kind: 'work', id: workId }, 'editor')
      const work = await this.locked(context, workId, version)
      if (work.mirroredDoc?.provider === 'gdrive') throw new SolusApiError(409, 'READ_ONLY_RESOURCE', 'Edit this work in Google Docs, then pull the latest content.')
      // The record version is checked again inside the domain transaction,
      // with the content version the writer read: the ETag alone may have
      // been fetched at write time.
      const entity = await Work.byId(apiScope(context), workId)
      const { content, title, expectedContentVersion } = input
      if (content !== undefined) {
        if (expectedContentVersion === undefined) throw new SolusApiError(400, 'INVALID_REQUEST', 'A content write names the expectedContentVersion it read.')
        await domainAnswer(() => entity.updateContent({ content, title, expectedUpdatedAt: version, expectedContentVersion, author: requestAttribution(context), reason: context.actingAgent ? 'agent' : 'edit' }))
      } else if (title !== undefined) await domainAnswer(() => entity.updateTitle({ title, expectedUpdatedAt: version }))
      const saved = entity.record()
      await linkWorkToSessionTasks(apiScope(context), saved)
      return (await this.records(context, [saved]))[0]
    })
  }

  async delete(context: WorkspaceRequestContext, workId: string, version: string): Promise<void> {
    requireScope(context, 'works:write')
    await getDatabase().transaction(async () => {
      await requireResource(this.shares, context, { kind: 'work', id: workId }, 'owner')
      await this.locked(context, workId, version)
      const work = await Work.byId(apiScope(context), workId)
      // A person's delete, not a Share's removal of the source: an open reader
      // stops and says so. Its readers are decided here, while its grants
      // exist, and hear it after commit, like every other work change.
      await announceWorkDeleted({ workId, version: work.updatedAt, contentVersion: work.contentVersion })
      await work.delete()
      await this.shares.forget({ kind: 'work', id: workId })
    })
  }
}
