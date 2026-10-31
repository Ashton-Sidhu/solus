import { z } from 'zod'
import type { SessionPlace, SessionStarter, SessionStarterFromHost } from './types'

/** The stored shape of a session's place and starter (docs/plans/session-starter.md). */
export const sessionPlaceSchema: z.ZodType<SessionPlace> = z.enum(['chat', 'project'])

const id = z.string().min(1).max(256)

export const sessionStarterSchema: z.ZodType<SessionStarter> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), personKey: id }),
  z.strictObject({ kind: z.literal('automation'), automationId: id, runId: id }),
  z.strictObject({ kind: z.literal('webhook'), webhookId: id, deliveryId: id }),
  z.strictObject({ kind: z.literal('session'), sessionId: id, hostLabel: z.string().min(1).max(256).optional() }),
])

/** What another host may say started a session it asks for: only its own session. */
export const sessionStarterFromHostSchema: z.ZodType<SessionStarterFromHost> = z.strictObject({
  kind: z.literal('session'),
  sessionId: id,
  hostLabel: z.string().min(1).max(256),
})

/** The session on another host that started a session, or null when another starter did
 *  (docs/plans/cross-host-sessions.md). The transcript opens with a line that names that host. */
export function hostStarterOf(startedBy: SessionStarter | null | undefined): SessionStarterFromHost | null {
  return startedBy?.kind === 'session' && startedBy.hostLabel ? { ...startedBy, hostLabel: startedBy.hostLabel } : null
}

/** A stored starter, or null for one that does not read: a value from before this shape. */
export function parseStoredStarter(json: string | null): SessionStarter | null {
  if (!json) return null
  try {
    const parsed = sessionStarterSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
