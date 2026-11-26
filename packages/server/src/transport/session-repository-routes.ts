import type { Context, Env, Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { formatSessionCloudScope, SESSION_CODE_URL_PATH, SESSION_REPOSITORY_HEAD_PATH, SESSION_REPOSITORY_TOKEN_PATH, sessionCodeUrlRequestSchema, sessionRepositoryHeadRequestSchema, sessionRepositoryTokenRequestSchema, type SessionCloudScope, type SessionCodeUrlResponse, type SessionRepositoryHeadRequest } from '@solus/contracts/session-repositories'
import type { TokenVerdict } from '../admission/access-tokens'
import { principalForClaims } from '../admission/doors'
import { authorize } from '../admission/access-policy'
import type { ShareManager } from '../sharing/share-manager'
import type { Db } from '../db/database'
import { session } from '../data/sessions/schema'
import { createSessionRepository, readSessionRepository, sessionRepositoryFacts } from '../data/sessions/session-repositories'
import { sessionRepositories } from '../data/sessions/schema'
import type { RepositoryProvider } from '../sync/git-storage/repository-provider'
import { OBJECT_URL_TTL_SECONDS, sessionCodeKey, type ObjectStore } from '../sync/git-storage/object-store'
import { LOCAL_OBJECT_PATH, LocalObjectStore } from '../sync/git-storage/local-object-store'
import { CODE_BUNDLE_MAX_BYTES } from '../git/session-code-bundle'
import { WorkspaceRequestBudgets } from './solus-api/limits'
import { createLogger } from '../logger'
import { SolusApiError } from '../admission/workspace-error'

const log = createLogger('server', 'session-repository-routes')

export interface SessionRepositoryRoutes {
  database: Db
  storage: RepositoryProvider | null
  /** The code bundles of the same repositories (docs/plans/session-storage.md §6). The same switch makes both. */
  code: ObjectStore | null
  shares: ShareManager
  changed(scope: SessionCloudScope, sessionId: string, facts: ReturnType<typeof sessionRepositoryFacts>): Promise<void>
}

export function registerSessionRepositoryRoutes<E extends Env>(app: Hono<E>, options: {
  isApiMode?: boolean
  verifyAccessToken?: (token: string) => Promise<TokenVerdict>
  sessionRepositories?: SessionRepositoryRoutes
}): void {
  const service = options.sessionRepositories
  if (!options.isApiMode || !service) return
  const budgets = new WorkspaceRequestBudgets()

  async function admit(c: Context<E>, hostId: string, sessionId: string): Promise<{ scope: SessionCloudScope; ownerUserId: string } | 'unauthorized' | 'forbidden'> {
    const header = c.req.header('authorization') ?? ''
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    if (!bearer || !options.verifyAccessToken) return 'unauthorized'
    const verdict = await options.verifyAccessToken(bearer)
    if (!verdict.ok || !verdict.claims.act?.host_id) return 'unauthorized'
    const claims = verdict.claims
    if (claims.act.host_id !== hostId) return 'forbidden'
    if (claims.access === 'owner') return !claims.hostKind || claims.hostKind === 'personal' ? { scope: formatSessionCloudScope('person', claims.sub), ownerUserId: claims.sub } : 'forbidden'
    if (claims.access !== 'org-member') return 'forbidden'
    const admission = principalForClaims(claims, claims.organizationId, 'api')
    if (!admission.ok) return 'forbidden'
    const record = await service!.database.get<{ created_by: string }>(sql`SELECT created_by FROM ${session} WHERE session_id = ${sessionId} AND organization_id = ${claims.organizationId} AND publication = 'published'`)
    if (!record || await authorize(admission.principal, 'edit', { kind: 'session', id: sessionId }, { name: 'session.edit', resources: service!.shares }) !== null) return 'forbidden'
    return { scope: formatSessionCloudScope('organization', claims.organizationId), ownerUserId: record.created_by }
  }

  app.post(SESSION_REPOSITORY_TOKEN_PATH, async c => {
    const parsed = sessionRepositoryTokenRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ code: 'forbidden' }, 400)
    // An older host writes manifest version 1. It reads 503 as unavailable and asks again in one hour (decision 7).
    if (parsed.data.format !== 2) return c.json({ code: 'storage_unavailable' }, 503)
    const { hostId, sessionId, access } = parsed.data
    const admitted = await admit(c, hostId, sessionId)
    if (admitted === 'unauthorized' || admitted === 'forbidden') return c.json({ code: admitted }, admitted === 'unauthorized' ? 401 : 403)
    let release: () => void
    try { release = budgets.enter(admitted.ownerUserId) }
    catch (error) { if (error instanceof SolusApiError) return c.json({ error: error.code }, error.status === 429 ? 429 : 503); throw error }
    try {
      if (!service!.storage) return c.json({ code: 'storage_unavailable' }, 503)
      let row = await readSessionRepository(service!.database, admitted.scope, sessionId)
      if (!row && access === 'read') return c.json({ code: 'no_repository' }, 404)
      if (!row) row = await createSessionRepository(service!.database, admitted.scope, sessionId, admitted.ownerUserId, service!.storage.storageScope)
      if (row.storage_scope !== service!.storage.storageScope) return c.json({ code: 'storage_unavailable' }, 503)
      const remote = await service!.storage.remote(row.repository, access)
      log.info('session_repository_token_issued', { cloudScope: admitted.scope, sessionId, access })
      return c.json({ repository: row.repository, remote: remote.url, token: remote.token ?? '', expiresAt: new Date(Date.now() + 900_000).toISOString(), storageScope: row.storage_scope, ...sessionRepositoryFacts(row) })
    } finally { release() }
  })

  app.post(SESSION_CODE_URL_PATH, async c => {
    const parsed = sessionCodeUrlRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ code: 'forbidden' }, 400)
    const { hostId, sessionId, sha256, bytes, access } = parsed.data
    const admitted = await admit(c, hostId, sessionId)
    if (admitted === 'unauthorized' || admitted === 'forbidden') return c.json({ code: admitted }, admitted === 'unauthorized' ? 401 : 403)
    if (access === 'write' && bytes > CODE_BUNDLE_MAX_BYTES) return c.json({ code: 'too_large' }, 413)
    let release: () => void
    try { release = budgets.enter(admitted.ownerUserId) }
    catch (error) { if (error instanceof SolusApiError) return c.json({ error: error.code }, error.status === 429 ? 429 : 503); throw error }
    try {
      if (!service!.storage || !service!.code) return c.json({ code: 'storage_unavailable' }, 503)
      let row = await readSessionRepository(service!.database, admitted.scope, sessionId)
      if (!row && access === 'read') return c.json({ code: 'no_repository' }, 404)
      if (!row) row = await createSessionRepository(service!.database, admitted.scope, sessionId, admitted.ownerUserId, service!.storage.storageScope)
      if (row.storage_scope !== service!.storage.storageScope) return c.json({ code: 'storage_unavailable' }, 503)
      // The API makes the key from the admitted scope and session, so a host cannot name an object of another session.
      const url = await service!.code.signedUrl(sessionCodeKey(admitted.scope, sessionId, sha256), access, { bytes, sha256 })
      log.info('session_code_url_issued', { cloudScope: admitted.scope, sessionId, access, bytes, codeStorageScope: service!.code.storageScope })
      return c.json({ url, expiresAt: new Date(Date.now() + OBJECT_URL_TTL_SECONDS * 1000).toISOString() } satisfies SessionCodeUrlResponse)
    } finally { release() }
  })

  // The local store has no other server: this API receives and serves its objects. The signed token in the query is the credential.
  if (service.code instanceof LocalObjectStore) {
    const local = service.code
    const keyOf = (c: Context<E>) => new URL(c.req.url).pathname.slice(LOCAL_OBJECT_PATH.length + 1).split('/').map(part => {
      try { return decodeURIComponent(part) } catch { return '' }
    }).join('/')
    app.put(`${LOCAL_OBJECT_PATH}/*`, c => local.receive(keyOf(c), c.req.query('token') ?? '', c.req.raw))
    app.get(`${LOCAL_OBJECT_PATH}/*`, c => local.serve(keyOf(c), c.req.query('token') ?? ''))
  }

  app.post(SESSION_REPOSITORY_HEAD_PATH, async c => {
    const parsed = sessionRepositoryHeadRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ code: 'forbidden' }, 400)
    const request = parsed.data
    const admitted = await admit(c, request.hostId, request.sessionId)
    if (admitted === 'unauthorized' || admitted === 'forbidden') return c.json({ code: admitted }, admitted === 'unauthorized' ? 401 : 403)
    let release: () => void
    try { release = budgets.enter(admitted.ownerUserId) }
    catch (error) { if (error instanceof SolusApiError) return c.json({ error: error.code }, error.status === 429 ? 429 : 503); throw error }
    try {
      if (!service!.storage) return c.json({ code: 'storage_unavailable' }, 503)
      const row = await readSessionRepository(service!.database, admitted.scope, request.sessionId)
      if (!row) return c.json({ code: 'no_repository' }, 404)
      if (row.storage_scope !== service!.storage.storageScope) return c.json({ code: 'storage_unavailable' }, 503)
      const result = await updateHead(service!.database, admitted.scope, request)
      if (result.conflict) return c.json({ head: result.row.head }, 409)
      const facts = sessionRepositoryFacts(result.row)
      if (result.changed) await service!.changed(admitted.scope, request.sessionId, facts)
      log.info('session_repository_head_reported', { cloudScope: admitted.scope, sessionId: request.sessionId, event: request.event, changed: result.changed })
      return c.json(facts)
    } finally { release() }
  })
}

