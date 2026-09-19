import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { CloudQueuedPrompt } from '@solus/contracts/types'
import { getDatabase, type Db } from '../db/database'
import { RUNNER_LEASE_TTL_MS, type ClaimedPrompt } from '../server/uplink/runner-protocol'
import { ulid } from '../tasks/ulid'
import { sessionPromptQueue, sessionRecords, sessionRunnerLeases } from './schema'

/**
 * The durable prompt queue (docs/plans/cloud-service-model.md §4). A person
 * sends a prompt to a cloud session while its runner is away; it waits on the
 * workspace service until the runner claims it under the session's lease,
 * dispatches it as an authored turn, and settles it by the epoch it claimed it
 * under. Every read and write names the organization.
 */

const stateSchema = z.enum(['waiting', 'claimed', 'dispatched', 'failed', 'cancelled'])

const rowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  author_user_id: z.string(),
  author_display_name: z.string().nullable(),
  text: z.string(),
  state: stateSchema,
  claimed_by_host_id: z.string().nullable(),
  claim_epoch: z.number().nullable(),
  created_at: z.number(),
  claimed_at: z.number().nullable(),
  settled_at: z.number().nullable(),
  error: z.string().nullable(),
})

type Row = z.infer<typeof rowSchema>

const ROW_COLUMNS = sql`
  id, session_id, author_user_id, author_display_name, text, state, claimed_by_host_id, claim_epoch,
  created_at, claimed_at, settled_at, error
`

function promptFromRow(row: Row): CloudQueuedPrompt {
  return {
    queueId: row.id,
    sessionId: row.session_id,
    text: row.text,
    author: { userId: row.author_user_id, displayName: row.author_display_name },
    state: row.state,
    createdAt: row.created_at,
    claimedByHostId: row.claimed_by_host_id,
    settledAt: row.settled_at,
    error: row.error,
  }
}

function claimedFromRow(row: Row, epoch: number): ClaimedPrompt {
  const author: ClaimedPrompt['author'] = { userId: row.author_user_id }
  if (row.author_display_name) author.displayName = row.author_display_name
  return { queueId: row.id, sessionId: row.session_id, epoch, text: row.text, author, createdAt: row.created_at }
}

export interface EnqueuePromptInput {
  sessionId: string
  authorUserId: string
  authorDisplayName: string | null
  text: string
}

export async function enqueuePrompt(organizationId: string, input: EnqueuePromptInput, now = Date.now()): Promise<CloudQueuedPrompt> {
  const id = ulid(now)
  await getDatabase().run(sql`
    INSERT INTO ${sessionPromptQueue} (id, organization_id, session_id, author_user_id, author_display_name, text, state, created_at)
    VALUES (${id}, ${organizationId}, ${input.sessionId}, ${input.authorUserId}, ${input.authorDisplayName}, ${input.text}, 'waiting', ${now})
  `)
  return {
    queueId: id,
    sessionId: input.sessionId,
    text: input.text,
    author: { userId: input.authorUserId, displayName: input.authorDisplayName },
    state: 'waiting',
    createdAt: now,
    claimedByHostId: null,
    settledAt: null,
    error: null,
  }
}

