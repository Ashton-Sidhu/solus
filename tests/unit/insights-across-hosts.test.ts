import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/insights-across-hosts.md: a host pulls the turns its owner ran on
// other hosts from the workspace service into its own metrics.db. The list
// carries turn rows; a turn's tree is a separate read that only the person who
// ran it may make. A pull never overwrites a turn this host recorded.

let read: typeof import('@solus/server/data/insights/api-operations')
let turns: typeof import('@solus/server/data/insights/api-turns')
let sinks: typeof import('@solus/server/sync/mirror/mirror-sinks')
let pullModule: typeof import('@solus/server/sync/insight-pull')
let metricsDb: typeof import('@solus/server/data/insights/metrics-db')
let spanTable: typeof import('@solus/server/data/insights/span-table')
let turnPage: typeof import('@solus/server/data/insights/turn-page')
let database: typeof import('@solus/server/db/database')
let dataDir: string
const previous = process.env.SOLUS_DATA_DIR
const now = Date.parse('2026-09-28T12:00:00Z')
const HOUR = 60 * 60 * 1000

function member(userId: string): WorkspaceRequestContext {
  return {
    principal: { kind: 'org-member', userId, organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'cloud', displayName: userId, deviceId: 'device', deviceLabel: 'Browser', expiresAt: now + 300_000 },
    home: { kind: 'organization', organizationId: 'A', serviceId: 'api' }, scopes: ['insights:read'],
  }
}

const longResponse = 'r'.repeat(5_000)
const longPrompt = 'p'.repeat(500)

async function mirror(hostId: string, traceId: string, userId: string, startedAt: number, extra: { children?: number } = {}): Promise<void> {
  const root = {
    spanId: traceId, traceId, kind: 'turn', name: 'turn', service: 'solus.sessions', sessionId: `session-${traceId}`, provider: 'claude-code', model: 'claude-sonnet-5',
    userId, userEmail: `${userId}@example.test`, startedAt, endedAt: startedAt + 100, status: 'ok',
    attrs: { costUsd: 0.5, toolCallCount: 2, prompt: longPrompt, response: longResponse, systemPrompt: 'system' },
  }
  await sinks.applyMirrorItem({ organizationId: 'A', hostId }, { domain: 'insights', payload: { span: root, events: [] } })
  for (let index = 0; index < (extra.children ?? 0); index++) {
    const child = { ...root, spanId: `${traceId}-child-${index}`, parentSpanId: traceId, kind: 'tool_call', name: 'Bash', startedAt: startedAt + 10, endedAt: startedAt + 20, attrs: { input: '{"command":"ls"}' } }
    await sinks.applyMirrorItem({ organizationId: 'A', hostId }, {
      domain: 'insights',
      payload: { span: child, events: [{ eventId: startedAt + index, traceId, spanId: child.spanId, occurredAt: startedAt + 15, level: 'info', name: 'ran', tag: 'tool', file: 'tool.ts', attrs: {} }] },
    })
  }
}

/** The workspace service as a person, answered by the same operations HTTP calls. */
function sourceFor(userId: string) {
  return async () => ({
    listInsights: (query: Parameters<typeof read.readInsightPage>[1]) => read.readInsightPage(member(userId), query, now),
    getInsightSpans: (insightId: string) => read.readInsightTree(member(userId), insightId),
  })
}

function pull(userId = 'alice') {
  return new pullModule.InsightPull({
    userId: () => userId,
    hostId: () => 'this-host',
    organizations: () => ['A'],
    source: sourceFor(userId),
    now: () => now,
  })
}

interface LocalRow { span_id: string; host_id: string | null; attrs: string; user_id: string | null }
function localRows(): LocalRow[] {
  const rows: unknown = metricsDb.getMetricsDb().prepare('SELECT span_id, host_id, attrs, user_id FROM spans ORDER BY span_id').all()
  // SAFETY: the statement selects exactly these columns.
  return rows as LocalRow[]
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-insights-across-hosts-')); process.env.SOLUS_DATA_DIR = dataDir
  database = await import('@solus/server/db/database')
  read = await import('@solus/server/data/insights/api-operations')
  turns = await import('@solus/server/data/insights/api-turns')
  sinks = await import('@solus/server/sync/mirror/mirror-sinks')
  pullModule = await import('@solus/server/sync/insight-pull')
  metricsDb = await import('@solus/server/data/insights/metrics-db')
  spanTable = await import('@solus/server/data/insights/span-table')
  turnPage = await import('@solus/server/data/insights/turn-page')
})

