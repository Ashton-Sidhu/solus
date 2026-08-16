import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { linter, type Diagnostic } from '@codemirror/lint'
import { SQLite, sql, type SQLNamespace } from '@codemirror/lang-sql'
import type { Extension } from '@codemirror/state'
import { hoverTooltip, type Tooltip } from '@codemirror/view'
import type {
  MetricsSchema,
  MetricsSqlValidation,
  MetricsValue,
  MetricsViewDescriptor,
} from '../../../../shared/observability-types'

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

function namespaceFor(views: MetricsViewDescriptor[]): SQLNamespace {
  const namespace: Record<string, Completion[]> = {}
  for (const view of views) {
    namespace[view.view] = view.columns.map((column) => ({
      label: column.name,
      type: column.type === 'number' || column.type === 'duration' ? 'property' : 'variable',
      detail: column.type,
      info: column.description,
    }))
  }
  // `spans` is the fact table every view reads from, and a hand-written query
  // may target it directly for cross-kind rollups.
  namespace.spans = [...new Set(views.flatMap((view) => view.columns.map((column) => column.name)))]
    .map((name) => ({ label: name, type: 'variable' }))
  return namespace
}

/** Time-bucket and percentile patterns that are tedious to type and easy to get
 *  subtly wrong — SQLite has no native percentile, so the window form is the
 *  house pattern. */
const SNIPPET_COMPLETIONS: Completion[] = [
  {
    label: 'bucket_hour',
    type: 'text',
    detail: 'snippet',
    info: 'Group by hour of started_at',
    apply: "strftime('%Y-%m-%d %H:00', started_at / 1000, 'unixepoch')",
  },
  {
    label: 'bucket_day',
    type: 'text',
    detail: 'snippet',
    info: 'Group by day of started_at',
    apply: "strftime('%Y-%m-%d', started_at / 1000, 'unixepoch')",
  },
  {
    label: 'last_24h',
    type: 'text',
    detail: 'snippet',
    info: 'Restrict to the last 24 hours',
    apply: "started_at > (strftime('%s','now') * 1000 - 86400000)",
  },
  {
    label: 'p95',
    type: 'text',
    detail: 'snippet',
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
        .map((value) => ({ label: value, type: 'constant' })),
      validFor: /^[^']*$/,
    }
  }
}

function snippetCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\w+/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return { from: word.from, options: SNIPPET_COMPLETIONS, validFor: /^\w*$/ }
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
  for (const view of schema.views) {
    if (view.view === word) return { view: view.view, detail: view.description }
    const column = view.columns.find((candidate) => candidate.name === word)
    if (column) return { view: view.view, detail: `${column.type} — ${column.description}` }
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
        const dom = document.createElement('div')
        dom.className = 'px-2 py-1.5 text-xs leading-relaxed max-w-80'
        const name = document.createElement('div')
        name.className = 'font-medium'
        name.textContent = word
        const detail = document.createElement('div')
        detail.className = 'text-(--solus-text-tertiary)'
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
    schema: schema ? namespaceFor(schema.views) : undefined,
    upperCaseKeywords: false,
  })
  return [
    support,
    // Registered as language data rather than through `override`, which would
    // replace the dialect's own schema and keyword sources instead of joining
    // them.
    support.language.data.of({ autocomplete: valueCompletions(sources) }),
    support.language.data.of({ autocomplete: snippetCompletions }),
    autocompletion(),
    sqlLinter(sources),
    sqlHover(sources),
  ]
}
