import { describe, expect, test } from 'bun:test'
import type { MetricsFieldDescriptor, MetricsSchema } from '@solus/contracts/observability-types'
import {
  SQL_COMPLETIONS,
  schemaCompletionsAtCursor,
  schemaTableCompletions,
} from '@solus/workspace-ui/components/insights/lib/sql-editor-extensions'

const column = (name: string, type: MetricsFieldDescriptor['type'] = 'string'): MetricsFieldDescriptor => ({
  name,
  type,
  description: `${name} docs`,
})

const SCHEMA: MetricsSchema = {
  views: [
    {
      view: 'turns',
      kinds: ['turn'],
      internal: false,
      description: 'One row per turn',
      columns: [column('trace_id'), column('model'), column('cost_usd', 'number')],
    },
    {
      view: 'events',
      kinds: ['tool_call'],
      internal: false,
      description: 'One row per event',
      columns: [column('trace_id'), column('kind'), column('tool')],
    },
    {
      view: 'internal_events',
      kinds: ['internal.rpc'],
      internal: true,
      description: 'Solus internals',
      columns: [column('rpc_method')],
    },
  ],
  base: {
    table: 'spans',
    description: 'Raw span facts',
    columns: [column('span_id'), column('attrs', 'json')],
  },
  relationships: [],
}

function optionsFor(sql: string) {
  return schemaCompletionsAtCursor(sql, sql.length, SCHEMA)?.options ?? []
}

describe('Insights SQL schema completion', () => {
  test('turns and events lead table positions without hiding advanced sources', () => {
    const options = schemaTableCompletions(SCHEMA)
    expect(options.map((option) => option.label)).toEqual([
      'turns',
      'events',
      'internal_events',
      'spans',
    ])
    expect(options.find((option) => option.label === 'turns')?.boost).toBe(70)
    expect(options.find((option) => option.label === 'events')?.boost).toBe(70)
    expect(options.find((option) => option.label === 'spans')?.boost).toBeLessThan(0)
    expect(options.every((option) => option.type === 'table')).toBe(true)
    // One flat list: a section's rank would outrank relevance for every option.
    expect(options.every((option) => option.section === undefined)).toBe(true)
  })

  test('table positions stay with one completion source so matches are not duplicated', () => {
    expect(schemaCompletionsAtCursor('select * from ev', 'select * from ev'.length, SCHEMA)).toBeNull()
  })

  test('before FROM, completion offers the two-table column model and merges shared columns', () => {
    const options = optionsFor('select tr')
    expect(options.map((option) => option.label)).toEqual([
      'trace_id',
      'model',
      'cost_usd',
      'kind',
      'tool',
    ])
    // The owning tables are their own field so they render beside the name;
    // the detail column carries the data type and the key role.
    expect(options.find((option) => option.label === 'trace_id')?.qualifier).toBe('turns, events')
    expect(options.find((option) => option.label === 'trace_id')?.detail).toBe('string · primary key')
    expect(options.find((option) => option.label === 'model')?.detail).toBe('string')
    expect(options.find((option) => option.label === 'trace_id')?.type).toBe('primary-key')
    expect(options.find((option) => option.label === 'model')?.type).toBe('column')
    expect(options.every((option) => option.boost === 90)).toBe(true)
  })

  test('after FROM, unqualified completion narrows to columns from the referenced table', () => {
    const options = optionsFor('select * from events where to')
    expect(options.map((option) => option.label)).toEqual(['trace_id', 'kind', 'tool'])
    expect(options.every((option) => option.qualifier === 'events')).toBe(true)
    expect(options.find((option) => option.label === 'trace_id')?.type).toBe('foreign-key')
  })

  test('a join offers the union of both referenced tables and keeps shared columns singular', () => {
    const options = optionsFor('select * from turns join events on tr')
    expect(options.filter((option) => option.label === 'trace_id')).toHaveLength(1)
    expect(options.map((option) => option.label)).toContain('cost_usd')
    expect(options.map((option) => option.label)).toContain('tool')
  })

  test('clauses complete whole, so a two-word clause is offered rather than its first word', () => {
    const labels = SQL_COMPLETIONS.map((option) => option.label)
    expect(labels).toContain('group by')
    expect(labels).toContain('order by')
    expect(labels).toContain('partition by')
    expect(labels).toContain('left join')
  })

  test('the reserved-word dump is gone, so typing a clause offers the clause', () => {
    // These are real SQLite keywords and were ranked beside `group by` itself.
    // Nothing in a guarded read-only select can use them.
    const labels = SQL_COMPLETIONS.map((option) => option.label)
    expect(labels).not.toContain('current_default_transform_group')
    expect(labels).not.toContain('current_transform_group_for_type')
    expect(labels.every((label) => !label.includes('transform'))).toBe(true)
  })

  test('a function completes with its parentheses and a place for the argument', () => {
    const count = SQL_COMPLETIONS.find((option) => option.label === 'count()')
    expect(count?.type).toBe('function')
    expect(count?.apply).toBeDefined()
    expect(SQL_COMPLETIONS.find((option) => option.label === 'count(*)')).toBeDefined()
  })

  test('qualified completion stays with CodeMirror so table aliases resolve correctly', () => {
    const sql = 'select e. from events e'
    expect(schemaCompletionsAtCursor(sql, 'select e.'.length, SCHEMA)).toBeNull()
  })
})