beforeEach(async () => {
  await database.getDatabase().run(sql`DELETE FROM insight_log_events`)
  await database.getDatabase().run(sql`DELETE FROM insight_spans`)
  metricsDb.getMetricsDb().exec('DELETE FROM log_events; DELETE FROM spans;')
})

afterAll(async () => {
  metricsDb.closeMetricsDb()
  await resetTestDatabase(); rmSync(dataDir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previous
})

describe('turn rows on the workspace service', () => {
  test('a row carries the root attributes and a short prompt, not the response or system prompt', async () => {
    // WHY: a pull downloads rows for every turn in the window; the long texts
    // are what makes a row heavy, and the tree carries them when it is opened.
    await mirror('laptop', 'trace-alice', 'alice', now - HOUR)
    const page = await read.readInsightPage(member('alice'), { limit: 50 }, now)
    const [alice] = page.items
    expect(alice?.attrs.toolCallCount).toBe(2)
    expect(alice?.attrs.costUsd).toBe(0.5)
    expect(alice?.attrs.response).toBeUndefined()
    expect(alice?.attrs.systemPrompt).toBeUndefined()
    expect(alice?.attrs.prompt).toBe(longPrompt.slice(0, 200))
    expect(alice?.attrs.promptTruncated).toBe(true)
  })

  test('any member of the organization reads a turn\'s full tree, and no other organization does', async () => {
    // WHY: the organization view shows what the Insights page shows today,
    // for every member's turns; the organization is the boundary.
    await mirror('laptop', 'trace-alice', 'alice', now - HOUR, { children: 2 })
    const id = turns.insightIdentity('laptop', 'trace-alice')
    for (const reader of ['alice', 'bob']) {
      const tree = await read.readInsightTree(member(reader), id)
      expect(tree.spans.map((span) => span.spanId).sort()).toEqual(['trace-alice', 'trace-alice-child-0', 'trace-alice-child-1'])
      expect(tree.spans.find((span) => span.spanId === 'trace-alice')?.attrs.response).toBe(longResponse)
      expect(tree.events).toHaveLength(2)
    }
    const otherOrganization: WorkspaceRequestContext = { ...member('alice'), home: { kind: 'organization', organizationId: 'B', serviceId: 'api' } }
    await expect(read.readInsightTree(otherOrganization, id)).rejects.toThrow('Resource not found')
  })
})

describe('the pull on a host', () => {
  test('writes only the person\'s turns from other hosts, and a second pull writes nothing new', async () => {
    await mirror('laptop', 'trace-1', 'alice', now - HOUR)
    await mirror('this-host', 'trace-own', 'alice', now - HOUR)
    await mirror('laptop', 'trace-bob', 'bob', now - HOUR)
    const changes: string[] = []
    const stop = spanTable.onTurnRowWritten((change) => changes.push(change.traceId))

    await pull().request()
    expect(localRows().map((row) => [row.span_id, row.host_id, row.user_id])).toEqual([['trace-1', 'laptop', 'alice']])
    expect(changes).toEqual(['trace-1'])

    await pull().request()
    expect(localRows()).toHaveLength(1)
    expect(changes).toEqual(['trace-1'])
    stop()
  })

  test('a turn this host recorded keeps its own row when the cloud sends a copy', async () => {
    // WHY: the own row is complete (response, system prompt); the pulled copy is trimmed.
    spanTable.writeSpan({ spanId: 'trace-1', traceId: 'trace-1', kind: 'turn', name: 'turn', service: 'solus.sessions', startedAt: now - HOUR, endedAt: now - HOUR + 100, status: 'ok', attrs: { response: 'full answer' } })
    await mirror('laptop', 'trace-1', 'alice', now - HOUR)
    await pull().request()
    const [row] = localRows()
    expect(row?.host_id).toBeNull()
    expect(JSON.parse(row?.attrs ?? '{}').response).toBe('full answer')
  })

  test('a later pull finds a turn that arrived late but started inside the overlap', async () => {
    await mirror('laptop', 'trace-newest', 'alice', now - HOUR)
    await pull().request()
    // Mirrored after the first pull, started before the newest pulled turn.
    await mirror('desktop', 'trace-late', 'alice', now - 3 * HOUR)
    await pull().request()
    expect(localRows().map((row) => row.span_id)).toEqual(['trace-late', 'trace-newest'])
  })

  test('opening a pulled turn writes its tree once, with the full root', async () => {
    await mirror('laptop', 'trace-1', 'alice', now - HOUR, { children: 2 })
    const host = pull()
    await host.request()
    expect(JSON.parse(localRows()[0]?.attrs ?? '{}').response).toBeUndefined()

    expect(await host.fetchTree('trace-1')).toBe(true)
    const rows = localRows()
    expect(rows.map((row) => row.span_id)).toEqual(['trace-1', 'trace-1-child-0', 'trace-1-child-1'])
    expect(rows.every((row) => row.host_id === 'laptop')).toBe(true)
    expect(JSON.parse(rows[0]?.attrs ?? '{}').response).toBe(longResponse)
    expect(await host.fetchTree('trace-1')).toBe(false)
    expect(metricsDb.getMetricsDb().prepare('SELECT COUNT(*) AS count FROM log_events').get()).toEqual({ count: 2 })
  })

  test('a turn this host ran is never fetched from the cloud', async () => {
    spanTable.writeSpan({ spanId: 'trace-own', traceId: 'trace-own', kind: 'turn', name: 'turn', service: 'solus.sessions', startedAt: now, endedAt: now + 1, status: 'ok' })
    expect(await pull().fetchTree('trace-own')).toBe(false)
  })

  test('a pull says when it starts and ends, so a client can show that rows may still arrive', async () => {
    await mirror('laptop', 'trace-1', 'alice', now - HOUR)
    const states: Array<{ pulling: boolean; error: string | null }> = []
    const host = new pullModule.InsightPull({
      userId: () => 'alice', hostId: () => 'this-host', organizations: () => ['A'], now: () => now,
      source: sourceFor('alice'), onChange: (state) => states.push(state),
    })
    const running = host.request()
    expect(host.state().pulling).toBe(true)
    await running
    expect(states).toEqual([{ pulling: true, error: null }, { pulling: false, error: null }])
  })

  test('a failed pull is reported and leaves the local rows as they were', async () => {
    const failing = new pullModule.InsightPull({
      userId: () => 'alice', hostId: () => 'this-host', organizations: () => ['A'], now: () => now,
      source: async () => { throw new Error('offline') },
    })
    await failing.request()
    expect(failing.state()).toEqual({ pulling: false, error: 'offline' })
    expect(localRows()).toEqual([])
  })
})

describe('the listing by host', () => {
  const window = { timeRange: { from: now - 24 * HOUR, to: now + HOUR } }

  test('the host filter narrows to one host or to this host, and the choices still list every host', async () => {
    // WHY: the filter is how a person reads one machine's turns; picking one
    // must not hide the others from the menu it was picked in.
    spanTable.writeSpan({ spanId: 'trace-own', traceId: 'trace-own', kind: 'turn', name: 'turn', service: 'solus.sessions', startedAt: now - HOUR, endedAt: now - HOUR + 100, status: 'ok', attrs: { hostname: 'this-mac' } })
    await mirror('laptop', 'trace-laptop', 'alice', now - 2 * HOUR)
    await mirror('desktop', 'trace-desktop-1', 'alice', now - 3 * HOUR)
    await mirror('desktop', 'trace-desktop-2', 'alice', now - 4 * HOUR)
    await pull().request()

    const traces = (filter: Parameters<typeof turnPage.turnPage>[0]) => {
      const page = turnPage.turnPage(filter).page
      const at = page.columns.findIndex((column) => column.name === 'trace_id')
      return page.rows.map((row) => row[at])
    }
    const request = { ...window, pageIndex: 0, pageSize: 25, sort: { field: 'started_at' as const, dir: 'desc' as const } }
    expect(traces(request)).toEqual(['trace-own', 'trace-laptop', 'trace-desktop-1', 'trace-desktop-2'])
    expect(traces({ ...request, hostId: 'desktop' })).toEqual(['trace-desktop-1', 'trace-desktop-2'])
    expect(traces({ ...request, hostId: null })).toEqual(['trace-own'])

    const summary = turnPage.turnListingSummary({ ...window, hostId: 'laptop' })
    expect(summary.totalRows).toBe(1)
    expect(summary.hosts).toEqual([
      { hostId: 'desktop', hostname: null, count: 2 },
      { hostId: null, hostname: 'this-mac', count: 1 },
      { hostId: 'laptop', hostname: null, count: 1 },
    ])
  })
})
