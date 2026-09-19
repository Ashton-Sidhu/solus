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
import { acquireLock, credentialExpiresAt, isOrganizationMember, readCredential, releaseLock, vaultConfigured, writeBack } from '../vault/vault'
import {
  type RunnerCredentialError,
  type RunnerCredentialLeaseRequest,
  type RunnerCredentialLeaseResponse,
  type RunnerCredentialLockRequest,
  type RunnerCredentialLockResponse,
  type RunnerCredentialUnlockRequest,
  type RunnerCredentialWritebackRequest,
  type RunnerCredentialWritebackResponse,
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

// ── The credential vault (§5) ────────────────────────────────────────────────

/** A credential route's answer: the body, or the refusal and the status it rides on. */
export type RunnerCredentialOutcome<T> =
  | { kind: 'ok'; body: T }
  | { kind: 'refused'; status: 403 | 404 | 409 | 503; error: RunnerCredentialError }

/**
 * Whether this runner may touch this person's credential: the vault must have a
 * key, and the person must have been admitted to the runner's organization.
 */
async function admitCredentialRequest(runner: RunnerPrincipal, userId: string): Promise<Extract<RunnerCredentialOutcome<never>, { kind: 'refused' }> | null> {
  if (!vaultConfigured()) return { kind: 'refused', status: 503, error: 'vault_not_configured' }
  if (!await isOrganizationMember(runner.organizationId, userId)) {
    log.info('runner_credential_refused', { hostId: runner.hostId, organizationId: runner.organizationId, userId, reason: 'not_a_member' })
    return { kind: 'refused', status: 403, error: 'not_a_member' }
  }
  return null
}

export async function leaseRunnerCredential(runner: RunnerPrincipal, request: RunnerCredentialLeaseRequest): Promise<RunnerCredentialOutcome<RunnerCredentialLeaseResponse>> {
  const refused = await admitCredentialRequest(runner, request.userId)
  if (refused) return refused
  const credential = await readCredential(request.userId, request.provider)
  if (!credential) return { kind: 'refused', status: 404, error: 'no_credential' }
  log.info('runner_credential_leased', { hostId: runner.hostId, organizationId: runner.organizationId, userId: request.userId, provider: request.provider, version: credential.version })
  return { kind: 'ok', body: credential }
}

export async function lockRunnerCredential(runner: RunnerPrincipal, request: RunnerCredentialLockRequest): Promise<RunnerCredentialOutcome<RunnerCredentialLockResponse>> {
  const refused = await admitCredentialRequest(runner, request.userId)
  if (refused) return refused
  const lock = await acquireLock(request.userId, request.provider, runner.hostId, request.ttlMs ?? 90_000)
  return { kind: 'ok', body: lock }
}

export async function unlockRunnerCredential(runner: RunnerPrincipal, request: RunnerCredentialUnlockRequest): Promise<RunnerCredentialOutcome<{ released: boolean }>> {
  const refused = await admitCredentialRequest(runner, request.userId)
  if (refused) return refused
  return { kind: 'ok', body: { released: await releaseLock(request.userId, request.provider, runner.hostId) } }
}

export async function writebackRunnerCredential(runner: RunnerPrincipal, request: RunnerCredentialWritebackRequest): Promise<RunnerCredentialOutcome<RunnerCredentialWritebackResponse>> {
  const refused = await admitCredentialRequest(runner, request.userId)
  if (refused) return refused
  const expiresAt = request.expiresAt === undefined ? credentialExpiresAt(request.provider, request.material) : request.expiresAt
  const outcome = await writeBack(request.userId, request.provider, request.baseVersion, request.material, expiresAt)
  if (outcome.kind === 'ok') return { kind: 'ok', body: { version: outcome.version } }
  if (outcome.kind === 'no_credential') return { kind: 'refused', status: 404, error: 'no_credential' }
  return { kind: 'refused', status: 409, error: 'version_conflict' }
}
