import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  snippetCompletion,
} from '@codemirror/autocomplete'
import { linter, type Diagnostic } from '@codemirror/lint'
import { syntaxTree } from '@codemirror/language'
import {
  schemaCompletionSource,
  SQLite,
  sql,
  type SQLNamespace,
} from '@codemirror/lang-sql'
import type { Extension } from '@codemirror/state'
import { hoverTooltip, type Tooltip } from '@codemirror/view'
import type {
  MetricsFieldDescriptor,
  MetricsSchema,
  MetricsSqlValidation,
  MetricsValue,
} from '@solus/contracts/observability-types'

// The SQL editor's language intelligence.
//
// There is no language server: completion, diagnostics, and hover are assembled
// from CodeMirror extensions over the field registry, and SQLite's own
// `prepare()` is the validator. Rename and go-to-definition are meaningless for
// a single statement over half a dozen views.
//
// Everything here is pure setup over injected callbacks — the schema cache and
// the distinct-value cache live in the insights store, so completion reads them
// synchronously and never issues an RPC per keystroke.

/** Columns the value-completion source will offer literals for. Matches the
 *  server's registered low-cardinality columns. */
const VALUE_COLUMNS = new Set(['tool', 'model', 'provider', 'status', 'service', 'kind', 'origin'])
const PRIMARY_TABLES = new Set(['turns', 'events'])

// The menu is one flat ranked list, as an IDE's is. Sections were tried and
// removed: CodeMirror adds -1e5 per section to every score, so a section's rank
// outweighs relevance completely — a weak column match in a `Columns` section
// renders above the exact keyword `from` in an `SQL` section. Rank is carried by
// `boost`, and identity by the row's icon.

export interface SqlEditorSources {
  /** The field registry, already fetched. Null until the first load resolves. */
  schema: () => MetricsSchema | null
  /** Cached distinct values for a registered column, or null if not cached yet.
   *  Returning null asks the editor to request them and re-run completion. */
  cachedValues: (column: string) => MetricsValue[] | null
  requestValues: (column: string) => void
  /** SQLite-authoritative validation. Debounced by the linter's own delay. */
  validate: (sql: string) => Promise<MetricsSqlValidation>
  /** Reported on every successful prepare so the console can preview columns. */
  onValidation?: (validation: MetricsSqlValidation) => void
}

type SchemaCompletionType =
  | 'table' | 'column' | 'primary-key' | 'foreign-key' | 'snippet' | 'value' | 'function'

/** A row in the menu: an icon for what the thing is, its name, the source it
 *  comes from in parentheses, and its type on the right — the layout every SQL
 *  IDE uses, because a name alone does not say which table it belongs to. */
export interface SchemaCompletion extends Completion {
  /** Rendered dim beside the label. The table(s) that own this column. */
  qualifier?: string
}

export interface SchemaCompletionResult extends CompletionResult {
  options: readonly SchemaCompletion[]
}

/** Reads the qualifier off a completion CodeMirror hands back as a plain
 *  `Completion`, without asserting a type onto it. */
function completionQualifier(completion: Completion): string | null {
  const candidate: Partial<SchemaCompletion> = completion
  return candidate.qualifier ?? null
}

function columnCompletionType(column: string, tables: string[]): SchemaCompletionType {
  if (
    (column === 'trace_id' && tables.includes('turns'))
    || (column === 'span_id' && tables.some((table) => table !== 'turns'))
  ) return 'primary-key'
  if (column === 'trace_id' || column === 'parent_span_id') return 'foreign-key'
  return 'column'
}

/** The right-hand column. The key roles the icons already carry are not
 *  repeated here; the data type is what the icon cannot say. */
function columnDetail(column: MetricsFieldDescriptor, type: SchemaCompletionType): string {
  if (type === 'primary-key') return `${column.type} · primary key`
  if (type === 'foreign-key') return `${column.type} · join key`
  return column.type
}

