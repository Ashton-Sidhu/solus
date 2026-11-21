import { formatSessionCloudScope, parseSessionCloudScope } from '@solus/contracts/session-repositories'

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
