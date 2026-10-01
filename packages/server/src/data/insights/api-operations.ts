import {
  workspaceInsightQuerySchema, INSIGHT_DEFAULT_WINDOW_MS, INSIGHT_MAX_WINDOW_MS,
  type WorkspaceInsight, type WorkspaceInsightPage, type WorkspaceInsightQuery, type WorkspaceInsightTree,
} from '@solus/contracts/solus-api'
import { SolusApiError } from '../../admission/workspace-error'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { requireScope } from '../workspace/context'
import { pageOf, readCursor } from '../workspace/page'
import { getApiInsight, getApiInsightTree, listApiInsights } from './api-turns'

function organization(context: WorkspaceRequestContext): string {
  requireScope(context, 'insights:read')
  if (context.home.kind !== 'organization') throw new SolusApiError(503, 'CAPABILITY_UNAVAILABLE', 'Organization Insights is not available in Local context.')
  if (context.principal.kind !== 'org-member') throw new SolusApiError(403, 'FORBIDDEN', 'Organization membership is required for Insights.')
  return context.home.organizationId
}

/** Every read enforces the same organization policy; knowing an ID grants nothing. */
export async function readInsight(context: WorkspaceRequestContext, insightId: string): Promise<WorkspaceInsight> {
  const result = await getApiInsight(organization(context), insightId)
  if (!result) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
  return result
}

export async function readInsightTree(context: WorkspaceRequestContext, insightId: string): Promise<WorkspaceInsightTree> {
  const result = await getApiInsightTree(organization(context), insightId)
  if (!result) throw new SolusApiError(404, 'NOT_FOUND', 'Resource not found.')
  return result
}

export async function readInsightPage(context: WorkspaceRequestContext, query: WorkspaceInsightQuery, now = Date.now()): Promise<WorkspaceInsightPage> {
  query = workspaceInsightQuerySchema.parse(query)
  const organizationId = organization(context)
  const after = readCursor(query.cursor)
  // The window's end is fixed on the first page so later pages do not shift when turns arrive.
  const until = query.until ? Date.parse(query.until) : after?.until ?? now
  const since = query.since ? Date.parse(query.since) : until - INSIGHT_DEFAULT_WINDOW_MS
  if (until <= since || until - since > INSIGHT_MAX_WINDOW_MS) {
    throw new SolusApiError(400, 'INVALID_REQUEST', 'Insights requires a positive time range of at most 31 days.')
  }
  const rows = await listApiInsights(organizationId, query, since, until, after)
  const page = pageOf(rows, query.limit, row => ({ time: Date.parse(row.startedAt), hostId: row.hostId, id: row.traceId, until }))
  return { ...page, window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() } }
}
