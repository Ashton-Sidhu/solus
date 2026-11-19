import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { formatSessionCloudScope, type SessionCloudScope, type SessionRepositoryCard } from '@solus/contracts/session-repositories'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { getSessionRecord, isOrganizationWork } from '../../data/sessions/session-records'
import { getDb } from '../../db'
import { sessionCloudSyncDecision } from '../../host/policy/host-policy-store'
import { cloudAccountOf } from '../../host/host-user'
import { createLogger } from '../../logger'
import { DelegationError } from '../delegations'
import { sessionManifestSchema } from './session-manifest'
import type { SessionRemoteAccess } from './session-remote-access'
import type { SessionRepositories } from './session-repository'

const log = createLogger('SessionPush', 'session-push.ts')
const refusedRowSchema = z.object({ push_refused_head: z.string().nullable() })
const rowSchema = z.object({ session_id: z.string(), repository: z.string(), head: z.string().nullable(), turn_count: z.number(),
  cloud_scope: z.string().nullable(), pushed_head: z.string().nullable(), reported_head: z.string().nullable(),
  push_due_at: z.number().nullable(), push_attempts: z.number(), push_refused_head: z.string().nullable() })
type Row = z.infer<typeof rowSchema>
const MAX_BACKOFF_MS = 30 * 60_000

export interface SessionPushDeps {
  repositories: SessionRepositories
  access: SessionRemoteAccess
  hostId: () => string | null
  database?: () => DatabaseSync
  now?: () => number
  retryMs?: number
  decision?: typeof sessionCloudSyncDecision
  accountOf?: typeof cloudAccountOf
  record?: typeof getSessionRecord
}

/** A host-wide push queue. Commit jobs never await it. */
export class SessionPusher {
  private readonly database: () => DatabaseSync
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()
  private readonly scheduled = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private paused = false
  private active = new AbortController()

  constructor(private readonly deps: SessionPushDeps) {
    this.database = deps.database ?? getDb
    this.now = deps.now ?? Date.now
  }

  /** A non-null answer stops all later pushes of this session on this host. */
  refusedHead(sessionId: string): string | null {
    const row = refusedRowSchema.nullish().parse(this.database().prepare('SELECT push_refused_head FROM session_storage WHERE session_id = ?').get(sessionId))
    return row?.push_refused_head ?? null
  }

  /** A turn commit landed. Add only a push job; do not hold the commit queue. */
  committed(sessionId: string): void { this.enqueue(sessionId) }

  /** A running report does not delay turn admission. */
  running(sessionId: string): void {
    void (async () => {
      const record = await (this.deps.record ?? getSessionRecord)(ANY_ORGANIZATION, sessionId)
      if (!record) return
      const accountId = (this.deps.accountOf ?? cloudAccountOf)(record.ownerKey)
      if (!(this.deps.decision ?? sessionCloudSyncDecision)(record.organizationId, accountId ? { accountId } : null).allowed || !accountId) return
      const hostId = this.deps.hostId()
      if (!hostId) return
      const cloudScope = isOrganizationWork(record)
        ? formatSessionCloudScope('organization', record.organizationId) : formatSessionCloudScope('person', accountId)
      await this.deps.access.report({ hostId, sessionId, event: 'running' }, cloudScope, accountId)
    })().catch(() => { log.warn('session_running_report_failed', { sessionId }) })
  }

  /** Scan persisted work on boot or when a delegation becomes available. */
  resume(): void {
    const rows = rowSchema.array().parse(this.database().prepare(`SELECT session_id, repository, head, turn_count, cloud_scope, pushed_head, reported_head,
      push_due_at, push_attempts, push_refused_head FROM session_storage WHERE head IS NOT NULL AND push_refused_head IS NULL
      ORDER BY rowid DESC`).all())
    for (const row of rows) if (row.head !== row.pushed_head || row.head !== row.reported_head) this.enqueue(row.session_id)
  }

  established(): void {
    this.active = new AbortController()
    this.paused = false
    this.database().prepare('UPDATE session_storage SET push_due_at = NULL WHERE push_refused_head IS NULL').run()
    this.resume()
  }
  signedOut(): void {
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.active.abort()
  }
  async idle(): Promise<void> { await this.queue }
  async stop(): Promise<void> { this.stopped = true; this.signedOut(); await this.queue }

