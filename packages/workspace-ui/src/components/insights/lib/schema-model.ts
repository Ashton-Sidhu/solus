import type {
  MetricsFieldDescriptor,
  MetricsFieldGroup,
  MetricsSchema,
} from '@solus/contracts/observability-types'

// The schema sheet's data model (docs/plans/observability.md).
//
// The sheet renders the two-table query model structurally — `turns` and
// `events` as the choice, joined on trace_id, with `internal_events` and the
// `spans` fact table kept apart as advanced sources. This module shapes the
// served schema into that presentation: which sources exist and in what role,
// how one source's columns group by the role they play in a query, and how a
// column is found without knowing which table holds it.

export interface SchemaSource {
  name: string
  description: string
  columns: MetricsFieldDescriptor[]
  /** How the panel places the source: the query tables lead as cards,
   *  `internal_events` follows them, and `spans` anchors below. */
  role: 'table' | 'internal' | 'fact'
}

/** Sources in display order: the query tables, then the fact table beneath. */
export function schemaSources(schema: MetricsSchema): SchemaSource[] {
  const views = schema.views
    .map((view): SchemaSource => ({
      name: view.view,
      description: view.description,
      columns: view.columns,
      role: view.internal ? 'internal' : 'table',
    }))
  return [
    ...views,
    {
      name: schema.base.table,
      description: schema.base.description,
      columns: schema.base.columns,
      role: 'fact',
    },
  ]
}

/** The join key the connector between the two cards states. */
export const JOIN_KEY = 'trace_id'

/** What reading the fact table costs — stated where `spans` is offered. */
export const FACT_TABLE_NOTE = 'renders as a plain grid, no drill-through'

const GROUP_LABELS = {
  dimension: { label: 'Dimensions', hint: 'group and filter by these' },
  measure: { label: 'Measures', hint: 'aggregate these' },
  child_time: { label: 'Child time', hint: 'summed per turn — no join needed' },
  tool: { label: 'Tool facts', hint: 'null for non-tool kinds' },
  timing: { label: 'Timing & status', hint: '' },
  identity: { label: 'Links & ids', hint: '' },
  detail: { label: 'Details', hint: '' },
} satisfies Record<MetricsFieldGroup, { label: string; hint: string }>

/** Query-building order: what you slice by, then what you aggregate, then the
 *  plumbing. Identity and free-text details close the list. */
const GROUP_ORDER: MetricsFieldGroup[] = [
  'dimension', 'measure', 'child_time', 'tool', 'timing', 'identity', 'detail',
]

export interface SchemaColumnGroup {
  /** Empty when the source has no grouping worth a header (an older host that
   *  serves no groups renders as one plain list, never one "Details" heading). */
  label: string
  /** One quiet clause after the label: what a query does with this group. */
  hint: string
  columns: MetricsFieldDescriptor[]
}

export interface SchemaColumnMatch {
  /** The table the column lives in — a match states this, because not knowing
   *  it is the reason the search exists. */
  source: string
  column: MetricsFieldDescriptor
}

/** How well a column answers the typed text. Lower sorts first; a name beats a
 *  description, and a start beats a middle. */
function matchRank(column: MetricsFieldDescriptor, needle: string): number {
  const name = column.name.toLowerCase()
  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  if (name.includes(needle)) return 2
  if (column.description.toLowerCase().includes(needle)) return 3
  return -1
}

/**
 * Every column matching `query`, across every listed source at once.
 *
 * A user who knows the fact they want but not which table records it cannot
 * navigate a table-first list, so search spans every source the sheet lists —
 * the two query tables and the advanced ones — and each hit names its own
 * table. Sources keep their served order within a rank, so `turns` leads
 * `events` on an equal match, and the advanced sources trail both.
 */
export function searchColumns(
  sources: SchemaSource[],
  query: string,
): SchemaColumnMatch[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const ranked: Array<{ rank: number; order: number; match: SchemaColumnMatch }> = []
  let order = 0
  for (const source of sources) {
    for (const column of source.columns) {
      const rank = matchRank(column, needle)
      if (rank >= 0) ranked.push({ rank, order, match: { source: source.name, column } })
      order += 1
    }
  }
  ranked.sort((left, right) => left.rank - right.rank || left.order - right.order)
  return ranked.map((entry) => entry.match)
}

/**
 * The tables the schema sheet teaches: the two a question is written against.
 *
 * `internal_events` and the `spans` fact table stay queryable, stay in the
 * editor's completion, and stay browsable under the sheet's advanced heading —
 * but a reader choosing a table is choosing between these two.
 */
export function queryTables(schema: MetricsSchema): SchemaSource[] {
  return schemaSources(schema).filter((source) => source.role === 'table')
}

/** The sources kept out of the choice above: Solus's own operations and the raw
 *  fact table. Listed, because a column list nobody can reach is not
 *  documentation, but listed apart, so the choice stays a choice of two. */
export function advancedSources(schema: MetricsSchema): SchemaSource[] {
  return schemaSources(schema).filter((source) => source.role !== 'table')
}

export interface EnumeratedValue {
  value: string
  /** The registry's parenthetical gloss, or empty when it names the value only. */
  gloss: string
}

export interface EnumeratedDescription {
  /** The clause introducing the list, without its colon. */
  lead: string
  values: EnumeratedValue[]
}

const QUOTED_VALUE = /'([^']+)'(?:\s*\(([^)]*)\))?/g

/**
 * A description that enumerates the values a column takes, split into the
 * clause before the list and the values themselves.
 *
 * `kind` documents ten span kinds with a gloss each, which as one paragraph is
 * the longest cell in the sheet and the one nobody reads — yet the values are
 * the whole point of the column, since a kind is a `WHERE` filter rather than a
 * table. Split, the values render as the list they are.
 *
 * The registry introduces a real enumeration with a colon ("What happened:",
 * "Prompt source:") and an example with "e.g.", so only the colon form splits:
 * drawing two examples as a closed set of values would state something the
 * registry does not.
 */
export function enumeratedValues(description: string): EnumeratedDescription | null {
  const colon = description.indexOf(':')
  if (colon < 0) return null
  const rest = description.slice(colon + 1)
  if (!rest.trimStart().startsWith("'")) return null
  const values = [...rest.matchAll(QUOTED_VALUE)]
    .map((match) => ({ value: match[1], gloss: match[2]?.trim() ?? '' }))
  if (values.length < 2) return null
  return { lead: description.slice(0, colon).trim(), values }
}

export function groupedColumns(columns: MetricsFieldDescriptor[]): SchemaColumnGroup[] {
  const buckets = new Map<MetricsFieldGroup, MetricsFieldDescriptor[]>()
  for (const column of columns) {
    const group: MetricsFieldGroup = column.group && GROUP_ORDER.includes(column.group)
      ? column.group
      : 'detail'
    const bucket = buckets.get(group)
    if (bucket) bucket.push(column)
    else buckets.set(group, [column])
  }
  if (buckets.size <= 1) return columns.length ? [{ label: '', hint: '', columns }] : []
  return GROUP_ORDER
    .filter((group) => buckets.has(group))
    .map((group) => ({ ...GROUP_LABELS[group], columns: buckets.get(group) ?? [] }))
}
