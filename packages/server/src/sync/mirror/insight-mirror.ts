import { splitSpanTexts, type LogEventRow, type SpanRow } from '../../data/insights/span-table'
import { LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { isOrganizationAttached } from '../../host/organization-attachment'
import { appendDelivery } from '../delivery-queue'
import type { InsightsMirrorPayload } from '../runner-protocol'

/**
 * The insights producer of the mirror (organization-scope §6, §6.1). The spans
 * of a session's turn tree — the ones that name a `sessionId` — are held until
 * the turn's root span ends, then appended with the log events they own as one
 * item, to the organization the session belongs to
 * (docs/plans/simplify-auth-and-sync.md §4.5). A span that ends after its root
 * goes as an item of its own. A host-internal span (a boot phase, an indexer sweep, an
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

type TurnSpans = InsightsMirrorPayload['spans']

/** How many turns may wait for their root at once; past it the oldest goes as it is, so a lost root costs no memory. */
const OPEN_TURN_LIMIT = 200
/** Spans of turns whose root has not ended, by trace. */
const openTurns = new Map<string, { organizationId: string; actorUserId: string; spans: TurnSpans }>()
/** Turns already sent, newest last: a span that ends after its root goes at once. */
const sentTurns = new Set<string>()

function sendTurn(traceId: string): number {
  const turn = openTurns.get(traceId)
  if (!turn) return 0
  openTurns.delete(traceId)
  sentTurns.add(traceId)
  if (sentTurns.size > OPEN_TURN_LIMIT) sentTurns.delete(sentTurns.values().next().value!)
  // The person who acted delivers it, with their delegated token (plans/010-standard-oauth.md).
  return appendDelivery({ organizationId: turn.organizationId, actorUserId: turn.actorUserId }, 'insights', [{ key: traceId, payload: { spans: turn.spans } }]).count
}

type WireSpan = TurnSpans[number]['span']

/**
 * The span as the mirror carries it: its long texts (a turn's prompt, system
 * prompt, and response; a thought) as `texts`, beside an `attrs` without them —
 * the split the host's own table makes (plans/029 §6), so the service stores
 * them as `insight_span_texts` and the cross-host trace view shows every one.
 */
function mirroredSpan(span: SpanRow): WireSpan {
  const stored = splitSpanTexts(span.attrs)
  if (stored.texts.length === 0) return span
  return { ...span, attrs: stored.attrs, texts: Object.fromEntries(stored.texts.map(({ name, text }) => [name, text])) }
}

/**
 * Route from the session organization captured at turn admission. Setup spans
 * can finish before the session record exists; later assignment must not
 * backfill an earlier Local span. Eligibility is still checked at capture.
 * Answers how many items were queued.
 */
export async function mirrorInsightSpan(span: SpanRow, events: LogEventRow[], eventIds: number[]): Promise<number> {
  const organizationId = span.organizationId
  if (!span.sessionId || !organizationId || !insightsEligible(organizationId)) return 0
  const entry = {
    span: mirroredSpan(span),
    events: events.map((event, index) => ({ ...event, eventId: eventIds[index] })),
  }
  const turn = openTurns.get(span.traceId) ?? { organizationId, actorUserId: span.userId ?? '', spans: [] }
  turn.spans.push(entry)
  openTurns.set(span.traceId, turn)
  if (!span.parentSpanId || sentTurns.has(span.traceId)) return sendTurn(span.traceId)
  if (openTurns.size > OPEN_TURN_LIMIT) return sendTurn(openTurns.keys().next().value!)
  return 0
}

/** Forget every held turn: tests start from nothing. */
export function resetInsightMirrorForTests(): void {
  openTurns.clear()
  sentTurns.clear()
}
