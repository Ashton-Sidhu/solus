import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  SCHEMA_RELATIONSHIPS,
  metricsSchema,
  registeredViewNames,
  schemaForPrompt,
} from '@solus/server/observability/field-registry'
import { presetsFor } from '@solus/workspace-ui/components/insights/lib/insights-queries'
import type { TimeRange } from '@solus/workspace-ui/components/insights/lib/time-range'

// `declaredSourceView` is pure, but its module reaches the metrics database at
// import time, which is not a built-in under the test runtime.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type SqlGuardModule = typeof import('@solus/server/observability/sql-guard')
let sqlGuard: SqlGuardModule

beforeAll(async () => {
  sqlGuard = await import('@solus/server/observability/sql-guard')
})

// A user cannot write a cross-kind question from a flat list of column names:
// the views are slices of one table, and nothing about that is visible in a
// column list. These tests encode that the relationship model is served — once,
// from the registry — to every surface that documents the schema, and that
// documenting it did not quietly widen what declares a result grain.

const RANGE: TimeRange = { kind: 'relative', ms: 86_400_000 }

describe('the served schema documents the fact table, not just the views', () => {
  test('the spans table is served with the columns that exist nowhere else', () => {
    const { base } = metricsSchema()
    const columns = base.columns.map((column) => column.name)
    expect(base.table).toBe('spans')
    // `kind` is how a cross-kind query slices, `attrs` is where every
    // unpromoted field lives. Neither appears in any generated view.
    expect(columns).toContain('kind')
    expect(columns).toContain('attrs')
    expect(columns).toContain('trace_id')
    for (const column of base.columns) expect(column.description.length).toBeGreaterThan(0)
  })

  test('every relationship fact is served to the clients', () => {
    expect(metricsSchema().relationships).toEqual(SCHEMA_RELATIONSHIPS)
    expect(SCHEMA_RELATIONSHIPS.length).toBeGreaterThan(0)
  })

  test('every served column declares its query role, so the panel can render a model instead of a column dump', () => {
    const roles = new Set(['identity', 'dimension', 'timing', 'measure', 'child_time', 'tool', 'detail'])
    const schema = metricsSchema()
    const sources = [...schema.views.map((view) => view.columns), schema.base.columns]
    for (const columns of sources) {
      for (const column of columns) {
        expect(roles.has(column.group ?? '')).toBe(true)
      }
    }
  })

  test('the query schema exposes the same semantic timing model as the waterfall', () => {
    const schema = metricsSchema()
    const turns = schema.views.find((view) => view.view === 'turns')
    const events = schema.views.find((view) => view.view === 'events')

    expect(turns?.columns.find((column) => column.name === 'provider_wait_ms')).toBeDefined()
    expect(turns?.columns.find((column) => column.name === 'thinking_time_ms')?.description)
      .toContain('lead-in')
    expect(events?.columns.find((column) => column.name === 'duration_ms')?.description)
      .toContain('Thinking includes')
  })

  test('the join key and the fact table are stated, not left to be inferred', () => {
    const facts = SCHEMA_RELATIONSHIPS.join(' ')
    expect(facts).toContain('trace_id')
    expect(facts).toContain('spans')
    // The user must be told the cost of joining before they write one.
    expect(facts.toLowerCase()).toContain('grid')
  })

  test('documenting spans did not make it a registered view — a raw-spans query still declares no grain', () => {
    expect(registeredViewNames().has('spans')).toBe(false)
    expect(sqlGuard.declaredSourceView('select kind, count(*) from spans group by kind')).toBeUndefined()
    expect(sqlGuard.declaredSourceView('select tool from events')).toBe('events')
  })

  test('the two-table model is what registers — a per-kind table name declares nothing', () => {
    expect([...registeredViewNames()].sort()).toEqual(['events', 'internal_events', 'turns'])
    expect(sqlGuard.declaredSourceView('select tool from tool_calls')).toBeUndefined()
  })
})

describe('the NL agent is told the same model as the panel', () => {
  test('the prompt carries the relationship facts and the spans DDL', () => {
    const prompt = schemaForPrompt()
    for (const fact of SCHEMA_RELATIONSHIPS) expect(prompt).toContain(fact)
    expect(prompt).toContain('CREATE TABLE spans (')
    expect(prompt).toContain('CREATE VIEW turns (')
  })
})

describe('no shipped preset joins', () => {
  test('the former join preset reads the pre-summed column off turns instead', () => {
    const preset = presetsFor('sql', RANGE).find((p) => p.id === 'tool-time-by-model')
    expect(preset).toBeDefined()
    expect(preset?.text).toContain('tool_time_ms')
    expect(preset?.text).toContain('from turns')
    expect(sqlGuard.declaredSourceView(preset?.text ?? '')).toBe('turns')
  })

  test('every shipped preset reads exactly one registered view — the model the presets teach is joinless', () => {
    for (const preset of presetsFor('sql', RANGE)) {
      expect(preset.text.toLowerCase()).not.toContain(' join ')
      expect(sqlGuard.declaredSourceView(preset.text)).toBeDefined()
    }
  })
})