function columnCompletion(
  column: MetricsFieldDescriptor,
  tables: string[],
  boost: number,
): SchemaCompletion {
  const type = columnCompletionType(column.name, tables)
  return {
    label: column.name,
    type,
    qualifier: tables.join(', '),
    detail: columnDetail(column, type),
    info: column.description,
    boost,
  }
}

function completionsFor(columns: MetricsFieldDescriptor[], table: string): Completion[] {
  return columns.map((column) => columnCompletion(column, [table], PRIMARY_TABLES.has(table) ? 50 : -20))
}

export function schemaTableCompletions(schema: MetricsSchema): Completion[] {
  return schemaSources(schema).map((source) => {
    const isPrimary = PRIMARY_TABLES.has(source.name)
    return {
      label: source.name,
      type: 'table',
      detail: isPrimary ? 'primary' : source.name === schema.base.table ? 'raw facts' : 'advanced',
      info: source.description,
      boost: isPrimary ? 70 : -20,
    }
  })
}

function namespaceFor(schema: MetricsSchema): SQLNamespace {
  const namespace: Record<string, SQLNamespace> = {}
  const tables = new Map(schemaTableCompletions(schema).map((completion) => [completion.label, completion]))
  for (const view of schema.views) {
    namespace[view.view] = {
      self: tables.get(view.view)!,
      children: completionsFor(view.columns, view.view),
    }
  }
  // The fact table every view reads from, which a cross-kind query targets
  // directly. Its own registered columns, not a union of the views' — `kind`
  // and `attrs` exist only here.
  namespace[schema.base.table] = {
    self: tables.get(schema.base.table)!,
    children: completionsFor(schema.base.columns, schema.base.table),
  }
  return namespace
}

interface SchemaSource {
  name: string
  description: string
  columns: MetricsFieldDescriptor[]
}

function schemaSources(schema: MetricsSchema): SchemaSource[] {
  return [
    ...schema.views.map((view) => ({
      name: view.view,
      description: view.description,
      columns: view.columns,
    })),
    { name: schema.base.table, description: schema.base.description, columns: schema.base.columns },
  ]
}

function tablePosition(beforeWord: string): boolean {
  if (/\b(?:from|join)\s+$/i.test(beforeWord)) return true
  const from = beforeWord.toLowerCase().lastIndexOf(' from ')
  if (from === -1 || !/,\s*$/.test(beforeWord)) return false
  return !/\b(?:where|group\s+by|having|order\s+by|limit|union)\b/i.test(beforeWord.slice(from))
}

function referencedTables(text: string, sources: SchemaSource[]): SchemaSource[] {
  const byName = new Map(sources.map((source) => [source.name.toLowerCase(), source]))
  const found: SchemaSource[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    const name = match[1]?.toLowerCase()
    const source = name ? byName.get(name) : undefined
    if (!source || seen.has(source.name)) continue
    seen.add(source.name)
    found.push(source)
  }
  return found
}

/** Context-aware schema options for an unqualified identifier. CodeMirror's
 *  SQL source owns keywords and qualified `alias.column` completion; this
 *  source makes the common unqualified path useful before a FROM clause exists
 *  and narrows it to the tables already named after one does. */
export function schemaCompletionsAtCursor(
  text: string,
  cursor: number,
  schema: MetricsSchema,
): SchemaCompletionResult | null {
  const before = text.slice(0, cursor)
  const word = /[a-z_][a-z0-9_]*$/i.exec(before)
  const from = word ? cursor - word[0].length : cursor
  const beforeWord = before.slice(0, from)
  if (/\.\s*$/.test(beforeWord)) return null

  const sources = schemaSources(schema)
  // CodeMirror's schema source already knows that this is a table position.
  // Returning the same tables here would render every match twice.
  if (tablePosition(beforeWord)) return null

  const referenced = referencedTables(beforeWord, sources)
  const candidates = referenced.length > 0
    ? referenced
    : sources.filter((source) => PRIMARY_TABLES.has(source.name))
  const columns = new Map<string, { column: MetricsFieldDescriptor; tables: string[] }>()
  for (const source of candidates) {
    for (const column of source.columns) {
      const existing = columns.get(column.name)
      if (existing) existing.tables.push(source.name)
      else columns.set(column.name, { column, tables: [source.name] })
    }
  }
  return {
    from,
    options: [...columns.values()].map(({ column, tables }) => columnCompletion(column, tables, 90)),
    validFor: /^\w*$/,
  }
}

