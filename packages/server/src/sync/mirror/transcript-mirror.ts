import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AgentId, SessionRecord } from '@solus/contracts/types'
import type { SessionLoadMessage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { getDb, withTx } from '../../db'
import { getDatabase } from '../../db/database'
import { createLogger } from '../../logger'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { projectSessionHistory } from '../../data/sessions/result-projection'
import { getSessionRecord, isOrganizationWork } from '../../data/sessions/session-records'
import type { SharesMirrorPayload, ActivityMirrorPayload, TranscriptMirrorPayload } from '../runner-protocol'
import type { Activity } from '@solus/contracts/activity'
import type { Attribution, User } from '@solus/contracts/user'
import { cloudAccountOf, cloudUserIdOf } from '../../host/host-user'
import { sessionCloudSyncDecision } from '../../host/policy/host-policy-store'
import { activityFor } from '../../data/activity/activity'
import { session } from '../../data/sessions/schema'
import { appendDelivery, deliveryActorOf, type DeliveryDestination } from '../delivery-queue'
import { personMirrorScope, personOfMirrorScope } from '../../data/sessions/mirror-scope'

const log = createLogger('main', 'transcript-mirror')

/**
 * The transcript producer of the mirror (organization-scope §4, §6, §7). A
 * session's history changes many times in one turn; the mirror reads it once
 * the events have settled for a moment, compares every row with the hash it
 * mirrored last (`transcript_mirror_rows`), and appends only the positions
 * that are new or changed — plus one `truncateFrom` item when the transcript
 * got shorter, so the service drops the rows past its end. The hashes and the
 * log entries are written in one transaction: a crash cannot leave a row
 * marked mirrored that never reached the log. The session's activity rows
 * (plans/012 §5) travel the same way, each once (`activity_mirror_rows`).
 *
 * Whether a session is mirrored at all is the session record's fact. A
 * `published` record of a real organization ships its transcript to that
 * organization. Each other session is personal: it ships to its owner's own
 * scope (`data/sessions/mirror-scope.ts`), and only while the cloud sync decision allows the
 * session a cloud copy (`sessionCloudSyncDecision`), so one switch controls the
 * session repository and the mirror of a personal session. A record's
 * organization never changes, so every row of one session goes to one
 * destination.
 *
 * What is mirrored is the row a client can see (decision 2026-09-19): the
 * same projection the history RPCs apply before a row leaves a host, so a tool
 * result's body never reaches the cloud — only its size, its error head, a
 * sub-agent's report, and the facts the cards read from it.
 */

export const TRANSCRIPT_MIRROR_DEBOUNCE_MS = 2_000

/** How the control plane reads one session's history: the provider and the project folder its files live under. */
export interface TranscriptSource {
  provider: AgentId
  projectPath?: string
}

export interface TranscriptMirrorDeps {
  /** The session's share rows but the owner's (`ShareManager.mirroredRows`), sent with its first rows; absent on a host that mirrors no rows. */
  shareRows?: (sessionId: string) => Promise<SharesMirrorPayload['rows']>
  /** The lineage-aware reader: every row of the session's history, every thread, in order. */
  loadSession: (provider: AgentId, sessionId: string, projectPath?: string) => Promise<SessionLoadMessage[]>
  debounceMs?: number
}

interface PendingSync extends TranscriptSource {
  timer: ReturnType<typeof setTimeout>
}

const hashRowSchema = z.object({ position: z.number(), hash: z.string() })
const sentActivityRowSchema = z.object({ activity_id: z.string() })

function hashOf(message: WireSessionLoadMessage): string {
  return createHash('sha1').update(JSON.stringify(message)).digest('hex')
}

/** The organization a published session is mirrored to, delivered by its owner. */
function publishedDestinationOf(record: SessionRecord | null): DeliveryDestination | null {
  return isOrganizationWork(record) ? { organizationId: record.organizationId, actorUserId: deliveryActorOf(record.ownerKey) } : null
}

/**
 * The organization a session is published to, or null. For what only a
 * published session sends: its share rows, and the account origin in its links.
 */
export async function publishedDestination(sessionId: string): Promise<DeliveryDestination | null> {
  return publishedDestinationOf(await getSessionRecord(ANY_ORGANIZATION, sessionId))
}

/** The account of a session's owner when the cloud sync decision allows the session a cloud copy; else null. */
function cloudCopyAccountOf(record: SessionRecord): string | null {
  const accountId = cloudAccountOf(record.ownerKey)
  return accountId && sessionCloudSyncDecision(record.organizationId, { accountId }).allowed ? accountId : null
}

/**
 * Where a session's rows are mirrored to, or null when they stay on this
 * machine. The session's owner delivers them, with their delegated token
 * (plans/010-standard-oauth.md).
 */
export async function mirrorDestination(sessionId: string): Promise<DeliveryDestination | null> {
  const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
  if (!record) return null
  const published = publishedDestinationOf(record)
  if (published) return published
  const accountId = cloudCopyAccountOf(record)
  return accountId ? { organizationId: personMirrorScope(accountId), actorUserId: accountId } : null
}

/**
 * Where the diffs of a session's turns are mirrored to, or null. A patch holds
 * code that is not committed, so the cloud sync decision gates it for each
 * session, a published one too: publication alone sends the rows of a
 * session, not its code. The diff then goes where the rows go.
 */
export async function turnDiffDestination(sessionId: string): Promise<DeliveryDestination | null> {
  const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
  if (!record) return null
  const accountId = cloudCopyAccountOf(record)
  if (!accountId) return null
  return publishedDestinationOf(record) ?? { organizationId: personMirrorScope(accountId), actorUserId: accountId }
}

export class TranscriptMirror {
  private readonly pending = new Map<string, PendingSync>()
  /** One sync per session at a time; a later flush waits for the earlier one and reads again. */
  private readonly running = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly deps: TranscriptMirrorDeps) {}

  /** The session's history may have changed; read it once things settle for a moment. */
  touch(sessionId: string, source: TranscriptSource): void {
    if (this.disposed) return
    const existing = this.pending.get(sessionId)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => { void this.flushNow(sessionId) }, this.deps.debounceMs ?? TRANSCRIPT_MIRROR_DEBOUNCE_MS)
    timer.unref?.()
    this.pending.set(sessionId, { provider: source.provider, projectPath: source.projectPath, timer })
  }

  /**
   * Read and mirror the session now, without waiting for the debounce. Resolves
   * when the sync is done, with the highest sequence appended (0 when nothing was).
   */
  async flushNow(sessionId: string): Promise<number> {
    const entry = this.pending.get(sessionId)
    if (!entry) {
      await this.running.get(sessionId)
      return 0
    }
    clearTimeout(entry.timer)
    this.pending.delete(sessionId)
    const previous = this.running.get(sessionId) ?? Promise.resolve()
    let lastSeq = 0
    const run = previous.then(() => this.sync(sessionId, entry)).then((seq) => { lastSeq = seq }).catch((error) => {
      log.warn('transcript_mirror_sync_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
    })
    this.running.set(sessionId, run)
    await run
    if (this.running.get(sessionId) === run) this.running.delete(sessionId)
    return lastSeq
  }

  /** Forget every pending read; nothing more is mirrored. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }

  private async sync(sessionId: string, source: TranscriptSource): Promise<number> {
    if (this.disposed) return 0
    const destination = await mirrorDestination(sessionId)
    if (!destination) return 0
    const messages = projectSessionHistory(await this.deps.loadSession(source.provider, sessionId, source.projectPath))
    // Whatever organization a row was recorded in: a session published from Local brings the activity it had.
    const activity = await activityFor(ANY_ORGANIZATION, { kind: 'session', id: sessionId })
    const hashes = messages.map(hashOf)
    let lastSeq = 0
    // A session's share rows go when they change (`onShareChanged`), and with its first
    // rows, so the Solus API holds them from the start (host-sharing.md §2). The cloud
    // keeps no share row of a personal session: only its owner reads it there.
    const firstSync = !getDb().prepare('SELECT 1 FROM transcript_mirror_rows WHERE session_id = ? LIMIT 1').get(sessionId)
    const isPersonal = personOfMirrorScope(destination.organizationId) !== null
    const shareRows = firstSync && !isPersonal && this.deps.shareRows ? await this.deps.shareRows(sessionId) : null
    withTx(() => {
      const known = hashRowSchema.array().parse(getDb().prepare('SELECT position, hash FROM transcript_mirror_rows WHERE session_id = ?').all(sessionId))
      const knownHashByPosition = new Map(known.map((row) => [row.position, row.hash]))
      const changedPositions: number[] = []
      for (let position = 0; position < messages.length; position++) {
        if (knownHashByPosition.get(position) !== hashes[position]) changedPositions.push(position)
      }
      const knownEnd = known.reduce((end, row) => Math.max(end, row.position + 1), 0)
      const truncated = knownEnd > messages.length
      if (changedPositions.length > 0 || truncated) {
        const items: Array<{ key: string; payload: TranscriptMirrorPayload }> = changedPositions.map((position) => ({
          key: `${sessionId}:${position}`,
          payload: { sessionId, position, message: messages[position] },
        }))
        if (truncated) items.push({ key: `${sessionId}:truncate`, payload: { sessionId, truncateFrom: messages.length } })
        lastSeq = appendDelivery(destination, 'transcript', items).lastSeq
        const remember = getDb().prepare('INSERT INTO transcript_mirror_rows(session_id, position, hash) VALUES (?, ?, ?) ON CONFLICT(session_id, position) DO UPDATE SET hash = excluded.hash')
        for (const position of changedPositions) remember.run(sessionId, position, hashes[position])
        if (truncated) getDb().prepare('DELETE FROM transcript_mirror_rows WHERE session_id = ? AND position >= ?').run(sessionId, messages.length)
        log.info('transcript_mirrored', { sessionId, organizationId: destination.organizationId, provider: source.provider, changed: changedPositions.length, total: messages.length, truncated })
      }
      lastSeq = Math.max(lastSeq, this.appendNewActivity(sessionId, destination, activity))
      if (shareRows) {
        const payload: SharesMirrorPayload = { resource: { kind: 'session', id: sessionId }, rows: shareRows }
        lastSeq = Math.max(lastSeq, appendDelivery(destination, 'shares', [{ key: `session:${sessionId}`, payload }]).lastSeq)
      }
    })
    return lastSeq
  }

  /**
   * The session's activity rows not yet sent (plans/012 §5): an activity row
   * never changes, so its id is enough to send it once.
   */
  private appendNewActivity(sessionId: string, destination: DeliveryDestination, activity: Activity[]): number {
    const sent = new Set(sentActivityRowSchema.array().parse(getDb().prepare('SELECT activity_id FROM activity_mirror_rows WHERE session_id = ?').all(sessionId)).map((row) => row.activity_id))
    const unsent = activity.filter((entry) => !sent.has(entry.id))
    if (unsent.length === 0) return 0
    const items: Array<{ key: string; payload: ActivityMirrorPayload }> = unsent.map((entry) => ({
      key: entry.id,
      payload: { activity: { ...cloudActivity(entry), subject: { kind: 'session', id: sessionId } } },
    }))
    const { lastSeq } = appendDelivery(destination, 'activity', items)
    const remember = getDb().prepare('INSERT INTO activity_mirror_rows(session_id, activity_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
    for (const entry of unsent) remember.run(sessionId, entry.id)
    log.info('session_activity_mirrored', { sessionId, organizationId: destination.organizationId, count: unsent.length })
    return lastSeq
  }
}

const interruptedRowSchema = z.object({
  session_id: z.string(),
  provider: z.enum(['claude-code', 'codex', 'opencode', 'replay']),
  project_path: z.string(),
})

/** One of this host's own sessions, and how its history is read. */
export interface OwnSessionSource extends TranscriptSource {
  sessionId: string
}

/**
 * The host's own published sessions whose last turn was never settled — the
 * ones boot just marked `interrupted`. Each is touched once so the transcript
 * of a killed turn reaches the cloud after a restart.
 */
export async function listOwnInterruptedSessions(): Promise<OwnSessionSource[]> {
  const rows = interruptedRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, provider, project_path FROM ${session}
    WHERE publication = 'published' AND status = 'interrupted' AND runner_host_id IS NULL AND started_at IS NOT NULL
  `))
  return rows.map((row) => ({ sessionId: row.session_id, provider: row.provider, projectPath: row.project_path }))
}

const cloudCopyRowSchema = z.object({ session_id: z.string() })

/**
 * The host's own sessions that have a cloud copy and no mirrored row: personal
 * sessions that ran before the mirror held them. Each is mirrored once after
 * boot, so a reader with no host online keeps the sessions that the session
 * repository showed before.
 */
export async function listUnmirroredCloudSessions(): Promise<OwnSessionSource[]> {
  const rows = cloudCopyRowSchema.array().parse(getDb().prepare(`
    SELECT session_id FROM session_storage WHERE pushed_head IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM transcript_mirror_rows mirrored WHERE mirrored.session_id = session_storage.session_id)
  `).all())
  const sessions: OwnSessionSource[] = []
  for (const row of rows) {
    const record = await getSessionRecord(ANY_ORGANIZATION, row.session_id)
    if (record && record.runnerHostId === null) sessions.push({ sessionId: record.sessionId, provider: record.provider, projectPath: record.projectPath })
  }
  return sessions
}

/** A user as the cloud knows them: the host's owner is their linked account (plans/031 D4). */
function cloudUser(user: User): User {
  return { ...user, id: cloudUserIdOf(user.id) }
}

function cloudAttribution(by: Attribution): Attribution {
  if (by.kind === 'user') return { ...by, user: cloudUser(by.user) }
  if ((by.kind === 'agent' || by.kind === 'automation') && by.for) return { ...by, for: cloudUser(by.for) }
  return by
}

/** An activity row as it goes to the cloud: every person it names as the cloud knows them. */
function cloudActivity(entry: Activity): Activity {
  const mapped: Activity = { ...entry, by: cloudAttribution(entry.by) }
  if ((mapped.kind === 'shared' || mapped.kind === 'mentioned') && mapped.userId) mapped.userId = cloudUserIdOf(mapped.userId)
  return mapped
}