/** Every prompt ever sent to the session, oldest first. */
export async function listQueue(organizationId: string, sessionId: string): Promise<CloudQueuedPrompt[]> {
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT ${ROW_COLUMNS} FROM ${sessionPromptQueue}
    WHERE organization_id = ${organizationId} AND session_id = ${sessionId}
    ORDER BY created_at, id
  `))
  return rows.map(promptFromRow)
}

/**
 * Withdraws a prompt that is still waiting. Only its author or a host
 * administrator may; a prompt a runner already claimed is past withdrawing and
 * answers null, as does one that does not exist.
 */
export async function cancelPrompt(organizationId: string, queueId: string, callerUserId: string, isAdmin: boolean, now = Date.now()): Promise<CloudQueuedPrompt | null> {
  return getDatabase().transaction(async (db) => {
    const row = rowSchema.nullish().parse(await db.get(sql`
      SELECT ${ROW_COLUMNS} FROM ${sessionPromptQueue} WHERE organization_id = ${organizationId} AND id = ${queueId}
    `))
    if (!row || row.state !== 'waiting') return null
    if (!isAdmin && row.author_user_id !== callerUserId) throw new Error('Only the author or a host administrator can withdraw a queued prompt.')
    await db.run(sql`
      UPDATE ${sessionPromptQueue} SET state = 'cancelled', settled_at = ${now}
      WHERE organization_id = ${organizationId} AND id = ${queueId} AND state = 'waiting'
    `)
    return promptFromRow({ ...row, state: 'cancelled', settled_at: now })
  })
}

const leaseEpochSchema = z.object({ epoch: z.number() })

/**
 * Takes or renews the session's lease for this host. The same host renews and
 * keeps its epoch; another host takes an expired lease at the next epoch; a
 * live lease held elsewhere is left alone and the session is skipped (null).
 */
async function leaseSession(db: Db, organizationId: string, sessionId: string, hostId: string, now: number): Promise<number | null> {
  const expiresAt = now + RUNNER_LEASE_TTL_MS
  const row = leaseEpochSchema.nullish().parse((await db.all(sql`
    INSERT INTO ${sessionRunnerLeases} (session_id, organization_id, host_id, epoch, expires_at)
    VALUES (${sessionId}, ${organizationId}, ${hostId}, 1, ${expiresAt})
    ON CONFLICT (session_id) DO UPDATE SET
      host_id = excluded.host_id,
      epoch = CASE WHEN session_runner_leases.host_id = excluded.host_id THEN session_runner_leases.epoch ELSE session_runner_leases.epoch + 1 END,
      expires_at = excluded.expires_at
    WHERE session_runner_leases.organization_id = excluded.organization_id
      AND (session_runner_leases.host_id = excluded.host_id OR session_runner_leases.expires_at <= ${now})
    RETURNING epoch
  `))[0])
  return row?.epoch ?? null
}

const sessionIdRowSchema = z.object({ session_id: z.string() })

/**
 * What this runner may dispatch now, oldest first, at most `limit`. In one
 * transaction: a claim whose lease ran out unsettled goes back to waiting for
 * anyone to take; then every session this runner holds (by its record) that has
 * a waiting prompt is leased or skipped, and the prompts of the leased sessions
 * are marked claimed under the lease's epoch.
 */
export async function claimForRunner(organizationId: string, hostId: string, limit: number, now = Date.now()): Promise<ClaimedPrompt[]> {
  if (limit <= 0) return []
  return getDatabase().transaction(async (db) => {
    await db.run(sql`
      UPDATE ${sessionPromptQueue} SET state = 'waiting', claimed_by_host_id = NULL, claim_epoch = NULL, claimed_at = NULL
      WHERE organization_id = ${organizationId} AND state = 'claimed' AND session_id IN (
        SELECT session_id FROM ${sessionRunnerLeases} WHERE organization_id = ${organizationId} AND expires_at <= ${now}
      )
    `)
    const sessions = sessionIdRowSchema.array().parse(await db.all(sql`
      SELECT DISTINCT session_id FROM ${sessionPromptQueue}
      WHERE organization_id = ${organizationId} AND state = 'waiting' AND session_id IN (
        SELECT session_id FROM ${sessionRecords} WHERE organization_id = ${organizationId} AND runner_host_id = ${hostId}
      )
      ORDER BY session_id
    `))
    const claimed: ClaimedPrompt[] = []
    for (const { session_id: sessionId } of sessions) {
      if (claimed.length >= limit) break
      const epoch = await leaseSession(db, organizationId, sessionId, hostId, now)
      if (epoch === null) continue
      const rows = rowSchema.array().parse(await db.all(sql`
        SELECT ${ROW_COLUMNS} FROM ${sessionPromptQueue}
        WHERE organization_id = ${organizationId} AND session_id = ${sessionId} AND state = 'waiting'
        ORDER BY created_at, id
        LIMIT ${limit - claimed.length}
      `))
      if (rows.length === 0) continue
      await db.run(sql`
        UPDATE ${sessionPromptQueue} SET state = 'claimed', claimed_by_host_id = ${hostId}, claim_epoch = ${epoch}, claimed_at = ${now}
        WHERE organization_id = ${organizationId} AND id IN (${sql.join(rows.map((row) => sql`${row.id}`), sql`, `)})
      `)
      for (const row of rows) claimed.push(claimedFromRow(row, epoch))
    }
    return claimed.sort((a, b) => a.createdAt - b.createdAt || (a.queueId < b.queueId ? -1 : a.queueId > b.queueId ? 1 : 0))
  })
}

export type SettleOutcome = { settled: true; sessionId: string } | { settled: false }

/**
 * The runner's word on a claim: dispatched, or failed with why. Only the claim
 * this host holds under this epoch settles; a runner that lost the lease finds
 * its claim already back in waiting, or another's, and is refused.
 */
export async function settleForRunner(
  organizationId: string,
  hostId: string,
  queueId: string,
  epoch: number,
  state: 'dispatched' | 'failed',
  error?: string,
  now = Date.now(),
): Promise<SettleOutcome> {
  const row = sessionIdRowSchema.nullish().parse((await getDatabase().all(sql`
    UPDATE ${sessionPromptQueue} SET state = ${state}, settled_at = ${now}, error = ${state === 'failed' ? error ?? 'failed' : null}
    WHERE organization_id = ${organizationId} AND id = ${queueId}
      AND state = 'claimed' AND claimed_by_host_id = ${hostId} AND claim_epoch = ${epoch}
    RETURNING session_id
  `))[0])
  return row ? { settled: true, sessionId: row.session_id } : { settled: false }
}