function schemaCompletions(sources: SqlEditorSources) {
  return (context: CompletionContext): CompletionResult | null => {
    const schema = sources.schema()
    if (!schema) return null
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    if (/String|Comment/.test(node.name)) return null
    const result = schemaCompletionsAtCursor(context.state.doc.toString(), context.pos, schema)
    if (!result || (result.from === context.pos && !context.explicit)) return null
    return result
  }
}

/** Time-bucket and percentile patterns that are tedious to type and easy to get
 *  subtly wrong — SQLite has no native percentile, so the window form is the
 *  house pattern. */
const SNIPPET_COMPLETIONS: Completion[] = [
  {
    label: 'bucket_hour',
    type: 'snippet',
    detail: 'pattern',
    info: 'Group by hour of started_at',
    apply: "strftime('%Y-%m-%d %H:00', started_at / 1000, 'unixepoch')",
  },
  {
    label: 'bucket_day',
    type: 'snippet',
    detail: 'pattern',
    info: 'Group by day of started_at',
    apply: "strftime('%Y-%m-%d', started_at / 1000, 'unixepoch')",
  },
  {
    label: 'last_24h',
    type: 'snippet',
    detail: 'pattern',
    info: 'Restrict to the last 24 hours',
    apply: "started_at > (strftime('%s','now') * 1000 - 86400000)",
  },
  {
    label: 'p95',
    type: 'snippet',
    detail: 'pattern',
    info: 'p95 of duration_ms via an ordered window',
    apply:
      'select duration_ms as p95 from (\n' +
      '  select duration_ms, ntile(20) over (order by duration_ms) as bucket\n' +
      '  from turns where duration_ms is not null\n' +
      ') where bucket = 20 limit 1',
  },
]

/** Which registered column a string literal is being compared against, if any.
 *  Matches `column = '…'`, `column in ('…'`, and `column like '…'`. */
export function valueColumnAtCursor(text: string): string | null {
  const match = /([a-z_][a-z0-9_]*)\s*(?:=|!=|<>|\bin\b\s*\(|\blike\b)\s*'[^']*$/i.exec(text)
  const column = match?.[1]?.toLowerCase()
  return column && VALUE_COLUMNS.has(column) ? column : null
}

function valueCompletions(sources: SqlEditorSources) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 200), context.pos)
    const column = valueColumnAtCursor(before)
    if (!column) return null
    const quote = before.lastIndexOf("'")
    if (quote === -1) return null
    const from = context.pos - (before.length - quote - 1)
    const values = sources.cachedValues(column)
    if (!values) {
      sources.requestValues(column)
      return null
    }
    return {
      from,
      options: values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => ({ label: value, type: 'value', detail: column })),
      validFor: /^[^']*$/,
    }
  }
}

function snippetCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\w+/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return { from: word.from, options: SNIPPET_COMPLETIONS, validFor: /^\w*$/ }
}

/** The SQL a person actually writes here.
 *
 *  The dialect's own keyword list is every SQLite reserved word, so typing
 *  `group` offered `current_default_transform_group` and never offered
 *  `group by` — a clause is two words and a reserved-word list holds one. This
 *  surface is a guarded read-only `select`, so the clauses it accepts are a
 *  short closed list, and writing them whole is the point. */
