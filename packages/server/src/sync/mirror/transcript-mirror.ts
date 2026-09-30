import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import type { SessionLoadMessage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { getDb, withTx } from '../../db'
import { getDatabase } from '../../db/database'
import { createLogger } from '../../logger'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { projectSessionHistory } from '../../data/sessions/result-projection'
import { getSessionRecord } from '../../data/sessions/session-records'
import type { ActivityMirrorPayload, TranscriptMirrorPayload } from '../runner-protocol'
import type { Activity } from '@solus/contracts/activity'
import { activityFor } from '../../data/activity/activity'
import { sessionRecords } from '../../data/sessions/schema'
import { activePublication } from '../publication-store'
import { appendMirror } from './mirror-log'
import type { DeliveryDestination } from '../outbox/outbox-store'

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
 * Whether a session is mirrored at all is the session record's fact: only a
 * `published` record of a real organization ships its transcript, to that
 * organization. An organization-attributed session that only sends Insights
 * keeps its transcript on this machine (§3). A record's organization never
 * changes, so every row of one session goes to one destination.
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
  /** The lineage-aware reader: every row of the session's history, in order. */
  loadSession: (provider: AgentId, sessionId: string, projectPath?: string) => Promise<SessionLoadMessage[]>
  /** The id the session's activity is recorded under (the Solus session id) for the thread id it is mirrored by; the same id when omitted. */
  activitySubjectId?: (sessionId: string) => string
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

/**
 * The organization a session's transcript is mirrored to, or null when it stays
 * on this machine: a published record's own, or — while a publication into that
 * organization is on its way (§7) — the reserved one, so the transcript the
 * publication reads is appended before the record says `published`.
 */
export async function transcriptDestination(sessionId: string): Promise<DeliveryDestination | null> {
  const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
  if (!record || record.organizationId === LOCAL_ORGANIZATION_ID) return null
  // The session's owner delivers its transcript, with their delegated token (plans/010-standard-oauth.md).
  const destination = { organizationId: record.organizationId, actorUserId: record.ownerUserId ?? '' }
  if (record.publication === 'published') return destination
  const reserved = activePublication({ kind: 'session', id: sessionId })
  return reserved?.organizationId === record.organizationId ? destination : null
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
    const destination = await transcriptDestination(sessionId)
    if (!destination) return 0
    const messages = projectSessionHistory(await this.deps.loadSession(source.provider, sessionId, source.projectPath))
    // Whatever organization a row was recorded in: a session published from Local brings the activity it had.
    const activity = await activityFor(ANY_ORGANIZATION, { kind: 'session', id: this.deps.activitySubjectId?.(sessionId) ?? sessionId })
    const hashes = messages.map(hashOf)
    let lastSeq = 0
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
        lastSeq = appendMirror(destination, 'transcripts', items).lastSeq
        const remember = getDb().prepare('INSERT INTO transcript_mirror_rows(session_id, position, hash) VALUES (?, ?, ?) ON CONFLICT(session_id, position) DO UPDATE SET hash = excluded.hash')
        for (const position of changedPositions) remember.run(sessionId, position, hashes[position])
        if (truncated) getDb().prepare('DELETE FROM transcript_mirror_rows WHERE session_id = ? AND position >= ?').run(sessionId, messages.length)
        log.info('transcript_mirrored', { sessionId, organizationId: destination.organizationId, provider: source.provider, changed: changedPositions.length, total: messages.length, truncated })
      }
      lastSeq = Math.max(lastSeq, this.appendNewActivity(sessionId, destination, activity))
    })
    return lastSeq
  }

  /**
   * The session's activity rows not yet sent under this transcript id (plans/012
   * §5): an activity row never changes, so its id is enough to send it once. Each
   * names the session by the id its transcript is mirrored under, which is the id
   * the Solus API reads the history by.
   */
  private appendNewActivity(sessionId: string, destination: DeliveryDestination, activity: Activity[]): number {
    const sent = new Set(sentActivityRowSchema.array().parse(getDb().prepare('SELECT activity_id FROM activity_mirror_rows WHERE session_id = ?').all(sessionId)).map((row) => row.activity_id))
    const unsent = activity.filter((entry) => !sent.has(entry.id))
    if (unsent.length === 0) return 0
    const items: Array<{ key: string; payload: ActivityMirrorPayload }> = unsent.map((entry) => ({
      key: entry.id,
      payload: { activity: { ...entry, subject: { kind: 'session', id: sessionId } } },
    }))
    const { lastSeq } = appendMirror(destination, 'activity', items)
    const remember = getDb().prepare('INSERT INTO activity_mirror_rows(session_id, activity_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
    for (const entry of unsent) remember.run(sessionId, entry.id)
    log.info('session_activity_mirrored', { sessionId, organizationId: destination.organizationId, count: unsent.length })
    return lastSeq
  }
}

const interruptedRowSchema = z.object({
  session_id: z.string(),
  provider: z.enum(['claude-code', 'codex', 'opencode']),
  project_path: z.string(),
})

export interface InterruptedSession extends TranscriptSource {
  sessionId: string
}

/**
 * The host's own published sessions whose last turn was never settled — the
 * ones boot just marked `interrupted`. Each is touched once so the transcript
 * of a killed turn reaches the cloud after a restart.
 */
export async function listOwnInterruptedSessions(): Promise<InterruptedSession[]> {
  const rows = interruptedRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, provider, project_path FROM ${sessionRecords}
    WHERE publication = 'published' AND status = 'interrupted' AND runner_host_id IS NULL
  `))
  return rows.map((row) => ({ sessionId: row.session_id, provider: row.provider, projectPath: row.project_path }))
}
