import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { RecordPublication } from '@solus/contracts/types'
import { getDatabase, type Db } from '../../db/database'
import { LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { provisionedOrganizationId } from '../../host/host-category'
import { hostUserKey } from '../../host/host-user'
import { session } from './schema'

/**
 * The identity of a session: its row before and after the provider starts
 * (plans/029-fresh-database-baseline.md §4.2). The row is the birth. A claim
 * or an admission makes it with its owner and organization, and neither ever
 * changes after that first insert; `started_at` stays null until the first
 * report of provider facts (`session-records.ts`). There is no in-memory
 * record of a session that is not written yet: the row is read instead.
 */

/** Who a session belongs to and where (docs/plans/access-model.md §2.2). */
export interface SessionHome {
  /** The person who started the session: its owner, stored as `created_by`. */
  ownerKey: string
  organizationId: string
}

/** What a row says about its session before any provider fact: its home, publication, and the two times. */
export interface SessionIdentity extends SessionHome {
  publication: RecordPublication
  admittedAt: number | null
  startedAt: number | null
}

const identityRowSchema = z.object({
  created_by: z.string(),
  organization_id: z.string(),
  publication: z.enum(['local', 'published']).catch('local'),
  admitted_at: z.number().nullable(),
  started_at: z.number().nullable(),
})

/** The organization this machine's own records start in when nothing else named one: a managed machine's, else Local. */
export function machineOrganizationId(): string {
  return provisionedOrganizationId() ?? LOCAL_ORGANIZATION_ID
}

/** The home a row this machine makes for a session nobody started here gets: the host's user, in the machine's organization. */
export function machineSessionHome(): SessionHome {
  return { ownerKey: hostUserKey(), organizationId: machineOrganizationId() }
}

/** The session's identity, started or not; null when no row names it. */
export async function sessionIdentityOf(sessionId: string, db: Db = getDatabase()): Promise<SessionIdentity | null> {
  const row = identityRowSchema.nullish().parse(await db.get(sql`
    SELECT created_by, organization_id, publication, admitted_at, started_at FROM ${session} WHERE session_id = ${sessionId}
  `))
  return row ? { ownerKey: row.created_by, organizationId: row.organization_id, publication: row.publication, admittedAt: row.admitted_at, startedAt: row.started_at } : null
}

/** What a claim births a session with, beyond its home. */
export interface SessionBirthOptions {
  /** Born published: an organization session the Solus API admitted (organization-vms §3). */
  published?: boolean
  /** The admission the API accepted, as the host records it: when, and for which host. */
  admittedAt?: number
  admittedHostId?: string
}

/**
 * The person who starts a session owns it: the first insert decides, and every
 * later writer keeps its owner and organization. A claim on a session that has
 * a row changes nothing. Answers whether it made the row.
 */
export async function claimSessionOwner(sessionId: string, home: SessionHome, options: SessionBirthOptions = {}, db: Db = getDatabase()): Promise<boolean> {
  const now = Date.now()
  const result = await db.run(sql`
    INSERT INTO ${session} (session_id, organization_id, created_by, publication, admitted_host_id, admitted_at, created_at)
    VALUES (${sessionId}, ${home.organizationId}, ${home.ownerKey}, ${options.published ? 'published' : 'local'}, ${options.admittedHostId ?? null}, ${options.admittedAt ?? null}, ${now})
    ON CONFLICT (session_id) DO NOTHING
  `)
  return result.changes > 0
}

/** The row every state writer needs: the session's, or one born with the machine's home. */
export async function ensureSessionRow(sessionId: string, db: Db = getDatabase()): Promise<void> {
  await claimSessionOwner(sessionId, machineSessionHome(), {}, db)
}

/**
 * The Solus API's acceptance of a new organization session before its provider
 * starts (organization-vms §3). The admission id is the Solus session id, so it
 * is the row: the person whose run authority asked owns it, and the host is the
 * executor. Asking again answers the same admission; the same id for another
 * person or host is refused, so a retry cannot duplicate or re-own a session.
 */
export interface SessionAdmission {
  organizationId: string
  admissionId: string
  hostId: string
  ownerKey: string
  createdAt: number
}

export class SessionAdmissionConflict extends Error {
  constructor() {
    super('This session was admitted for another person or host.')
    this.name = 'SessionAdmissionConflict'
  }
}

const admissionRowSchema = z.object({
  created_by: z.string(),
  admitted_host_id: z.string().nullable(),
  admitted_at: z.number().nullable(),
})

export async function readSessionAdmission(organizationId: string, admissionId: string): Promise<SessionAdmission | null> {
  const row = admissionRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT created_by, admitted_host_id, admitted_at FROM ${session}
    WHERE organization_id = ${organizationId} AND session_id = ${admissionId} AND admitted_at IS NOT NULL
  `))
  if (!row || row.admitted_host_id === null || row.admitted_at === null) return null
  return { organizationId, admissionId, hostId: row.admitted_host_id, ownerKey: row.created_by, createdAt: row.admitted_at }
}

/**
 * Admit, idempotently: the row is made published and owned by the person, or,
 * when a report of the same owner's session came first, its admission facts are
 * filled once. A row another person owns, or in another organization, is left
 * as it is and the admission is refused.
 */
export async function admitSession(admission: Omit<SessionAdmission, 'createdAt'>): Promise<SessionAdmission> {
  const now = Date.now()
  await getDatabase().run(sql`
    INSERT INTO ${session} (session_id, organization_id, created_by, publication, admitted_host_id, admitted_at, created_at)
    VALUES (${admission.admissionId}, ${admission.organizationId}, ${admission.ownerKey}, 'published', ${admission.hostId}, ${now}, ${now})
    ON CONFLICT (session_id) DO UPDATE SET
      admitted_at = COALESCE(session.admitted_at, excluded.admitted_at),
      admitted_host_id = COALESCE(session.admitted_host_id, excluded.admitted_host_id)
    WHERE session.created_by = excluded.created_by
  `)
  const row = admissionRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT created_by, admitted_host_id, admitted_at FROM ${session}
    WHERE organization_id = ${admission.organizationId} AND session_id = ${admission.admissionId}
  `))
  if (!row) throw new Error('The session admission was not stored.')
  if (row.created_by !== admission.ownerKey || row.admitted_host_id !== admission.hostId) throw new SessionAdmissionConflict()
  if (row.admitted_at === null) throw new Error('The session admission was not stored.')
  return { ...admission, createdAt: row.admitted_at }
}
