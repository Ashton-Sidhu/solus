import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../db/database'
import { createLogger } from '../logger'
import { PermanentApplyError } from './outbox/outbox-store'
import { runnerDeliveryCursors } from './outbox/schema'
import { getSessionRecord, upsertSessionRecord } from '../data/sessions/session-records'
import { readSessionAdmission } from '../data/sessions/session-admissions'
import { applyMirrorItem } from './mirror/mirror-sinks'
import type { ShareManager } from '../sharing/share-manager'
import type { Principal } from '../admission/principal'
import type { SessionRecordUpsert } from '@solus/contracts/types'
import {
  activityMirrorPayloadSchema,
  sessionRecordUpsertWireSchema,
  transcriptMirrorPayloadSchema,
  type RunnerDeliverItem,
  type RunnerDeliverRequest,
  type RunnerDeliverResponse,
} from './runner-protocol'

const log = createLogger('main', 'runner-intake')

/**
 * The Solus API's side of host delivery (docs/plans/simplify-auth-and-sync.md §4.5).
 * A host's items land in the host's organization through the same sinks
 * and record store a host uses for its own. A batch is applied in one transaction
 * with one cursor write for the (host, person), which is what makes a redelivery
 * harmless: a crash cannot apply an item and leave the cursor before it.
 *
 * Each item applies under a savepoint. One that can never apply
 * (`PermanentApplyError`) is rolled back alone, skipped, and named; one that may
 * apply later (any other error) is rolled back and stops the batch there, and the
 * host sends it and the rest again.
 */

export type RunnerPrincipal = Extract<Principal, { kind: 'runner' }>

export interface RunnerIntakeDeps {
  shares?: ShareManager
  /** A mirrored session's transcript or activity changed: its readers hear it once per batch. */
  onTranscriptChanged?: (sessionId: string) => void
}

const cursorRowSchema = z.object({ last_seq: z.number() })

async function readCursor(db: Db, runner: RunnerPrincipal): Promise<number> {
  const row = cursorRowSchema.nullish().parse(await db.get(sql`
    SELECT last_seq FROM ${runnerDeliveryCursors}
    WHERE organization_id = ${runner.organizationId} AND host_id = ${runner.hostId} AND actor_user_id = ${runner.ownerUserId}
  `))
  return row?.last_seq ?? 0
}

async function writeCursor(db: Db, runner: RunnerPrincipal, seq: number): Promise<void> {
  await db.run(sql`
    INSERT INTO ${runnerDeliveryCursors} (organization_id, host_id, actor_user_id, last_seq, updated_at)
    VALUES (${runner.organizationId}, ${runner.hostId}, ${runner.ownerUserId}, ${seq}, ${Date.now()})
    ON CONFLICT (organization_id, host_id, actor_user_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
  `)
}

/**
 * A session's facts as the host holds them. The owner is established once, from
 * verified authority (organization-vms §4): the person whose admission created the
 * record at the API, or, for a session no admission names, the person delivering.
 * Facts never name or change the owner, and a replay restores nothing.
 */
async function applySessionFacts(runner: RunnerPrincipal, upsert: SessionRecordUpsert, shares: ShareManager | undefined): Promise<void> {
  const { admissionId, privateToOwner, ...facts } = upsert
  const existing = await getSessionRecord(runner.organizationId, facts.sessionId)
  const admission = !existing && admissionId ? await readSessionAdmission(runner.organizationId, admissionId) : null
  const owner = admission && admission.hostId === runner.hostId ? admission.ownerKey : runner.ownerUserId
  const record: SessionRecordUpsert = { ...facts, runnerHostId: runner.hostId }
  // A host sends only published sessions, so the record it creates is published, owned by `owner`.
  await upsertSessionRecord(runner.organizationId, record, { organizationId: runner.organizationId, published: true, ownerKey: owner })
  // A new session is the organization's to open, like anything else the host writes here;
  // a chat is its owner's alone until they share it (plan 004 D14).
  if (shares && !existing && !privateToOwner) await shares.shareRunnerWrite({ kind: 'session', id: facts.sessionId }, runner, owner)
}

async function applyItem(runner: RunnerPrincipal, item: RunnerDeliverItem, deps: RunnerIntakeDeps): Promise<void> {
  const origin = { organizationId: runner.organizationId, hostId: runner.hostId }
  switch (item.kind) {
    case 'session': {
      const facts = sessionRecordUpsertWireSchema.safeParse(item.payload)
      if (!facts.success) throw new PermanentApplyError(`Malformed session facts: ${facts.error.message}`)
      return applySessionFacts(runner, facts.data, deps.shares)
    }
    default: return applyMirrorItem(origin, { kind: item.kind, payload: item.payload }, deps.shares)
  }
}

/** The session an applied item changed the history of, for the readers who watch it. */
function changedSessionOf(item: RunnerDeliverItem): string | null {
  if (item.kind === 'transcript') {
    const transcript = transcriptMirrorPayloadSchema.safeParse(item.payload)
    return transcript.success ? transcript.data.sessionId : null
  }
  if (item.kind === 'activity') {
    const subject = activityMirrorPayloadSchema.safeParse(item.payload)
    return subject.success && subject.data.activity.subject.kind === 'session' ? subject.data.activity.subject.id : null
  }
  return null
}

export async function applyRunnerDelivery(runner: RunnerPrincipal, request: RunnerDeliverRequest, deps: RunnerIntakeDeps = {}): Promise<RunnerDeliverResponse> {
  const changedSessions = new Set<string>()
  const failed: RunnerDeliverResponse['failed'] = []
  // A runner that sends items out of order gets them applied in order anyway.
  const items = [...request.items].sort((a, b) => a.seq - b.seq)
  const lastSeq = await getDatabase().transaction(async (db) => {
    const cursor = await readCursor(db, runner)
    let lastSeq = cursor
    for (const item of items) {
      if (item.seq <= lastSeq) continue
      await db.run(sql`SAVEPOINT runner_item`)
      try {
        await applyItem(runner, item, deps)
        await db.run(sql`RELEASE SAVEPOINT runner_item`)
        const sessionId = changedSessionOf(item)
        if (sessionId) changedSessions.add(sessionId)
      } catch (error) {
        await db.run(sql`ROLLBACK TO SAVEPOINT runner_item`)
        await db.run(sql`RELEASE SAVEPOINT runner_item`)
        const message = error instanceof Error ? error.message : String(error)
        const permanent = error instanceof PermanentApplyError
        log.warn('runner_item_failed', { hostId: runner.hostId, organizationId: runner.organizationId, seq: item.seq, kind: item.kind, permanent, error: message })
        if (!permanent) break
        failed.push({ seq: item.seq, error: message })
      }
      lastSeq = item.seq
    }
    if (lastSeq !== cursor) await writeCursor(db, runner, lastSeq)
    return lastSeq
  })
  for (const sessionId of changedSessions) deps.onTranscriptChanged?.(sessionId)
  return { lastSeq, failed }
}