async function updateHead(db: Db, scope: SessionCloudScope, request: SessionRepositoryHeadRequest) {
  return db.transaction(async tx => {
    const before = (await readSessionRepository(tx, scope, request.sessionId))!
    if (request.event === 'pushed') {
      if (request.syncedTurn < before.synced_turn || request.syncedTurn === before.synced_turn && request.head !== before.head) return { row: before, conflict: true, changed: false }
      if (request.syncedTurn === before.synced_turn) return { row: before, conflict: false, changed: false }
      const update = await tx.run(sql`UPDATE ${sessionRepositories} SET head = ${request.head}, synced_turn = ${request.syncedTurn}, last_run_host_id = ${request.hostId}, running_host_id = CASE WHEN running_host_id = ${request.hostId} THEN NULL ELSE running_host_id END,
        title = ${request.card.title}, provider = ${request.card.provider}, model = ${request.card.model}, repository_key = ${request.card.repositoryKey}, branch = ${request.card.branch}, last_activity_at = ${request.card.lastActivityAt}
        WHERE cloud_scope = ${scope} AND session_id = ${request.sessionId} AND synced_turn < ${request.syncedTurn}`)
      if (!update.changes) {
        const current = (await readSessionRepository(tx, scope, request.sessionId))!
        return { row: current, conflict: current.synced_turn !== request.syncedTurn || current.head !== request.head, changed: false }
      }
    } else if (request.event === 'running') {
      await tx.run(sql`UPDATE ${sessionRepositories} SET running_host_id = ${request.hostId}, running_since = ${Date.now()} WHERE cloud_scope = ${scope} AND session_id = ${request.sessionId}`)
    } else {
      await tx.run(sql`UPDATE ${sessionRepositories} SET running_host_id = NULL, running_since = NULL WHERE cloud_scope = ${scope} AND session_id = ${request.sessionId} AND running_host_id = ${request.hostId}`)
    }
    const row = (await readSessionRepository(tx, scope, request.sessionId))!
    return { row, conflict: false, changed: JSON.stringify(sessionRepositoryFacts(row)) !== JSON.stringify(sessionRepositoryFacts(before)) }
  })
}
