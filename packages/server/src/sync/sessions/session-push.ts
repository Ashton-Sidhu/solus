import type { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { SESSION_CODE_CHECKSUM_HEADER, type SessionRepositoryCard } from '@solus/contracts/session-repositories'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { getSessionRecord } from '../../data/sessions/session-records'
import { readSessionStorage } from '../../data/sessions/session-storage'
import { getDb } from '../../db'
import { sessionCloudSyncDecision } from '../../host/policy/host-policy-store'
import { cloudAccountOf } from '../../host/host-user'
import { createLogger } from '../../logger'
import { DelegationError } from '../delegations'
import type { SessionCloudIdentity, SessionRemoteAccess } from './session-remote-access'
import type { SessionRepositories, SessionRepository } from './session-repository'
import { sessionCloudIdentity } from './session-cloud-identity'

const log = createLogger('SessionPush', 'session-push.ts')
const rowSchema = z.object({ session_id: z.string(), repository: z.string(), head: z.string().nullable(), turn_count: z.number(),
  cloud_scope: z.string().nullable(), pushed_head: z.string().nullable(), reported_head: z.string().nullable(),
  push_due_at: z.number().nullable(), push_attempts: z.number(), push_refused_head: z.string().nullable(), pushed_bytes: z.number(),
  push_stopped: z.number() })
const ROW_COLUMNS = `session_id, repository, head, turn_count, cloud_scope, pushed_head, reported_head,
  push_due_at, push_attempts, push_refused_head, pushed_bytes, push_stopped`
const stoppedRowSchema = z.object({ push_stopped: z.number() })
type Row = z.infer<typeof rowSchema>
/** Where the repository of one session goes in the cloud: who pushes it, and from which host. */
interface PushTarget {
  hostId: string
  identity: SessionCloudIdentity
  provider: SessionRepositoryCard['provider']
}
const MAX_BACKOFF_MS = 30 * 60_000
/** The most bytes this host pushes to one cloud repository. Artifacts can enforce 1 GB for a repository. */
const MAX_PUSHED_BYTES = 900 * 1024 * 1024
const CODE_UPLOAD_TIMEOUT_MS = 30 * 60_000
/** The texts of an Artifacts refusal that a retry cannot change (docs/plans/session-storage.md §5). */
const PERMANENT_REFUSALS = [
  'artifacts_git_receive_pack_object_too_large',
  'artifacts_git_receive_pack_request_too_large',
  'zlib member compressed data exceeds maximum',
]

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
  /** Sends each code bundle upload. */
  fetch?: typeof fetch
}

