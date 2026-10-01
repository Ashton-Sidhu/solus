import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../db/database'
import { createLogger } from '../logger'
import { applyOutboxOp, PermanentApplyError } from './outbox/outbox-store'
import { runnerCursors } from './outbox/schema'
import { getSessionRecord, upsertSessionRecord } from '../data/sessions/session-records'
import { readSessionAdmission } from '../data/sessions/session-admissions'
import { applyMirrorItem } from './mirror/mirror-sinks'
import type { ShareManager } from '../sharing/share-manager'
import type { Principal } from '../admission/principal'
import type { OutboxOp } from '@solus/contracts/outbox-types'
import type { SessionRecordUpsert } from '@solus/contracts/types'
import {
  activityMirrorPayloadSchema,
  transcriptMirrorPayloadSchema,
  type RunnerMirrorRequest,
  type RunnerMirrorResponse,
  type RunnerOutboxRequest,
  type RunnerOutboxResponse,
  type RunnerSessionRecordsRequest,
  type RunnerSessionRecordsResponse,
} from './runner-protocol'

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
    WHERE organization_id = ${runner.organizationId} AND host_id = ${runner.hostId} AND actor_user_id = ${runner.ownerUserId} AND stream = ${stream}
  `))
  return row?.last_seq ?? 0
}

async function writeCursor(db: Db, runner: RunnerPrincipal, stream: RunnerStream, seq: number): Promise<void> {
  await db.run(sql`
    INSERT INTO ${runnerCursors} (organization_id, host_id, actor_user_id, stream, last_seq, updated_at)
    VALUES (${runner.organizationId}, ${runner.hostId}, ${runner.ownerUserId}, ${stream}, ${seq}, ${Date.now()})
    ON CONFLICT (organization_id, host_id, actor_user_id, stream) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
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
      // Keep the failure repeatable if this response is lost. The runner removes
      // a permanent failure from its pending queue only after it receives it;
      // its next batch then advances past that item. Never acknowledge it here.
      break
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
      const { admissionId, privateToOwner, ownerUserId: _reportedOwner, ...facts } = record
      const existing = await getSessionRecord(runner.organizationId, record.sessionId)
      // The owner is established once, from verified authority (organization-vms §4): a
      // session admitted before its provider started belongs to the person whose run
      // authority admitted it; any other new record to the account that linked the
      // runner. A report never names or changes the owner, and a replay restores nothing.
      const admission = !existing && admissionId ? await readSessionAdmission(runner.organizationId, admissionId) : null
      const owner = admission && admission.hostId === runner.hostId ? admission.ownerUserId : runner.ownerUserId
      const report: SessionRecordUpsert = { ...facts, runnerHostId: runner.hostId }
      if (!existing) report.ownerUserId = owner ?? null
      await upsertSessionRecord(runner.organizationId, report)
      // A session the runner reports is the organization's to open, like anything else it
      // writes here; a chat is its owner's alone until they share it (plan 004 D14).
      if (shares) await shares.claimForRunner({ kind: 'session', id: record.sessionId }, owner ? { ...runner, ownerUserId: owner } : runner, { shareWithOrganization: !privateToOwner })
      await writeCursor(db, runner, 'session-records', seq)
    })
    lastSeq = seq
  }
  return { lastSeq }
}

/**
 * The mirrored domains (§6): transcript rows, session activity and insights. A malformed item is
 * skipped and the cursor moves past it; any other failure holds the cursor
 * where it is, and the runner sends the rest again.
 */
export async function applyRunnerMirror(runner: RunnerPrincipal, request: RunnerMirrorRequest, onTranscriptChanged?: (sessionId: string) => void): Promise<RunnerMirrorResponse> {
  const database = getDatabase()
  const origin = { organizationId: runner.organizationId, hostId: runner.hostId }
  const changedSessions = new Set<string>()
  let lastSeq = await readCursor(database, runner, 'mirror')
  for (const { seq, domain, key, payload } of ascending(request.items)) {
    if (seq <= lastSeq) continue
    try {
      await database.transaction(async (db) => {
        await applyMirrorItem(origin, { domain, payload })
        await writeCursor(db, runner, 'mirror', seq)
      })
      if (domain === 'transcripts') {
        const transcript = transcriptMirrorPayloadSchema.safeParse(payload)
        if (transcript.success) changedSessions.add(transcript.data.sessionId)
      }
      if (domain === 'activity') {
        const subject = activityMirrorPayloadSchema.safeParse(payload)
        if (subject.success && subject.data.activity.subject.kind === 'session') changedSessions.add(subject.data.activity.subject.id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const permanent = error instanceof PermanentApplyError
      log.warn('runner_mirror_item_failed', { hostId: runner.hostId, organizationId: runner.organizationId, seq, domain, key, permanent, error: message })
      if (!permanent) break
      await writeCursor(database, runner, 'mirror', seq)
    }
    lastSeq = seq
  }
  for (const sessionId of changedSessions) onTranscriptChanged?.(sessionId)
  return { lastSeq }
}
