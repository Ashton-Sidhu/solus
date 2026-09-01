import { describe, expect, test } from 'bun:test'
import type { MetricsFieldDescriptor, MetricsSchema } from '@solus/contracts/observability-types'
import {
  advancedSources,
  enumeratedValues,
  groupedColumns,
  queryTables,
  schemaSources,
  searchColumns,
} from '@solus/workspace-ui/components/insights/lib/schema-model'

// The schema panel renders the two-table model structurally. These tests encode
// the presentation rules: sources keep their roles and order, columns group by
// query role in query-building order, and a host that serves no groups (or an
// unknown one) degrades to a plain list rather than a lying heading.

const column = (
  name: string,
  group?: MetricsFieldDescriptor['group'],
): MetricsFieldDescriptor => ({
  name,
  type: 'string',
  description: '',
  ...(group === undefined ? {} : { group }),
})

const SCHEMA: MetricsSchema = {
  views: [
    { view: 'turns', kinds: ['turn'], internal: false, description: 'turns view', columns: [column('a')] },
    { view: 'events', kinds: ['tool_call'], internal: false, description: 'events view', columns: [column('b')] },
    { view: 'internal_events', kinds: ['internal.rpc'], internal: true, description: 'internal view', columns: [column('c')] },
  ],
  base: { table: 'spans', description: 'fact table', columns: [column('d')] },
  relationships: [],
}

describe('schema sources', () => {
  test('query tables lead in served order, the fact table anchors last', () => {
    expect(schemaSources(SCHEMA).map((source) => [source.name, source.role])).toEqual([
      ['turns', 'table'],
      ['events', 'table'],
      ['internal_events', 'internal'],
      ['spans', 'fact'],
    ])
  })

  test('the internal slice is documented without a separate visibility mode', () => {
    expect(schemaSources(SCHEMA).map((source) => source.name)).toEqual([
      'turns', 'events', 'internal_events', 'spans',
    ])
  })
})

describe('column grouping', () => {
  test('groups follow query-building order, not declaration order', () => {
    const groups = groupedColumns([
      column('prompt', 'detail'),
      column('cost_usd', 'measure'),
      column('tool_time_ms', 'child_time'),
      column('model', 'dimension'),
      column('trace_id', 'identity'),
    ])
    expect(groups.map((group) => group.columns.map((c) => c.name))).toEqual([
      ['model'], ['cost_usd'], ['tool_time_ms'], ['trace_id'], ['prompt'],
    ])
    expect(groups[0].label).toBe('Dimensions')
    expect(groups[2].label).toBe('Child time')
    expect(groups[2].hint).toContain('summed per turn')
  })

  test('declaration order is kept inside a group', () => {
    const groups = groupedColumns([
      column('provider', 'dimension'),
      column('model', 'dimension'),
    ])
    expect(groups).toEqual([
      { label: '', hint: '', columns: [column('provider', 'dimension'), column('model', 'dimension')] },
    ])
  })

  test('a host serving no groups degrades to one unlabelled list, never a lying heading', () => {
    const groups = groupedColumns([column('a'), column('b')])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('')
    expect(groups[0].columns.map((c) => c.name)).toEqual(['a', 'b'])
  })

  test('an unknown group from a newer host falls back to details', () => {
    const groups = groupedColumns([
      column('model', 'dimension'),
      { ...column('mystery'), group: 'hologram' as never },
    ])
    expect(groups.map((group) => group.columns.map((c) => c.name))).toEqual([
      ['model'], ['mystery'],
    ])
    expect(groups[1].label).toBe('Details')
  })

  test('no columns, no groups', () => {
    expect(groupedColumns([])).toEqual([])
  })
})