  private enqueue(sessionId: string): void {
    if (this.stopped || this.paused || this.scheduled.has(sessionId)) return
    this.scheduled.add(sessionId)
    this.queue = this.queue.then(async () => {
      this.scheduled.delete(sessionId)
      try { await this.process(sessionId) } catch (error) { this.fail(sessionId, error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private row(sessionId: string): Row | null {
    return rowSchema.nullable().parse(this.database().prepare(`SELECT session_id, repository, head, turn_count, cloud_scope, pushed_head, reported_head,
      push_due_at, push_attempts, push_refused_head FROM session_storage WHERE session_id = ?`).get(sessionId) ?? null)
  }

  private async process(sessionId: string): Promise<void> {
    const row = this.row(sessionId)
    if (!row?.head || row.push_refused_head) return
    if ((row.push_due_at ?? 0) > this.now()) { this.wake((row.push_due_at ?? 0) - this.now()); return }
    const record = await (this.deps.record ?? getSessionRecord)(ANY_ORGANIZATION, sessionId)
    if (!record) return
    const accountId = (this.deps.accountOf ?? cloudAccountOf)(record.ownerKey)
    const decision = (this.deps.decision ?? sessionCloudSyncDecision)(record.organizationId, accountId ? { accountId } : null)
    if (!decision.allowed || !accountId) return
    const hostId = this.deps.hostId()
    if (!hostId) return
    const cloudScope = this.scopeOf(record, accountId)
    this.database().prepare('UPDATE session_storage SET cloud_scope = ? WHERE session_id = ?').run(cloudScope, sessionId)
    if (row.head !== row.pushed_head && !await this.pushHead(row, cloudScope, accountId, sessionId)) return
    if (!await this.reportHead(row, cloudScope, accountId, hostId, sessionId, record.provider)) return
    if (this.row(sessionId)?.head !== row.head) this.enqueue(sessionId)
  }

  private scopeOf(record: NonNullable<Awaited<ReturnType<typeof getSessionRecord>>>, accountId: string): SessionCloudScope {
    return isOrganizationWork(record)
      ? formatSessionCloudScope('organization', record.organizationId) : formatSessionCloudScope('person', accountId)
  }

  private async reportHead(row: Row, cloudScope: SessionCloudScope, accountId: string, hostId: string, sessionId: string, provider: SessionRepositoryCard['provider']): Promise<boolean> {
    const head = row.head
    if (head && head !== row.reported_head) {
      const manifest = sessionManifestSchema.parse(JSON.parse(await this.deps.repositories.readText(row.repository, head, 'manifest.json')))
      const lastTurn = manifest.turns.at(-1)
      const card: SessionRepositoryCard = { title: manifest.session.title ?? null, provider,
        model: manifest.session.model ?? null, repositoryKey: manifest.project?.repositoryKey ?? null,
        branch: lastTurn?.head?.branch ?? null, lastActivityAt: lastTurn?.endedAt ?? this.now() }
      const result = await this.deps.access.report({ hostId, sessionId, event: 'pushed', head, syncedTurn: row.turn_count, card }, cloudScope, accountId)
      if (result !== 'accepted') { this.defer(sessionId, 60 * 60_000, 'The session head was not reported.'); return false }
      this.database().prepare('UPDATE session_storage SET reported_head = ?, push_attempts = 0, push_due_at = NULL, push_error = NULL WHERE session_id = ?')
        .run(head, sessionId)
    }
    return true
  }

  private async pushHead(row: Row, cloudScope: SessionCloudScope, accountId: string, sessionId: string): Promise<boolean> {
    const head = row.head
    if (head && head !== row.pushed_head) {
      const answer = await this.deps.access.remote(sessionId, cloudScope, accountId, 'write')
      if (answer.status === 'unavailable') { this.defer(sessionId, 60 * 60_000, 'Cloud session storage is not available.'); return false }
      const result = await this.deps.repositories.push(row.repository, answer.remote.remote, head, row.pushed_head, answer.remote.token || undefined, this.active.signal)
      if (result.status === 'refused') {
        this.database().prepare('UPDATE session_storage SET push_refused_head = ?, push_due_at = NULL, push_error = ? WHERE session_id = ?')
          .run(result.head, 'The remote session has another history.', sessionId)
        log.warn('session_push_refused', { sessionId, remoteHead: result.head })
        return false
      }
      if (result.status === 'failed') throw new Error(`Git ${result.reason}`)
      this.database().prepare('UPDATE session_storage SET pushed_head = ?, push_attempts = 0, push_due_at = NULL, push_error = NULL WHERE session_id = ?')
        .run(head, sessionId)
    }
    return true
  }

  private fail(sessionId: string, error: Error): void {
    const reason = error instanceof DelegationError ? error.code : 'transport'
    if (reason === 'GRANT_REVOKED' || this.paused) return
    const attempts = (this.row(sessionId)?.push_attempts ?? 0) + 1
    const wait = reason === 'ORGANIZATION_AUTHORITY_MISSING' ? 5 * 60_000
      : Math.min(MAX_BACKOFF_MS, (this.deps.retryMs ?? 30_000) * 2 ** Math.min(attempts - 1, 10))
    this.database().prepare('UPDATE session_storage SET push_attempts = ?, push_due_at = ?, push_error = ? WHERE session_id = ?')
      .run(attempts, this.now() + wait, reason, sessionId)
    log.warn('session_push_failed', { sessionId, reason, attempts })
    this.wake(wait)
  }

  private defer(sessionId: string, wait: number, reason: string): void {
    this.database().prepare('UPDATE session_storage SET push_due_at = ?, push_error = ? WHERE session_id = ?').run(this.now() + wait, reason, sessionId)
    this.wake(wait)
  }

  private wake(wait: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.resume() }, Math.max(1, wait))
    this.timer.unref()
  }
}
