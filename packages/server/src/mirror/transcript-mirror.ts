import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { getDb, withTx } from '../db'
import { getDatabase } from '../db/database'
import { createLogger } from '../logger'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
import type { TranscriptMirrorPayload } from '../server/uplink/runner-protocol'
import { sessionRecords } from '../sessions/schema'
import { appendMirror, mirrorEnabled } from './mirror-log'

const log = createLogger('main', 'transcript-mirror')

/**
 * The transcript producer of the mirror (docs/plans/cloud-service-model.md §6).
 * A session's history changes many times in one turn; the mirror reads it once
 * the events have settled for a moment, compares every row with the hash it
 * mirrored last (`transcript_mirror_rows`), and appends only the positions
 * that are new or changed — plus one `truncateFrom` item when the transcript
 * got shorter, so the service drops the rows past its end. The hashes and the
 * log entries are written in one transaction: a crash cannot leave a row
 * marked mirrored that never reached the log.
 *
 * A host that mirrors nowhere (`mirrorEnabled()` false) does nothing here and
 * keeps nothing: its hash table stays as it was.
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
  debounceMs?: number
}

interface PendingSync extends TranscriptSource {
  timer: ReturnType<typeof setTimeout>
}

const hashRowSchema = z.object({ position: z.number(), hash: z.string() })

function hashOf(message: SessionLoadMessage): string {
  return createHash('sha1').update(JSON.stringify(message)).digest('hex')
}

export class TranscriptMirror {
  private readonly pending = new Map<string, PendingSync>()
  /** One sync per session at a time; a later flush waits for the earlier one and reads again. */
  private readonly running = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly deps: TranscriptMirrorDeps) {}

  /** The session's history may have changed; read it once things settle for a moment. */
  touch(sessionId: string, source: TranscriptSource): void {
    if (this.disposed || !mirrorEnabled()) return
    const existing = this.pending.get(sessionId)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => { void this.flushNow(sessionId) }, this.deps.debounceMs ?? TRANSCRIPT_MIRROR_DEBOUNCE_MS)
    timer.unref?.()
    this.pending.set(sessionId, { provider: source.provider, projectPath: source.projectPath, timer })
  }

  /** Read and mirror the session now, without waiting for the debounce. Resolves when the sync is done. */
  async flushNow(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) {
      await this.running.get(sessionId)
      return
    }
    clearTimeout(entry.timer)
    this.pending.delete(sessionId)
    const previous = this.running.get(sessionId) ?? Promise.resolve()
    const run = previous.then(() => this.sync(sessionId, entry)).catch((error) => {
      log.warn('transcript_mirror_sync_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
    })
    this.running.set(sessionId, run)
    await run
    if (this.running.get(sessionId) === run) this.running.delete(sessionId)
  }

  /** Forget every pending read; nothing more is mirrored. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }

  private async sync(sessionId: string, source: TranscriptSource): Promise<void> {
    if (this.disposed || !mirrorEnabled()) return
    const messages = await this.deps.loadSession(source.provider, sessionId, source.projectPath)
    const hashes = messages.map(hashOf)
    withTx(() => {
      // The grant may have gone while the transcript was read; then nothing is appended and nothing marked.
      if (!mirrorEnabled()) return
      const known = hashRowSchema.array().parse(getDb().prepare('SELECT position, hash FROM transcript_mirror_rows WHERE session_id = ?').all(sessionId))
      const knownHashByPosition = new Map(known.map((row) => [row.position, row.hash]))
      const changedPositions: number[] = []
      for (let position = 0; position < messages.length; position++) {
        if (knownHashByPosition.get(position) !== hashes[position]) changedPositions.push(position)
      }
      const knownEnd = known.reduce((end, row) => Math.max(end, row.position + 1), 0)
      const truncated = knownEnd > messages.length
      if (changedPositions.length === 0 && !truncated) return
      const items: Array<{ key: string; payload: TranscriptMirrorPayload }> = changedPositions.map((position) => ({
        key: `${sessionId}:${position}`,
        payload: { sessionId, position, message: messages[position] },
      }))
      if (truncated) items.push({ key: `${sessionId}:truncate`, payload: { sessionId, truncateFrom: messages.length } })
      appendMirror('transcripts', items)
      const remember = getDb().prepare('INSERT INTO transcript_mirror_rows(session_id, position, hash) VALUES (?, ?, ?) ON CONFLICT(session_id, position) DO UPDATE SET hash = excluded.hash')
      for (const position of changedPositions) remember.run(sessionId, position, hashes[position])
      if (truncated) getDb().prepare('DELETE FROM transcript_mirror_rows WHERE session_id = ? AND position >= ?').run(sessionId, messages.length)
      log.info('transcript_mirrored', { sessionId, provider: source.provider, changed: changedPositions.length, total: messages.length, truncated })
    })
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
 * The host's own sessions whose last turn was never settled — the ones boot
 * just marked `interrupted`. Each is touched once so the transcript of a killed
 * turn reaches the cloud after a restart.
 */
export async function listOwnInterruptedSessions(): Promise<InterruptedSession[]> {
  const rows = interruptedRowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, provider, project_path FROM ${sessionRecords}
    WHERE organization_id = ${LOCAL_ORGANIZATION_ID} AND status = 'interrupted' AND runner_host_id IS NULL
  `))
  return rows.map((row) => ({ sessionId: row.session_id, provider: row.provider, projectPath: row.project_path }))
}
