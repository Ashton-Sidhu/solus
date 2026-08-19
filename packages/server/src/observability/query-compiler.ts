import type {
  MetricsAggregate,
  MetricsFilter,
  MetricsGroupBy,
  MetricsQuerySpec,
  MetricsTimeBucket,
} from '@solus/contracts/observability-types'
import { fieldExpression, fieldsForKind, viewNameForKind } from './field-registry'
import { SPAN_KINDS, type SpanKind } from './registries'

// ─── QuerySpec → parameterized SQL ───
//
// The builder and presets produce a QuerySpec; this compiler is the only thing
// that turns one into SQL. Field names resolve against the promoted spans
// columns, `attrs.<path>` JSON paths, or the field registry (when the spec pins
// a kind); every value rides in a bind parameter. Percentiles compile to an
// ordered-window pass because SQLite has no native percentile.

export interface CompiledQuery {
  sql: string
  params: Array<string | number>
  /** The view of the pinned kind, when the spec pins one — the declared grain
   *  the handler forwards on the result. */
  sourceView?: string
}

export const DEFAULT_QUERY_LIMIT = 1_000
export const MAX_QUERY_LIMIT = 10_000

/** Promoted spans columns a spec may reference directly. */
const SPAN_COLUMNS = new Set([
  'span_id', 'parent_span_id', 'trace_id', 'kind', 'name', 'service',
  'session_id', 'provider', 'model', 'project_root', 'origin',
  'started_at', 'ended_at', 'duration_ms', 'status',
])

/** Columns a no-aggregate listing returns, in order. */
const LISTING_COLUMNS = [
  'span_id', 'trace_id', 'kind', 'name', 'service', 'session_id', 'provider',
  'model', 'project_root', 'origin', 'started_at', 'ended_at', 'duration_ms',
  'status', 'attrs',
]

const ATTR_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const TIME_BUCKETS: Record<MetricsTimeBucket, string> = {
  minute: "strftime('%Y-%m-%dT%H:%M', started_at / 1000, 'unixepoch')",
  hour: "strftime('%Y-%m-%dT%H:00', started_at / 1000, 'unixepoch')",
  day: "date(started_at / 1000, 'unixepoch')",
  week: "date(started_at / 1000, 'unixepoch', 'weekday 0', '-6 days')",
  month: "strftime('%Y-%m', started_at / 1000, 'unixepoch')",
}

const PERCENTILES: Partial<Record<MetricsAggregate['fn'], number>> = { p50: 0.5, p95: 0.95 }
const PLAIN_AGGREGATES: Partial<Record<MetricsAggregate['fn'], string>> = {
  count: 'COUNT', avg: 'AVG', min: 'MIN', max: 'MAX', sum: 'SUM',
}

const registeredKinds = new Set<string>(Object.values(SPAN_KINDS))

/** The kind an `eq` filter pins, letting registry field names resolve. */
function pinnedKind(filters: MetricsFilter[]): SpanKind | undefined {
  const filter = filters.find((f) => f.field === 'kind' && f.op === 'eq' && typeof f.value === 'string')
  if (!filter || !registeredKinds.has(filter.value as string)) return undefined
  return filter.value as SpanKind
}

function resolveField(field: string, kind: SpanKind | undefined): string {
  if (SPAN_COLUMNS.has(field)) return field
  if (field.startsWith('attrs.')) {
    const path = field.slice('attrs.'.length)
    if (!ATTR_PATH_PATTERN.test(path)) throw new Error(`Invalid attrs path: ${field}`)
    return `json_extract(attrs, '$.${path}')`
  }
  if (kind) {
    const registered = fieldsForKind(kind).find((f) => f.name === field)
    if (registered) return fieldExpression(registered)
  }
  throw new Error(kind
    ? `Unknown query field: ${field}`
    : `Unknown query field: ${field} (registry fields need an eq filter on kind)`)
}

