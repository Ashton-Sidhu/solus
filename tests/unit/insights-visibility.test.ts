import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { MetricsTurnPageRequest } from '@solus/contracts/observability-types'
import type { Principal } from '@solus/server/admission/principal'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/access-model.md §4 D2: in Insights a person sees the turns they ran;
// a host administrator sees every turn in their scope. Every filtered read (the
// turn page, its summary, the query builder, distinct values, a trace) holds the
// same rule, so no read shows a turn another refuses.

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let metricsDb: typeof import('@solus/server/data/insights/metrics-db')
let turnPage: typeof import('@solus/server/data/insights/turn-page')
let visibility: typeof import('@solus/server/data/insights/visibility')
let compiler: typeof import('@solus/server/data/insights/query-compiler')
let sqlGuard: typeof import('@solus/server/data/insights/sql-guard')
let actors: typeof import('@solus/server/admission/actor')

const member = (userId: string, organizationRole: 'owner' | 'member' = 'member'): Principal => ({
  kind: 'org-member', userId, organizationId: 'org1', organizationRole, teamIds: [], hostKind: 'managed',
  displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})

const request: MetricsTurnPageRequest = { timeRange: { from: 0, to: 1_000 }, pageIndex: 0, pageSize: 50, sort: { field: 'started_at', dir: 'asc' } }

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-insights-visibility-'))
  process.env.SOLUS_DATA_DIR = dataDir
  const spanTable = await import('@solus/server/data/insights/span-table')
  const registries = await import('@solus/server/data/insights/registries')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
  turnPage = await import('@solus/server/data/insights/turn-page')
  visibility = await import('@solus/server/data/insights/visibility')
  compiler = await import('@solus/server/data/insights/query-compiler')
  sqlGuard = await import('@solus/server/data/insights/sql-guard')
  actors = await import('@solus/server/admission/actor')
  metricsDb.closeMetricsDb()
  // dan's and bob's turns in org1, eve's in org2, and the host's own (no person).
  const turns: Array<[string, string | undefined, string | undefined]> = [['t-dan', 'dan', 'org1'], ['t-bob', 'bob', 'org1'], ['t-eve', 'eve', 'org2'], ['t-host', undefined, 'org1']]
  turns.forEach(([traceId, userId, organizationId], index) => {
    spanTable.writeSpan({
      spanId: traceId, traceId, kind: registries.SPAN_KINDS.turn, name: 'turn', service: registries.SPAN_SERVICES.sessions,
      sessionId: `s-${traceId}`, provider: 'claude-code', model: `model-${traceId}`, startedAt: index, endedAt: index + 1, status: 'ok',
      userId, organizationId, attrs: { prompt: traceId },
    })
  })
})

afterAll(() => {
  metricsDb.closeMetricsDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function seenBy(principal: Principal) {
  const visible = visibility.visibleInsights(actors.actorFor(principal))
  const page = turnPage.turnPage(request, visible).page
  const traceColumn = page.columns.findIndex((column) => column.name === 'trace_id')
  const compiled = compiler.compileQuerySpec({ filters: [{ field: 'kind', op: 'eq', value: 'turn' }] }, visible)
  const listing = sqlGuard.runCompiledSql(compiled.sql, compiled.params)
  const listingColumn = listing.columns.findIndex((column) => column.name === 'trace_id')
  return {
    page: page.rows.map((row) => row[traceColumn]).sort(),
    total: turnPage.turnListingSummary(request, visible).totalRows,
    query: listing.rows.map((row) => row[listingColumn]).sort(),
    traces: ['t-dan', 't-bob', 't-eve', 't-host'].filter((traceId) => visibility.traceVisible(traceId, visible)),
  }
}

describe('Insights visibility', () => {
  test('a member reads only the turns they ran, in every filtered read', () => {
    expect(seenBy(member('dan'))).toEqual({ page: ['t-dan'], total: 1, query: ['t-dan'], traces: ['t-dan'] })
  })

  test('an organization owner, an administrator, reads every turn of the organization and none of another', () => {
    expect(seenBy(member('alice', 'owner'))).toEqual({ page: ['t-bob', 't-dan', 't-host'], total: 3, query: ['t-bob', 't-dan', 't-host'], traces: ['t-dan', 't-bob', 't-host'] })
  })

  test('the host itself reads every turn', () => {
    const visible = visibility.visibleInsights(actors.HOST_ACTOR)
    expect(turnPage.turnListingSummary(request, visible).totalRows).toBe(4)
  })
})
