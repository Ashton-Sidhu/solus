import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let read: typeof import('@solus/server/data/insights/api-operations')
let turns: typeof import('@solus/server/data/insights/api-turns')
let database: typeof import('@solus/server/db/database')
let dataDir: string
const previous = process.env.SOLUS_DATA_DIR
const now = Date.parse('2026-09-28T12:00:00Z')
const context: WorkspaceRequestContext = {
  principal: { kind: 'org-member', userId: 'alice', organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'cloud', displayName: 'Alice', deviceId: 'device', deviceLabel: 'Browser', expiresAt: now + 300_000 },
  home: { kind: 'organization', organizationId: 'A', serviceId: 'api' }, scopes: ['insights:read'],
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-api-insights-')); process.env.SOLUS_DATA_DIR = dataDir
  database = await import('@solus/server/db/database')
  read = await import('@solus/server/data/insights/api-operations')
  turns = await import('@solus/server/data/insights/api-turns')
  const db = database.getDatabase()
  await db.transaction(async tx => {
    for (let i = 0; i < 1500; i++) {
      const host = 'host-' + (i % 3)
      const trace = 'trace-' + Math.floor(i / 3).toString().padStart(4, '0')
      await tx.run(sql`INSERT INTO insight_spans(organization_id,host_id,span_id,trace_id,kind,name,service,started_at,ended_at,duration_ms,status,attrs,user_id,provider)
        VALUES ('A',${host},${trace},${trace},'turn','turn','test',${now - 1000},${now},1000,'ok','{}',${i % 2 ? 'alice' : 'bob'},'codex')`)
    }
    await tx.run(sql`INSERT INTO insight_spans(organization_id,host_id,span_id,trace_id,kind,name,service,started_at,ended_at,duration_ms,status,attrs)
      VALUES ('B','host-0','trace-0000','trace-0000','turn','turn','test',${now - 1000},${now},1000,'ok','{}')`)
  })
})
afterAll(async () => {
  await resetTestDatabase(); rmSync(dataDir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previous
})

describe('bounded organization Insights', () => {
  test('deep cursor paging keeps every tied turn exactly once, including equal trace IDs on different hosts', async () => {
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await read.readInsightPage(context, { limit: 137, cursor }, now)
      expect(page.items.length).toBeLessThanOrEqual(137)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024)
      for (const item of page.items) { expect(seen.has(item.id)).toBe(false); seen.add(item.id) }
      expect(page).not.toHaveProperty('total')
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen.size).toBe(1500)
  })

  test('individual reads bind organization and complete stored identity', async () => {
    const id = turns.insightIdentity('host-1', 'trace-0000')
    expect((await read.readInsight(context, id)).hostId).toBe('host-1')
    const other: WorkspaceRequestContext = { ...context, home: { kind: 'organization', organizationId: 'B', serviceId: 'api' }, principal: { ...context.principal, kind: 'org-member', userId: 'alice', organizationId: 'B', organizationRole: 'member', teamIds: [], hostKind: 'cloud', displayName: 'Alice', deviceId: 'device', deviceLabel: 'Browser', expiresAt: now + 300_000 } }
    await expect(read.readInsight(other, id)).rejects.toThrow('Resource not found')
  })

  test('a cursor keeps the window of its first page, and oversized windows are refused', async () => {
    const page = await read.readInsightPage(context, { limit: 50, userId: 'alice' }, now)
    expect(page.items.every(item => item.userId === 'alice')).toBe(true)
    const later = await read.readInsightPage(context, { limit: 50, userId: 'alice', cursor: page.nextCursor! }, now + 60_000)
    expect(later.window).toEqual(page.window)
    await expect(read.readInsightPage(context, { limit: 50, since: '2026-01-01T00:00:00Z' }, now)).rejects.toThrow('at most 31 days')
  })

  test.skipIf(process.env.SOLUS_DB === 'postgres')('SQLite uses the scoped paging index for the time range', async () => {
    const rows = await database.getDatabase().all<{ detail: string }>(sql`EXPLAIN QUERY PLAN SELECT trace_id, host_id FROM insight_spans WHERE organization_id='A' AND kind='turn' AND span_id=trace_id AND started_at >= ${now - 86400000} AND started_at < ${now} ORDER BY started_at DESC, host_id DESC, trace_id DESC LIMIT 51`)
    expect(rows.some(row => row.detail.includes('insight_turns_page'))).toBe(true)
    expect(rows.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false)
  })
})

test.skipIf(process.env.SOLUS_DB !== 'postgres')('PostgreSQL seeks the root-turn page index', async () => {
  await database.getDatabase().run(sql`ANALYZE insight_spans`)
  const rows = await database.getDatabase().all<{ 'QUERY PLAN': string }>(sql`EXPLAIN SELECT trace_id, host_id FROM insight_spans WHERE organization_id='A' AND kind='turn' AND span_id=trace_id AND started_at >= ${now - 86400000} AND started_at < ${now} ORDER BY started_at DESC, host_id DESC, trace_id DESC LIMIT 51`)
  expect(rows.map(row => row['QUERY PLAN']).join('\n')).toContain('insight_turns_page')
})
