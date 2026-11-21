import { formatSessionCloudScope, parseSessionCloudScope } from '@solus/contracts/session-repositories'
import { recordScopeOf, type Principal, type RecordScope } from '../../admission/principal'
import { getSessionRecord } from './session-records'

/**
 * The scope of a mirrored row (docs/plans/portable-sessions-cloud.md, "The
 * mirror for readers"): the id of an organization, or `person:<accountId>` for
 * a personal session, the same text as the cloud scope of the person's session
 * repositories. An organization id has no colon, so the two are never equal.
 * A delivery destination, the runner principal of the Solus API, and the
 * `organization_id` of the mirror tables (`transcript-schema.ts`) each hold
 * this text.
 */
export function personMirrorScope(accountId: string): string {
  return formatSessionCloudScope('person', accountId)
}

/** The account a personal mirror scope names; null for an organization. */
export function personOfMirrorScope(scope: string): string | null {
  const parsed = parseSessionCloudScope(scope)
  return parsed?.kind === 'person' ? parsed.id : null
}

/**
 * The mirror scope that a reader on the Solus API reads a session in. A
 * session with a record in the reader's organization is that organization's;
 * the gate checked the reader's standing on it. Each other session is read in
 * the reader's own person scope, which holds only what their own token
 * delivered. No reader names a scope: it comes from the principal alone.
 */
export async function readerMirrorScope(principal: Principal, sessionId: string): Promise<RecordScope> {
  const scope = recordScopeOf(principal)
  if (principal.kind !== 'org-member') return scope
  return await getSessionRecord(scope, sessionId) ? scope : personMirrorScope(principal.userId)
}