const CLAUSE_LABELS = [
  'select', 'select distinct', 'from', 'where', 'group by', 'order by', 'having',
  'limit', 'offset', 'join', 'left join', 'inner join', 'on', 'as', 'and', 'or',
  'not', 'in', 'not in', 'like', 'between', 'is null', 'is not null', 'case',
  'when', 'then', 'else', 'end', 'union', 'union all', 'with', 'distinct',
  'asc', 'desc', 'over', 'partition by',
]

/** `${…}` marks where the cursor lands, so a function arrives ready to fill in
 *  rather than needing the closing paren typed by hand. */
const FUNCTION_TEMPLATES: { template: string; label: string; detail: string }[] = [
  { template: 'count(*)', label: 'count(*)', detail: 'aggregate' },
  { template: 'count(${expr})', label: 'count()', detail: 'aggregate' },
  { template: 'sum(${expr})', label: 'sum()', detail: 'aggregate' },
  { template: 'avg(${expr})', label: 'avg()', detail: 'aggregate' },
  { template: 'min(${expr})', label: 'min()', detail: 'aggregate' },
  { template: 'max(${expr})', label: 'max()', detail: 'aggregate' },
  { template: 'group_concat(${expr})', label: 'group_concat()', detail: 'aggregate' },
  { template: 'round(${expr}, 2)', label: 'round()', detail: 'number' },
  { template: 'abs(${expr})', label: 'abs()', detail: 'number' },
  { template: 'cast(${expr} as ${integer})', label: 'cast()', detail: 'convert' },
  { template: 'coalesce(${a}, ${b})', label: 'coalesce()', detail: 'first non-null' },
  { template: 'nullif(${a}, ${b})', label: 'nullif()', detail: 'null when equal' },
  { template: 'iif(${condition}, ${a}, ${b})', label: 'iif()', detail: 'inline if' },
  { template: 'lower(${expr})', label: 'lower()', detail: 'text' },
  { template: 'upper(${expr})', label: 'upper()', detail: 'text' },
  { template: 'length(${expr})', label: 'length()', detail: 'text' },
  { template: "json_extract(attrs, '$.${key}')", label: 'json_extract()', detail: 'read attrs' },
  { template: "strftime('${%Y-%m-%d}', ${started_at} / 1000, 'unixepoch')", label: 'strftime()', detail: 'format epoch ms' },
]

export const SQL_COMPLETIONS: Completion[] = [
  ...CLAUSE_LABELS.map((label) => ({ label, type: 'keyword' })),
  ...FUNCTION_TEMPLATES.map(({ template, label, detail }) =>
    snippetCompletion(template, { label, detail, type: 'function' })),
]

/** Matches the word under the cursor and offers the whole list against it, so a
 *  two-word clause can complete from the first word alone. CodeMirror scores
 *  and highlights the rest: a prefix match costs 100, a scattered one about
 *  2000, which is why ranking never needed help from us. */
function sqlCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\w+$/)
  if (!word && !context.explicit) return null
  return { from: word ? word.from : context.pos, options: SQL_COMPLETIONS, validFor: /^\w*$/ }
}

