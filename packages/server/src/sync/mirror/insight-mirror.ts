import type { LogEventRow, SpanRow } from '../../data/insights/span-table'
import { LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { isOrganizationAttached } from '../../host/organization-attachment'
import { appendMirror } from './mirror-log'

/**
 * The insights producer of the mirror (organization-scope §6, §6.1). A span of
 * a session's turn tree — one that names a `sessionId` — is appended with the
 * log events it owns, once, when `metrics.db` has it, to the organization the
 * session belongs to. A host-internal span (a boot phase, an indexer sweep, an
 * update check) names no session and stays local, as does every span of a
 * session that has no organization.
 *
 * Whether an organization's session sends its Insights is the organization's
 * decision, held by `InsightsPolicy`: on when its owners keep **Sync all
 * Insights** on; else only from a machine attached to it for organization work
 * (managed or self-hosted, organization-vms §2), or when the person at this host
 * opted in for that organization. The transcript is never implied by this:
 * sending Insights publishes no transcript, work, or attachment (§3).
 */

/** Who decides whether an organization's Insights leave this machine. */
export interface InsightsPolicy {
  /** The organization's own **Sync all Insights** setting; null when the host has not heard of the organization. */
  syncAllInsights(organizationId: string): boolean | null
  /** The person at this host opted this machine's work for the organization in (§6.1, policy off). */
  optedIn(organizationId: string): boolean
  /** This machine is attached to the organization for organization work. */
  attached(organizationId: string): boolean
}

let policy: InsightsPolicy = { syncAllInsights: () => null, optedIn: () => false, attached: () => false }

/** Boot installs the host's policy source once; tests install their own. */
export function useInsightsPolicy(next: InsightsPolicy): void {
  policy = next
}

/** Whether a session of `organizationId` sends its Insights from this machine (§6.1's table). */
export function insightsEligible(organizationId: string): boolean {
  if (organizationId === LOCAL_ORGANIZATION_ID) return false
  // An organization VM runs organization work: its Insights always sync, like a managed machine's (organization-vms §2).
  if (isOrganizationAttached() && policy.attached(organizationId)) return true
  if (policy.syncAllInsights(organizationId) === true) return true
  return policy.optedIn(organizationId)
}

/**
 * Route from the session organization captured at turn admission. Setup spans
 * can finish before the session record exists; later assignment must not
 * backfill an earlier Local span. Eligibility is still checked at capture.
 */
export async function mirrorInsightSpan(span: SpanRow, events: LogEventRow[], eventIds: number[]): Promise<number> {
  const organizationId = span.organizationId
  if (!span.sessionId || !organizationId || !insightsEligible(organizationId)) return 0
  // The person who acted delivers it, with their delegated token (plans/010-standard-oauth.md).
  return appendMirror({ organizationId, actorUserId: span.userId ?? '' }, 'insights', [{
    key: span.spanId,
    payload: { span, events: events.map((event, index) => ({ ...event, eventId: eventIds[index] })) },
  }]).count
}
