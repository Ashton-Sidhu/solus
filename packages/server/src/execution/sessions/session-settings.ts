import type { ExecutionPreferences } from '@solus/contracts/settings'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { getSessionRecord } from '../../data/sessions/session-records'
import { LOCAL_ORGANIZATION_ID } from '../../host/host-category'

/**
 * What each live session's current run was dispatched with, by Solus session
 * id: the organization its work belongs to and the preferences of the person
 * it works for (plans/018 §3.1). Tools a turn calls, and the children and
 * subagents it starts, read it.
 *
 * In memory: a run that outlives the host is dispatched again, and recorded
 * again, after the restart.
 */
export interface SessionSettings {
  organizationId: string
  preferences: ExecutionPreferences | undefined
}

const sessions = new Map<string, SessionSettings>()

export function recordSessionSettings(sessionId: string, settings: SessionSettings): void {
  sessions.set(sessionId, settings)
}

export function sessionSettings(sessionId: string | undefined): SessionSettings | undefined {
  return sessionId ? sessions.get(sessionId) : undefined
}

/**
 * The organization a session's work belongs to when its own record says
 * Local: a child session (a subagent, a worker, a fork) inherits the
 * organization of the session it came from. `originRecordId` is the record id
 * (provider thread) of that session. The origin's durable record answers
 * first, then each ancestor's through its record's parent link, so the answer
 * survives a host restart; a live origin whose record is not written yet
 * answers from its dispatch. An origin with neither leaves the child Local.
 */
export async function inheritedOrganizationOf(
  sessionId: string,
  recordOrganizationId: string,
  originSessionId: string | null | undefined,
): Promise<string> {
  if (recordOrganizationId !== LOCAL_ORGANIZATION_ID) return recordOrganizationId
  const own = sessionSettings(sessionId)?.organizationId
  if (own && own !== LOCAL_ORGANIZATION_ID) return own
  const seen = new Set<string>()
  for (let origin = originSessionId; origin && !seen.has(origin);) {
    seen.add(origin)
    const record = await getSessionRecord(ANY_ORGANIZATION, origin)
    if (!record) return sessionSettings(origin)?.organizationId ?? LOCAL_ORGANIZATION_ID
    if (record.organizationId !== LOCAL_ORGANIZATION_ID) return record.organizationId
    const live = sessionSettings(origin)?.organizationId
    if (live && live !== LOCAL_ORGANIZATION_ID) return live
    origin = record.parentSessionId
  }
  return LOCAL_ORGANIZATION_ID
}

/** Each record's parent link, once its record is read: written with the record's first row, it does not change. */
const parentLinks = new Map<string, string | null>()

/** The session a session was started from; null for a root, undefined before the record exists. */
export async function parentSessionIdOf(sessionId: string): Promise<string | null | undefined> {
  if (parentLinks.has(sessionId)) return parentLinks.get(sessionId)
  const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
  if (record) parentLinks.set(sessionId, record.parentSessionId)
  return record?.parentSessionId
}

/** For tests: start with no recorded sessions. */
export function resetSessionSettingsForTests(): void {
  sessions.clear()
}