// Regular-weight paths from the Phosphor icons used throughout Solus. These
// render into CodeMirror-owned DOM, where a Svelte icon component cannot mount
// without leaving a component lifecycle behind for every completion row.
const ICON_PATHS = {
  // Tag, not Columns, for a column: two vertical bars at 13px are
  // indistinguishable from a rendering fault, and a column is a named field of
  // a row rather than a picture of a column of values.
  table: 'M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM40,112H80v32H40Zm56,0H216v32H96ZM216,64V96H40V64ZM40,160H80v32H40Zm176,32H96V160H216v32Z',
  column: 'M243.31,136,144,36.69A15.86,15.86,0,0,0,132.69,32H40a8,8,0,0,0-8,8v92.69A15.86,15.86,0,0,0,36.69,144L136,243.31a16,16,0,0,0,22.63,0l84.68-84.68a16,16,0,0,0,0-22.63Zm-96,96L48,132.69V48h84.69L232,147.31ZM96,84A12,12,0,1,1,84,72,12,12,0,0,1,96,84Z',
  'primary-key': 'M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z',
  'foreign-key': 'M165.66,90.34a8,8,0,0,1,0,11.32l-64,64a8,8,0,0,1-11.32-11.32l64-64A8,8,0,0,1,165.66,90.34ZM215.6,40.4a56,56,0,0,0-79.2,0L106.34,70.45a8,8,0,0,0,11.32,11.32l30.06-30a40,40,0,0,1,56.57,56.56l-30.07,30.06a8,8,0,0,0,11.31,11.32L215.6,119.6a56,56,0,0,0,0-79.2ZM138.34,174.22l-30.06,30.06a40,40,0,1,1-56.56-56.57l30.05-30.05a8,8,0,0,0-11.32-11.32L40.4,136.4a56,56,0,0,0,79.2,79.2l30.06-30.07a8,8,0,0,0-11.32-11.31Z',
  snippet: 'M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29ZM162.73,32.48a8,8,0,0,0-10.25,4.79l-64,176a8,8,0,0,0,4.79,10.26A8.14,8.14,0,0,0,96,224a8,8,0,0,0,7.52-5.27l64-176A8,8,0,0,0,162.73,32.48Z',
  value: 'M100,56H40A16,16,0,0,0,24,72v64a16,16,0,0,0,16,16h60v8a32,32,0,0,1-32,32,8,8,0,0,0,0,16,48.05,48.05,0,0,0,48-48V72A16,16,0,0,0,100,56Zm0,80H40V72h60ZM216,56H156a16,16,0,0,0-16,16v64a16,16,0,0,0,16,16h60v8a32,32,0,0,1-32,32,8,8,0,0,0,0,16,48.05,48.05,0,0,0,48-48V72A16,16,0,0,0,216,56Zm0,80H156V72h60Z',
  function: 'M208,40a8,8,0,0,1-8,8H170.71a24,24,0,0,0-23.62,19.71L137.59,120H184a8,8,0,0,1,0,16H134.68l-10,55.16A40,40,0,0,1,85.29,224H56a8,8,0,0,1,0-16H85.29a24,24,0,0,0,23.62-19.71l9.5-52.29H72a8,8,0,0,1,0-16h49.32l10-55.16A40,40,0,0,1,170.71,32H200A8,8,0,0,1,208,40Z',
} satisfies Record<SchemaCompletionType, string>

function isSchemaCompletionType(value: string | undefined): value is SchemaCompletionType {
  return value === 'table' || value === 'column' || value === 'primary-key'
    || value === 'foreign-key' || value === 'snippet' || value === 'value'
    || value === 'function'
}

/** The leading glyph, in the tinted tile the command palette gives its rows —
 *  the same object, so a completion row reads as a Solus menu row. A clause has
 *  no glyph and gets an empty tile of the same size, which is how the palette
 *  keeps icon-less commands aligned. */
function completionIcon(completion: Completion): Node {
  const tile = document.createElement('span')
  tile.className = 'cm-insights-completion-tile'
  if (!isSchemaCompletionType(completion.type)) return tile
  const namespace = 'http://www.w3.org/2000/svg'
  const icon = document.createElementNS(namespace, 'svg')
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('class', 'cm-insights-completion-icon')
  icon.setAttribute('viewBox', '0 0 256 256')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('d', ICON_PATHS[completion.type])
  icon.append(path)
  tile.append(icon)
  tile.dataset.filled = ''
  return tile
}

/** The owning table, dim and in parentheses beside the name — a column name is
 *  ambiguous across `turns` and `events` without it. */