function bindable(value: string | number | boolean): string | number {
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

function buildWhere(spec: MetricsQuerySpec, kind: SpanKind | undefined): { clause: string; params: Array<string | number> } {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (spec.timeRange?.from !== undefined) {
    conditions.push('started_at >= ?')
    params.push(spec.timeRange.from)
  }
  if (spec.timeRange?.to !== undefined) {
    conditions.push('started_at < ?')
    params.push(spec.timeRange.to)
  }

  for (const filter of spec.filters ?? []) {
    const expression = resolveField(filter.field, kind)
    if (filter.op === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw new Error(`Filter on ${filter.field}: 'in' needs a non-empty array value`)
      }
      conditions.push(`${expression} IN (${filter.value.map(() => '?').join(', ')})`)
      params.push(...filter.value)
      continue
    }
    if (Array.isArray(filter.value)) {
      throw new Error(`Filter on ${filter.field}: array values are only valid with 'in'`)
    }
    const operators = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE' } as const
    conditions.push(`${expression} ${operators[filter.op]} ?`)
    params.push(bindable(filter.value))
  }

  return { clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid query limit: ${limit}`)
  return Math.min(limit, MAX_QUERY_LIMIT)
}

interface GroupItem { alias: string; expression: string }
interface AggregateItem { alias: string; fn: MetricsAggregate['fn']; expression: string | null }

function groupItems(groupBy: MetricsGroupBy[], kind: SpanKind | undefined): GroupItem[] {
  return groupBy.map((group) => {
    if ('timeBucket' in group) {
      const expression = TIME_BUCKETS[group.timeBucket]
      if (!expression) throw new Error(`Unknown time bucket: ${group.timeBucket}`)
      return { alias: 'bucket', expression }
    }
    return { alias: group.field.replace(/\./g, '_'), expression: resolveField(group.field, kind) }
  })
}

function aggregateItems(aggregates: MetricsAggregate[], kind: SpanKind | undefined): AggregateItem[] {
  return aggregates.map((aggregate) => {
    if (PLAIN_AGGREGATES[aggregate.fn] === undefined && PERCENTILES[aggregate.fn] === undefined) {
      throw new Error(`Unknown aggregate: ${aggregate.fn}`)
    }
    if (aggregate.as !== undefined && !ALIAS_PATTERN.test(aggregate.as)) {
      throw new Error(`Invalid aggregate alias: ${aggregate.as}`)
    }
    if (aggregate.fn === 'count') {
      return { alias: aggregate.as ?? 'count', fn: aggregate.fn, expression: null }
    }
    if (!aggregate.field) throw new Error(`Aggregate ${aggregate.fn} needs a field`)
    return {
      alias: aggregate.as ?? `${aggregate.fn}_${aggregate.field.replace(/\./g, '_')}`,
      fn: aggregate.fn,
      expression: resolveField(aggregate.field, kind),
    }
  })
}

function assertUniqueAliases(aliases: string[]): void {
  const seen = new Set<string>()
  for (const alias of aliases) {
    if (seen.has(alias)) throw new Error(`Duplicate output column: ${alias}`)
    seen.add(alias)
  }
}

/** ORDER BY resolves to 1-based output positions, so aliases stay unambiguous. */
function buildOrderBy(spec: MetricsQuerySpec, outputColumns: string[]): string {
  if (!spec.orderBy?.length) return ''
  const terms = spec.orderBy.map(({ field, dir }) => {
    const position = outputColumns.indexOf(field)
    if (position === -1) throw new Error(`orderBy field ${field} is not an output column`)
    if (dir !== 'asc' && dir !== 'desc') throw new Error(`Invalid orderBy direction: ${dir}`)
    return `${position + 1} ${dir.toUpperCase()}`
  })
  return `ORDER BY ${terms.join(', ')}`
}

function compileListing(spec: MetricsQuerySpec, kind: SpanKind | undefined): CompiledQuery {
  const where = buildWhere(spec, kind)
  const orderBy = spec.orderBy?.length
    ? buildOrderBy(spec, LISTING_COLUMNS)
    : 'ORDER BY started_at DESC'
  const sql = [
    `SELECT ${LISTING_COLUMNS.join(', ')}`,
    'FROM spans',
    where.clause,
    orderBy,
    'LIMIT ?',
  ].filter(Boolean).join('\n')
  return { sql, params: [...where.params, clampLimit(spec.limit)] }
}

function compilePlainAggregation(
  spec: MetricsQuerySpec,
  groups: GroupItem[],
  aggregates: AggregateItem[],
  where: { clause: string; params: Array<string | number> },
): CompiledQuery {
  const selects = [
    ...groups.map((group) => `${group.expression} AS ${group.alias}`),
    ...aggregates.map((aggregate) => aggregate.expression === null
      ? `COUNT(*) AS ${aggregate.alias}`
      : `${PLAIN_AGGREGATES[aggregate.fn]}(${aggregate.expression}) AS ${aggregate.alias}`),
  ]
  const outputColumns = [...groups.map((g) => g.alias), ...aggregates.map((a) => a.alias)]
  const sql = [
    `SELECT ${selects.join(', ')}`,
    'FROM spans',
    where.clause,
    groups.length ? `GROUP BY ${groups.map((g) => g.expression).join(', ')}` : '',
    buildOrderBy(spec, outputColumns),
    'LIMIT ?',
  ].filter(Boolean).join('\n')
  return { sql, params: [...where.params, clampLimit(spec.limit)] }
}

function compileWithPercentiles(
  spec: MetricsQuerySpec,
  groups: GroupItem[],
  aggregates: AggregateItem[],
  where: { clause: string; params: Array<string | number> },
): CompiledQuery {
  const groupAliases = groups.map((g) => g.alias)
  const valueAlias = (index: number) => `__v${index}`

  const baseSelects = [
    ...groups.map((group) => `${group.expression} AS ${group.alias}`),
    ...aggregates.flatMap((aggregate, index) =>
      aggregate.expression === null ? [] : [`${aggregate.expression} AS ${valueAlias(index)}`]),
  ]
  const baseSql = [`SELECT ${baseSelects.join(', ')}`, 'FROM spans', where.clause].filter(Boolean).join('\n  ')

  const plain = aggregates
    .map((aggregate, index) => ({ aggregate, index }))
    .filter(({ aggregate }) => PLAIN_AGGREGATES[aggregate.fn] !== undefined)
  const percentiles = aggregates
    .map((aggregate, index) => ({ aggregate, index }))
    .filter(({ aggregate }) => PERCENTILES[aggregate.fn] !== undefined)

  const plainSelects = [
    ...groupAliases,
    ...plain.map(({ aggregate, index }) => aggregate.expression === null
      ? `COUNT(*) AS ${aggregate.alias}`
      : `${PLAIN_AGGREGATES[aggregate.fn]}(${valueAlias(index)}) AS ${aggregate.alias}`),
  ]
  // With nothing else to aggregate, a hidden count keeps one anchor row per group.
  if (plainSelects.length === groupAliases.length) plainSelects.push('COUNT(*) AS __n')
  const plainSql = [
    `SELECT ${plainSelects.join(', ')}`,
    'FROM __base',
    groupAliases.length ? `GROUP BY ${groupAliases.join(', ')}` : '',
  ].filter(Boolean).join('\n  ')

  const partition = groupAliases.length ? `PARTITION BY ${groupAliases.join(', ')} ` : ''
  const percentileCtes = percentiles.map(({ aggregate, index }, order) => {
    const value = valueAlias(index)
    const keep = [...groupAliases, `${value} AS ${aggregate.alias}`].join(', ')
    return `__pct${order} AS (\n  SELECT ${keep} FROM (\n    SELECT ${[...groupAliases, value].join(', ')},\n`
      + `           ROW_NUMBER() OVER (${partition}ORDER BY ${value}) AS __rn,\n`
      + `           COUNT(*) OVER (${partition.trim() || ''}) AS __cnt\n`
      + `    FROM __base WHERE ${value} IS NOT NULL\n  )\n`
      + `  WHERE __rn = MAX(1, CAST(__cnt * ${PERCENTILES[aggregate.fn]} + 0.5 AS INTEGER))\n)`
  })

  const finalSelects = [
    ...groupAliases.map((alias) => `__plain.${alias}`),
    ...aggregates.map((aggregate) => {
      const order = percentiles.findIndex((p) => p.aggregate === aggregate)
      return order === -1 ? `__plain.${aggregate.alias}` : `__pct${order}.${aggregate.alias}`
    }),
  ]
  const joins = percentiles.map((_, order) => groupAliases.length
    ? `LEFT JOIN __pct${order} ON ${groupAliases.map((alias) => `__plain.${alias} IS __pct${order}.${alias}`).join(' AND ')}`
    : `LEFT JOIN __pct${order} ON 1 = 1`)

  const outputColumns = [...groupAliases, ...aggregates.map((a) => a.alias)]
  const sql = [
    `WITH __base AS (\n  ${baseSql}\n),`,
    `__plain AS (\n  ${plainSql}\n)${percentileCtes.length ? ',' : ''}`,
    percentileCtes.join(',\n'),
    `SELECT ${finalSelects.join(', ')}`,
    'FROM __plain',
    joins.join('\n'),
    buildOrderBy(spec, outputColumns),
    'LIMIT ?',
  ].filter(Boolean).join('\n')
  return { sql, params: [...where.params, clampLimit(spec.limit)] }
}

export function compileQuerySpec(spec: MetricsQuerySpec): CompiledQuery {
  const kind = pinnedKind(spec.filters ?? [])
  const groups = groupItems(spec.groupBy ?? [], kind)
  const aggregates = aggregateItems(spec.aggregates ?? [], kind)
  assertUniqueAliases([...groups.map((g) => g.alias), ...aggregates.map((a) => a.alias)])

  const withGrain = (compiled: CompiledQuery): CompiledQuery =>
    kind === undefined ? compiled : { ...compiled, sourceView: viewNameForKind(kind) }

  if (aggregates.length === 0) {
    if (groups.length > 0) throw new Error('groupBy needs at least one aggregate')
    return withGrain(compileListing(spec, kind))
  }

  const where = buildWhere(spec, kind)
  const hasPercentile = aggregates.some((aggregate) => PERCENTILES[aggregate.fn] !== undefined)
  return withGrain(hasPercentile
    ? compileWithPercentiles(spec, groups, aggregates, where)
    : compilePlainAggregation(spec, groups, aggregates, where))
}
