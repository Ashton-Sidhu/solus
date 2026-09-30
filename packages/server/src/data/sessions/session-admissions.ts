import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../../db/database'
import { sessionAdmissions } from './schema'

/**
 * The Solus API's durable acceptance of a new organization session before its
 * provider starts (organization-vms §3). An admission names the organization, the
 * Solus session id the execution host admitted the run under, the host, and the
 * person whose run authority asked. Asking again answers the same admission; the
 * same id for another person or host is refused, so a retry cannot duplicate or
 * re-own a session.
 */

export interface SessionAdmission {
  organizationId: string
  admissionId: string
  hostId: string
  ownerUserId: string
  createdAt: number
}

const rowSchema = z.object({
  organization_id: z.string(),
  admission_id: z.string(),
  host_id: z.string(),
  owner_user_id: z.string(),
  created_at: z.number(),
})

export class SessionAdmissionConflict extends Error {
  constructor() {
    super('This session was admitted for another person or host.')
    this.name = 'SessionAdmissionConflict'
  }
}

export async function readSessionAdmission(organizationId: string, admissionId: string): Promise<SessionAdmission | null> {
  const row = rowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT organization_id, admission_id, host_id, owner_user_id, created_at FROM ${sessionAdmissions}
    WHERE organization_id = ${organizationId} AND admission_id = ${admissionId}
  `))
  return row ? { organizationId: row.organization_id, admissionId: row.admission_id, hostId: row.host_id, ownerUserId: row.owner_user_id, createdAt: row.created_at } : null
}

export async function admitSessionRecord(admission: Omit<SessionAdmission, 'createdAt'>): Promise<SessionAdmission> {
  await getDatabase().run(sql`
    INSERT INTO ${sessionAdmissions} (organization_id, admission_id, host_id, owner_user_id, created_at)
    VALUES (${admission.organizationId}, ${admission.admissionId}, ${admission.hostId}, ${admission.ownerUserId}, ${Date.now()})
    ON CONFLICT (organization_id, admission_id) DO NOTHING
  `)
  const stored = await readSessionAdmission(admission.organizationId, admission.admissionId)
  if (!stored) throw new Error('The session admission was not stored.')
  if (stored.ownerUserId !== admission.ownerUserId || stored.hostId !== admission.hostId) throw new SessionAdmissionConflict()
  return stored
}
