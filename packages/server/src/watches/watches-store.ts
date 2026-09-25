import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { getDb } from '../db'
import { createLogger } from '../logger'
import { isWatchEnded, type Watch, type WatchChangedEvent, type WatchStatus } from '@solus/contracts/watch-types'

const log = createLogger('watches', 'watches-store.ts')

const statusSchema = z.enum(['waiting', 'paused', 'woken', 'done', 'exhausted', 'expired', 'cancelled', 'failed'])
const probeResultSchema = z.object({
  exitCode: z.number().nullable(),
  outputTail: z.string(),
  at: z.string(),
  error: z.string().optional(),
})
const watchSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  reason: z.string(),
  probe: z.object({ command: z.string(), timeoutSeconds: z.number() }).optional(),
  schedule: z.union([z.object({ everySeconds: z.number() }), z.object({ at: z.string() })]),
  until: z.union([
    z.object({ exitCodes: z.array(z.number()) }),
    z.object({ outputMatches: z.string() }),
    z.object({ outputChanges: z.literal(true) }),
  ]).optional(),
  onMatch: z.enum(['wake', 'notify']),
  repeat: z.boolean(),
  maxWakes: z.number(),
  expiresAt: z.string(),
  wakeCount: z.number(),
  consecutiveProbeErrors: z.number(),
  lastFingerprint: z.string().optional(),
  wokenFingerprint: z.string().optional(),
  lastResult: probeResultSchema.optional(),
  nextRunAt: z.string().optional(),
  status: statusSchema,
  endReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
const rowSchema = z.object({ data: z.string() })

type WatchesChangedListener = (event: WatchChangedEvent) => void
const changedListeners = new Set<WatchesChangedListener>()

/** Every save is announced so the server can push it to clients: a watch
 *  changes state with no client in the loop. */
export function onWatchesChanged(listener: WatchesChangedListener): () => void {
  changedListeners.add(listener)
  return () => changedListeners.delete(listener)
}

function emitChanged(watch: Watch): void {
  for (const listener of changedListeners) {
    try {
      listener({ watch })
    } catch (error) {
      log.error('watches_changed_listener_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function watchFromData(data: string): Watch {
  return watchSchema.parse(JSON.parse(data))
}

function write(db: DatabaseSync, watch: Watch): void {
  db.prepare(`
    INSERT INTO watches(id, session_id, status, next_run_at, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      next_run_at = excluded.next_run_at,
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(
    watch.id,
    watch.sessionId,
    watch.status,
    watch.nextRunAt === undefined ? null : Date.parse(watch.nextRunAt),
    JSON.stringify(watch),
    Date.parse(watch.createdAt),
    Date.parse(watch.updatedAt),
  )
}

/** Store the watch and tell every listener. Stamps `updatedAt`. */
export function saveWatch(watch: Watch): Watch {
  watch.updatedAt = new Date().toISOString()
  write(getDb(), watch)
  emitChanged(watch)
  return watch
}

export function loadWatch(id: string): Watch | null {
  const row = rowSchema.nullish().parse(getDb().prepare('SELECT data FROM watches WHERE id = ?').get(id))
  return row ? watchFromData(row.data) : null
}

/** Newest first, ended watches included. */
export function listWatchesForSession(sessionId: string): Watch[] {
  return getDb()
    .prepare('SELECT data FROM watches WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId)
    .map((row) => watchFromData(rowSchema.parse(row).data))
}

export function listWatchesWithStatus(statuses: readonly WatchStatus[]): Watch[] {
  if (statuses.length === 0) return []
  return getDb()
    .prepare(`SELECT data FROM watches WHERE status IN (${statuses.map(() => '?').join(', ')})`)
    .all(...statuses)
    .map((row) => watchFromData(rowSchema.parse(row).data))
}

/** Waiting watches whose next run is at or before `now`. */
export function dueWatches(now: Date): Watch[] {
  return getDb()
    .prepare("SELECT data FROM watches WHERE status = 'waiting' AND next_run_at IS NOT NULL AND next_run_at <= ?")
    .all(now.getTime())
    .map((row) => watchFromData(rowSchema.parse(row).data))
}

/** Delete ended watches last changed before `cutoff`. A transcript card that
 *  still names one shows it as no longer available. */
export function deleteEndedWatchesBefore(cutoff: Date): number {
  return Number(getDb().prepare(`
    DELETE FROM watches
    WHERE status IN ('done', 'exhausted', 'expired', 'cancelled', 'failed') AND updated_at < ?
  `).run(cutoff.getTime()).changes)
}

/** Stop probing and waking until resumed. A woken turn already running is not
 *  interrupted. Returns null for an unknown or ended watch. */
export function pauseWatch(id: string): Watch | null {
  const watch = loadWatch(id)
  if (!watch || (watch.status !== 'waiting' && watch.status !== 'woken')) return null
  watch.status = 'paused'
  delete watch.nextRunAt
  return saveWatch(watch)
}

/** Wait again: a probe runs now, a timer keeps its instant. Only a paused
 *  watch resumes. */
export function resumeWatch(id: string, now = new Date()): Watch | null {
  const watch = loadWatch(id)
  if (!watch || watch.status !== 'paused') return null
  watch.status = 'waiting'
  watch.nextRunAt = 'at' in watch.schedule && Date.parse(watch.schedule.at) > now.getTime()
    ? watch.schedule.at
    : now.toISOString()
  return saveWatch(watch)
}

/** End the watch. A woken turn already running is not interrupted. */
export function cancelWatch(id: string, by: 'user' | 'agent'): Watch | null {
  const watch = loadWatch(id)
  if (!watch || isWatchEnded(watch.status)) return null
  watch.status = 'cancelled'
  watch.endReason = by === 'user' ? 'Cancelled by the user.' : 'Cancelled by the agent.'
  delete watch.nextRunAt
  return saveWatch(watch)
}
