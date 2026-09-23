import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../db/database'
import { createLogger } from '../logger'
import { applyOutboxOp, PermanentApplyError } from '../outbox/outbox-store'
import { runnerCursors } from '../outbox/schema'
import { upsertSessionRecord } from '../sessions/session-records'
import { applyMirrorItem } from '../mirror/mirror-sinks'
import type { ShareManager } from '../sharing/share-manager'
import type { Principal } from './principal'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import {
  type RunnerMirrorRequest,
  type RunnerMirrorResponse,
  type RunnerOutboxRequest,
  type RunnerOutboxResponse,
  type RunnerSessionRecordsRequest,
  type RunnerSessionRecordsResponse,
} from './uplink/runner-protocol'

const log = createLogger('main', 'runner-intake')

/**
 * The workspace service's side of runner delivery
 * (docs/plans/cloud-service-model.md §16). A runner's ops and reports land in
 * the runner's organization through the same appliers and record store a host
 * uses for its own; the per-stream cursor in `runner_cursors` is what makes a
 * redelivery harmless. An op and its cursor advance in one transaction, so a
 * crash between them cannot apply the op twice.
 */

export type RunnerPrincipal = Extract<Principal, { kind: 'runner' }>

type RunnerStream = 'outbox' | 'session-records' | 'mirror'

const cursorRowSchema = z.object({ last_seq: z.number() })

async function readCursor(db: Db, runner: RunnerPrincipal, stream: RunnerStream): Promise<number> {
  const row = cursorRowSchema.nullish().parse(await db.get(sql`
    SELECT last_seq FROM ${runnerCursors}
    WHERE organization_id = ${runner.organizationId} AND host_id = ${runner.hostId} AND stream = ${stream}
  `))
  return row?.last_seq ?? 0
}

async function writeCursor(db: Db, runner: RunnerPrincipal, stream: RunnerStream, seq: number): Promise<void> {
  await db.run(sql`
    INSERT INTO ${runnerCursors} (organization_id, host_id, stream, last_seq, updated_at)
    VALUES (${runner.organizationId}, ${runner.hostId}, ${stream}, ${seq}, ${Date.now()})
    ON CONFLICT (organization_id, host_id, stream) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
  `)
}

/** The batch's items in ascending order; a runner that sends them out of order gets them applied in order anyway. */
function ascending<T extends { seq: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.seq - b.seq)
}

/** A `create` op made a task or a work: the organization's, as anything made in its space is. */
async function claimCreated(shares: ShareManager | undefined, runner: RunnerPrincipal, op: OutboxOp): Promise<void> {
  if (!shares || op.name !== 'create') return
  await shares.claimForRunner({ kind: op.domain === 'tasks' ? 'task' : 'work', id: op.resourceId }, runner)
}

export async function applyRunnerOutbox(runner: RunnerPrincipal, request: RunnerOutboxRequest, shares?: ShareManager): Promise<RunnerOutboxResponse> {
  const database = getDatabase()
  let lastSeq = await readCursor(database, runner, 'outbox')
  const failed: RunnerOutboxResponse['failed'] = []
  for (const { seq, op } of ascending(request.ops)) {
    if (seq <= lastSeq) continue
    try {
      await database.transaction(async (db) => {
        await applyOutboxOp(op, runner.organizationId)
        await claimCreated(shares, runner, op)
        await writeCursor(db, runner, 'outbox', seq)
      })
      lastSeq = seq
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const permanent = error instanceof PermanentApplyError
      log.warn('runner_outbox_op_failed', { hostId: runner.hostId, organizationId: runner.organizationId, seq, opId: op.id, domain: op.domain, name: op.name, permanent, error: message })
      failed.push({ seq, error: message, permanent })
      // A permanent failure is skipped so the stream moves on; a transient one
      // holds the cursor where it is and the runner sends the rest again.
      if (!permanent) break
      await writeCursor(database, runner, 'outbox', seq)
      lastSeq = seq
    }
  }
  return { lastSeq, failed }
}

export async function applyRunnerSessionRecords(runner: RunnerPrincipal, request: RunnerSessionRecordsRequest, shares?: ShareManager): Promise<RunnerSessionRecordsResponse> {
  const database = getDatabase()
  let lastSeq = await readCursor(database, runner, 'session-records')
  for (const { seq, record } of ascending(request.reports)) {
    if (seq <= lastSeq) continue
    // The record names the runner that holds the transcript; a runner cannot speak for another.
    await database.transaction(async (db) => {
      await upsertSessionRecord(runner.organizationId, { ...record, runnerHostId: runner.hostId })
      // A session the runner reports is the organization's to open, like anything else it writes here.
      if (shares) await shares.claimForRunner({ kind: 'session', id: record.sessionId }, runner)
      await writeCursor(db, runner, 'session-records', seq)
    })
    lastSeq = seq
  }
  return { lastSeq }
}

/**
 * The mirrored domains (§6): transcript rows and insights. A malformed item is
 * skipped and the cursor moves past it; any other failure holds the cursor
 * where it is, and the runner sends the rest again.
 */
export async function applyRunnerMirror(runner: RunnerPrincipal, request: RunnerMirrorRequest): Promise<RunnerMirrorResponse> {
  const database = getDatabase()
  const origin = { organizationId: runner.organizationId, hostId: runner.hostId }
  let lastSeq = await readCursor(database, runner, 'mirror')
  for (const { seq, domain, key, payload } of ascending(request.items)) {
    if (seq <= lastSeq) continue
    try {
      await database.transaction(async (db) => {
        await applyMirrorItem(origin, { domain, payload })
        await writeCursor(db, runner, 'mirror', seq)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const permanent = error instanceof PermanentApplyError
      log.warn('runner_mirror_item_failed', { hostId: runner.hostId, organizationId: runner.organizationId, seq, domain, key, permanent, error: message })
      if (!permanent) break
      await writeCursor(database, runner, 'mirror', seq)
    }
    lastSeq = seq
  }
  return { lastSeq }
}