// The sheet's search exists for the reader who knows the fact but not the
// table, so it must cross tables and say which one answered.
describe('column search', () => {
  const described = (
    name: string,
    description: string,
  ): MetricsFieldDescriptor => ({ name, type: 'string', description })

  const SEARCHABLE: MetricsSchema = {
    views: [
      {
        view: 'turns',
        kinds: ['turn'],
        internal: false,
        description: '',
        columns: [described('cost_usd', 'Provider-measured spend'), described('model', 'Executed model')],
      },
      {
        view: 'events',
        kinds: ['tool_call'],
        internal: false,
        description: '',
        columns: [described('tool', 'Tool name'), described('exit_code', 'What the command cost the run')],
      },
    ],
    base: { table: 'spans', description: '', columns: [described('cost_source', 'Where cost came from')] },
    relationships: [],
  }

  const sources = schemaSources(SEARCHABLE)

  test('a match names its own table, across every source at once', () => {
    expect(searchColumns(sources, 'cost').map((m) => [m.source, m.column.name])).toEqual([
      ['turns', 'cost_usd'],
      ['spans', 'cost_source'],
      ['events', 'exit_code'],
    ])
  })

  test('search reaches the advanced sources, which are browsable too', () => {
    // WHY: a search that omits half the queryable model sends the reader who
    // typed the right word away with nothing.
    expect(searchColumns(sources, 'cost_source').map((m) => m.source)).toEqual(['spans'])
  })

  test('an exact name outranks a prefix, and a name outranks a description', () => {
    expect(searchColumns(sources, 'tool').map((m) => m.column.name)).toEqual(['tool'])
    expect(searchColumns(sources, 'model').map((m) => m.column.name)).toEqual(['model'])
  })

  test('an empty query is not a match-everything query', () => {
    expect(searchColumns(sources, '   ')).toEqual([])
  })
})

// The sheet opens on a choice between two tables, so the split between what a
// reader chooses and what merely stays reachable is load-bearing.
describe('the table choice', () => {
  test('the choice is the two query tables — not the internal slice or the fact table', () => {
    expect(queryTables(SCHEMA).map((table) => table.name)).toEqual(['turns', 'events'])
  })

  test('the sources kept out of the choice stay listed, so their columns stay readable', () => {
    expect(advancedSources(SCHEMA).map((source) => source.name)).toEqual([
      'internal_events',
      'spans',
    ])
  })

  test('every served source is either a choice or an advanced one', () => {
    // WHY: a source in neither list is a table nobody can reach from the sheet.
    expect([...queryTables(SCHEMA), ...advancedSources(SCHEMA)]).toHaveLength(
      schemaSources(SCHEMA).length,
    )
  })
})

// The longest cell in the sheet is `kind`, which documents ten span kinds with
// a gloss each. As one paragraph nobody reads it, yet the values are the whole
// point of the column: a kind is a WHERE filter, not a table.
describe('enumerated descriptions', () => {
  test('a colon-introduced list splits into its lead clause and its values', () => {
    const split = enumeratedValues(
      "What happened: 'setup' (pre-agent turn setup: git state, task prep), 'tool_call' (one tool invocation)",
    )
    expect(split?.lead).toBe('What happened')
    expect(split?.values).toEqual([
      { value: 'setup', gloss: 'pre-agent turn setup: git state, task prep' },
      { value: 'tool_call', gloss: 'one tool invocation' },
    ])
  })

  test('values without a gloss carry an empty one rather than dropping out', () => {
    const split = enumeratedValues("Prompt source: 'typed', 'queued', or 'dispatch'")
    expect(split?.values.map((entry) => entry.value)).toEqual(['typed', 'queued', 'dispatch'])
    expect(split?.values.every((entry) => entry.gloss === '')).toBe(true)
  })

  test('an "e.g." example list is not drawn as a closed set of values', () => {
    // WHY: chips read as "these are the values"; the registry only claimed two
    // examples, and stating more than it did is a lie the reader cannot check.
    expect(enumeratedValues("Owning subsystem, e.g. 'solus.sessions' or 'solus.text-generation'"))
      .toBeNull()
  })

  test('prose and single-value descriptions stay prose', () => {
    expect(enumeratedValues('Absolute project directory the work ran in')).toBeNull()
    expect(enumeratedValues("Span kind: 'turn' only")).toBeNull()
  })
})