function completionSource(completion: Completion): Node | null {
  const qualifier = completionQualifier(completion)
  if (!qualifier) return null
  const span = document.createElement('span')
  span.className = 'cm-insights-completion-source'
  span.textContent = `(${qualifier})`
  return span
}

function sqlLinter(sources: SqlEditorSources) {
  return linter(
    async (view): Promise<Diagnostic[]> => {
      const text = view.state.doc.toString()
      if (!text.trim()) return []
      const validation = await sources.validate(text)
      sources.onValidation?.(validation)
      if (validation.ok) return []
      // The offset SQLite reports points at the offending token; without one the
      // whole statement is the only honest anchor.
      const from = validation.offset != null ? Math.min(validation.offset, text.length - 1) : 0
      const to = validation.offset != null ? Math.min(from + 1, text.length) : text.length
      return [
        {
          from,
          to,
          severity: 'error',
          message: validation.guardViolation ? `Not allowed here: ${validation.error}` : validation.error,
        },
      ]
    },
    { delay: 400 },
  )
}

function fieldDocs(schema: MetricsSchema | null, word: string): { view: string; detail: string } | null {
  if (!schema) return null
  // The fact table leads: `kind` and `attrs` resolve nowhere else, and hovering
  // `spans` should explain what it is rather than fall through to a view.
  const sources = [
    { name: schema.base.table, description: schema.base.description, columns: schema.base.columns },
    ...schema.views.map((view) => ({
      name: view.view,
      description: view.description,
      columns: view.columns,
    })),
  ]
  for (const source of sources) {
    if (source.name === word) return { view: source.name, detail: source.description }
    const column = source.columns.find((candidate) => candidate.name === word)
    if (column) return { view: source.name, detail: `${column.type} — ${column.description}` }
  }
  return null
}

function sqlHover(sources: SqlEditorSources) {
  return hoverTooltip((view, pos): Tooltip | null => {
    const { from, to, text } = view.state.doc.lineAt(pos)
    let start = pos
    let end = pos
    while (start > from && /[\w.]/.test(text[start - from - 1])) start -= 1
    while (end < to && /[\w.]/.test(text[end - from])) end += 1
    if (start === end) return null
    const word = text.slice(start - from, end - from).split('.').pop() ?? ''
    const docs = fieldDocs(sources.schema(), word)
    if (!docs) return null
    return {
      pos: start,
      end,
      above: true,
      create: () => {
        // Classed, not Tailwind-utility'd: this is CodeMirror-owned DOM, and
        // the editor's theme styles the whole tooltip family in one place.
        const dom = document.createElement('div')
        dom.className = 'cm-insights-hover'
        const name = document.createElement('div')
        name.className = 'cm-insights-hover-name'
        name.textContent = word
        const detail = document.createElement('div')
        detail.className = 'cm-insights-hover-detail'
        detail.textContent = docs.detail
        dom.append(name, detail)
        return { dom }
      },
    }
  })
}

/** Every language extension the SQL editor mounts, in one call. Rebuilt through
 *  a compartment when the schema arrives, so completion is never stale. */
export function sqlEditorExtensions(sources: SqlEditorSources): Extension[] {
  const schema = sources.schema()
  const support = sql({
    dialect: SQLite,
    upperCaseKeywords: false,
  })
  const completionSources: CompletionSource[] = [
    valueCompletions(sources),
    schemaCompletions(sources),
    ...(schema ? [schemaCompletionSource({ dialect: SQLite, schema: namespaceFor(schema) })] : []),
    snippetCompletions,
    sqlCompletions,
  ]
  return [
    support,
    autocompletion({
      icons: false,
      override: completionSources,
      // CodeMirror's own renderers sit at 50 (label) and 80 (detail), so the
      // icon leads and the owning table falls between the two.
      addToOptions: [
        { render: completionIcon, position: 20 },
        { render: completionSource, position: 60 },
      ],
    }),
    sqlLinter(sources),
    sqlHover(sources),
  ]
}