/**
 * A host-wide push queue. Commit jobs never await it. A push sends one commit
 * at a time, and uploads the code bundles that a commit adds before the commit
 * (docs/plans/session-storage.md §5).
 */
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
    return readSessionStorage(sessionId, this.database())?.pushRefusedHead ?? null
  }

  /** A turn commit landed. Add only a push job; do not hold the commit queue. */
  committed(sessionId: string): void { this.enqueue(sessionId) }

  /** A running report does not delay turn admission. */
  running(sessionId: string): void {
    void (async () => {
      const target = await this.target(sessionId)
      if (target) await this.deps.access.report({ hostId: target.hostId, sessionId, event: 'running' }, target.identity)
    })().catch(() => { log.warn('session_running_report_failed', { sessionId }) })
  }

  /** Scan persisted work on boot or when a delegation becomes available. */
  resume(): void {
    const rows = rowSchema.array().parse(this.database().prepare(`SELECT ${ROW_COLUMNS} FROM session_storage WHERE head IS NOT NULL AND push_refused_head IS NULL
      AND push_stopped = 0 ORDER BY rowid DESC`).all())
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
    if (this.stopped || this.paused || this.scheduled.has(sessionId) || this.pushStopped(sessionId)) return
    this.scheduled.add(sessionId)
    this.queue = this.queue.then(async () => {
      this.scheduled.delete(sessionId)
      try { await this.process(sessionId) } catch (error) { this.fail(sessionId, error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private row(sessionId: string): Row | null {
    return rowSchema.nullable().parse(this.database().prepare(`SELECT ${ROW_COLUMNS} FROM session_storage WHERE session_id = ?`).get(sessionId) ?? null)
  }

  private async process(sessionId: string): Promise<void> {
    const row = this.row(sessionId)
    if (!row?.head || row.push_refused_head || row.push_stopped) return
    if ((row.push_due_at ?? 0) > this.now()) { this.wake((row.push_due_at ?? 0) - this.now()); return }
    // A session that began on an older format stays on its host and moves only by the host path.
    if (await this.deps.repositories.named(row.repository).firstManifestVersion().catch(() => null) !== 2) return
    const target = await this.target(sessionId)
    if (!target) return
    this.database().prepare('UPDATE session_storage SET cloud_scope = ? WHERE session_id = ?').run(target.identity.cloudScope, sessionId)
    if (row.head !== row.pushed_head && !await this.pushCommits(row, target)) return
    if (!await this.reportHead(row, target)) return
    if (this.row(sessionId)?.head !== row.head) this.enqueue(sessionId)
  }

  /** Null when the session must not go to the cloud from this host now. */
  private async target(sessionId: string): Promise<PushTarget | null> {
    const record = await (this.deps.record ?? getSessionRecord)(ANY_ORGANIZATION, sessionId)
    if (!record) return null
    const accountId = (this.deps.accountOf ?? cloudAccountOf)(record.ownerKey)
    const decision = (this.deps.decision ?? sessionCloudSyncDecision)(record.organizationId, accountId ? { accountId } : null)
    if (!decision.allowed || !accountId) return null
    const hostId = this.deps.hostId()
    if (!hostId) return null
    return { hostId, identity: sessionCloudIdentity(record, accountId), provider: record.provider }
  }

  private async reportHead(row: Row, target: PushTarget): Promise<boolean> {
    const head = row.head
    const sessionId = row.session_id
    if (head && head !== row.reported_head) {
      const repository = this.deps.repositories.named(row.repository)
      // A head inside a turn of several commits is not a turn.
      if (!(await repository.manifestChange(head)).writesManifest) return true
      const manifest = await repository.readManifest(head)
      const lastTurn = manifest.turns.at(-1)
      const card: SessionRepositoryCard = { title: manifest.session.title ?? null, provider: target.provider,
        model: manifest.session.model ?? null, repositoryKey: manifest.project?.repositoryKey ?? null,
        branch: lastTurn?.head?.branch ?? null, lastActivityAt: lastTurn?.endedAt ?? this.now() }
      const result = await this.deps.access.report({ hostId: target.hostId, sessionId, event: 'pushed', head, syncedTurn: row.turn_count, card }, target.identity)
      if (result !== 'accepted') { this.defer(sessionId, 60 * 60_000, 'The session head was not reported.'); return false }
      this.database().prepare('UPDATE session_storage SET reported_head = ?, push_attempts = 0, push_due_at = NULL, push_error_reason = NULL WHERE session_id = ?')
        .run(head, sessionId)
    }
    return true
  }

  /** Push each commit after `pushed_head` through `head`, one at a time. True when the remote has `head`. */
  private async pushCommits(row: Row, target: PushTarget): Promise<boolean> {
    const head = row.head
    const sessionId = row.session_id
    if (!head) return true
    const repository = this.deps.repositories.named(row.repository)
    const answer = await this.deps.access.remote(sessionId, target.identity, 'write')
    if (answer.status === 'unavailable') { this.defer(sessionId, 60 * 60_000, 'Cloud session storage is not available.'); return false }
    let pushed = row.pushed_head
    let pushedBytes = row.pushed_bytes
    let commits = await repository.commitsAfter(pushed, head)
    while (pushed !== head) {
      const commit = commits.shift()
      if (!commit) return true
      const bytes = await repository.newObjectBytes(pushed, commit)
      if (pushedBytes + bytes > MAX_PUSHED_BYTES) { this.stopPush(sessionId, commit, 'This session is too large for the cloud copy.'); return false }
      for (const bundle of (await repository.manifestChange(commit)).addedBundles) {
        if (!await this.upload(repository, sessionId, bundle, target)) return false
      }
      const result = await repository.push(answer.remote.remote, commit, pushed, answer.remote.token || undefined, this.active.signal)
      if (result.status === 'refused') {
        this.database().prepare('UPDATE session_storage SET push_refused_head = ?, push_due_at = NULL, push_error_reason = ? WHERE session_id = ?')
          .run(result.head, 'The remote session has another history.', sessionId)
        log.warn('session_push_refused', { sessionId, remoteHead: result.head })
        return false
      }
      if (result.status === 'failed') {
        const refusal = PERMANENT_REFUSALS.find((text) => result.remoteMessage?.includes(text))
        if (refusal) { this.stopPush(sessionId, commit, `Solus Cloud refused this session (${refusal}).`); return false }
        throw new Error(`Git ${result.reason}`)
      }
      // The remote can be past this commit: an earlier push whose answer was lost.
      pushedBytes += result.head === commit ? bytes : await repository.newObjectBytes(pushed, result.head)
      if (result.head !== commit) commits = await repository.commitsAfter(result.head, head)
      pushed = result.head
      this.database().prepare('UPDATE session_storage SET pushed_head = ?, pushed_bytes = ?, push_attempts = 0, push_due_at = NULL, push_error_reason = NULL WHERE session_id = ?')
        .run(pushed, pushedBytes, sessionId)
    }
    return true
  }

  /** Upload one code bundle from its code ref. An upload of a bundle that is there already is safe. */
  private async upload(repository: SessionRepository, sessionId: string, bundle: { sha256: string; bytes: number }, target: PushTarget): Promise<boolean> {
    const answer = await this.deps.access.codeUrl({ sessionId, sha256: bundle.sha256, bytes: bundle.bytes, access: 'write' }, target.identity)
    if (answer.status === 'unavailable') { this.defer(sessionId, 60 * 60_000, 'Cloud code storage is not available.'); return false }
    const folder = await mkdtemp(join(tmpdir(), 'solus-code-upload-'))
    try {
      const file = join(folder, 'bundle')
      await repository.writeCodeBundle(bundle.sha256, file)
      // A signed R2 `PUT` needs a Content-Length; `fetch` sends a stream without one. A bundle is at most `CODE_BUNDLE_MAX_BYTES`.
      const body = await readFile(file)
      if (body.length !== bundle.bytes) throw new Error('The code bundle has another size than its manifest.')
      const response = await (this.deps.fetch ?? fetch)(answer.url, {
        method: 'PUT', body, signal: AbortSignal.any([this.active.signal, AbortSignal.timeout(CODE_UPLOAD_TIMEOUT_MS)]),
        // The store refuses a `PUT` without the length and the SHA-256 that the URL was signed for.
        headers: { 'content-length': String(bundle.bytes), [SESSION_CODE_CHECKSUM_HEADER]: Buffer.from(bundle.sha256, 'hex').toString('base64') },
      })
      if (!response.ok) throw new Error(`Code bundle upload failed (${response.status}).`)
      return true
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }

  /**
   * A refusal that a retry cannot change: stop all later pushes of this session
   * on this host. It is not a divergence: the cloud history is still a part of
   * the local one, so `push_refused_head` stays null and the session continues here.
   */
  private stopPush(sessionId: string, commit: string, reason: string): void {
    this.database().prepare('UPDATE session_storage SET push_stopped = 1, push_due_at = NULL, push_error_reason = ? WHERE session_id = ?').run(reason, sessionId)
    log.warn('session_push_stopped', { sessionId, commit, reason })
  }

  private pushStopped(sessionId: string): boolean {
    return !!stoppedRowSchema.nullish().parse(this.database().prepare('SELECT push_stopped FROM session_storage WHERE session_id = ?').get(sessionId))?.push_stopped
  }

  private fail(sessionId: string, error: Error): void {
    const reason = error instanceof DelegationError ? error.code : 'transport'
    if (reason === 'GRANT_REVOKED' || this.paused) return
    const attempts = (this.row(sessionId)?.push_attempts ?? 0) + 1
    const wait = reason === 'ORGANIZATION_AUTHORITY_MISSING' ? 5 * 60_000
      : Math.min(MAX_BACKOFF_MS, (this.deps.retryMs ?? 30_000) * 2 ** Math.min(attempts - 1, 10))
    this.database().prepare('UPDATE session_storage SET push_attempts = ?, push_due_at = ?, push_error_reason = ? WHERE session_id = ?')
      .run(attempts, this.now() + wait, reason, sessionId)
    log.warn('session_push_failed', { sessionId, reason, attempts })
    this.wake(wait)
  }

  private defer(sessionId: string, wait: number, reason: string): void {
    this.database().prepare('UPDATE session_storage SET push_due_at = ?, push_error_reason = ? WHERE session_id = ?').run(this.now() + wait, reason, sessionId)
    this.wake(wait)
  }

  private wake(wait: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.resume() }, Math.max(1, wait))
    this.timer.unref()
  }
}
