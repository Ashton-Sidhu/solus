import type { MetricsNlCompileResult, MetricsSqlValidation } from '../../shared/observability-types'
import { schemaForPrompt } from './field-registry'

// ─── NL → SQL compile ───
//
// Compiles a user question to SQLite SQL over the generated views — an existing,
// deeply-trained language, never a bespoke grammar. Generation runs as an
// ephemeral agent (service solus.insights) supplied by the caller; this module
// owns the prompt, the fence stripping, and the execute-and-retry loop. The
// result lands in the SQL editor visible and editable — not behind a curtain.

const MAX_ATTEMPTS = 3

export const NL_COMPILE_SYSTEM_PROMPT = `You translate one question about Solus agent telemetry into exactly one SQLite query.

Rules:
- Return ONLY the SQL text. No prose, no explanation, no markdown fences.
- One statement, starting with SELECT or WITH. Never write, ATTACH, or PRAGMA.
- Query turns or events, not the raw spans table, whenever they have the field.
  turns already sums each child kind's time per turn (tool_time_ms,
  thinking_time_ms, …) — prefer those columns over joining events onto turns.
- started_at and ended_at are epoch milliseconds; duration columns are milliseconds.
- SQLite has no native percentile: for p95 use ROW_NUMBER() and COUNT() window
  functions ordered by the value, keeping the row where
  rn = MAX(1, CAST(cnt * 0.95 + 0.5 AS INTEGER)).
- Bucket time with strftime/date over started_at / 1000, 'unixepoch'.
- Prefer readable column aliases; keep results under a few hundred rows.
- When listing individual spans or tool calls (not aggregating), include
  span_id, trace_id, and started_at in the SELECT so each row can be opened
  in the UI.

Example — average turn duration by model over the last 7 days:
SELECT model, AVG(duration_ms) AS avg_duration_ms, COUNT(*) AS turns
FROM turns
WHERE started_at >= (strftime('%s', 'now') - 7 * 86400) * 1000
GROUP BY model
ORDER BY avg_duration_ms DESC

Example — daily p95 Bash duration for one command:
WITH ranked AS (
  SELECT date(started_at / 1000, 'unixepoch') AS day, duration_ms,
         ROW_NUMBER() OVER (PARTITION BY date(started_at / 1000, 'unixepoch') ORDER BY duration_ms) AS rn,
         COUNT(*) OVER (PARTITION BY date(started_at / 1000, 'unixepoch')) AS cnt
  FROM events
  WHERE tool = 'Bash' AND command = 'bun run build' AND duration_ms IS NOT NULL
)
SELECT day, duration_ms AS p95_duration_ms
FROM ranked
WHERE rn = MAX(1, CAST(cnt * 0.95 + 0.5 AS INTEGER))
ORDER BY day

Schema:
`

export interface NlCompileDeps {
  /** One ephemeral agent generation; receives the full prompt for the attempt. */
  generate(prompt: string): Promise<string>
  validate(sql: string): MetricsSqlValidation
}

/** Strips markdown fences and surrounding prose the model may still emit. */
export function extractSql(output: string): string {
  const fenced = output.match(/```(?:sql)?\s*\n([\s\S]*?)```/i)
  return (fenced ? fenced[1] : output).trim()
}

function attemptPrompt(question: string, previous?: { sql: string; error: string }): string {
  if (!previous) return question
  return `${question}\n\nYour previous attempt failed. Fix it and return only the corrected SQL.\n`
    + `Previous SQL:\n${previous.sql}\n\nSQLite error:\n${previous.error}`
}

export function nlCompileSystemPrompt(): string {
  return NL_COMPILE_SYSTEM_PROMPT + schemaForPrompt()
}

/** Generate → validate → on SQLite error, retry with the error text (bounded). */
export async function compileNlToSql(question: string, deps: NlCompileDeps): Promise<MetricsNlCompileResult> {
  let sql = ''
  let error = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const output = await deps.generate(attemptPrompt(question, sql ? { sql, error } : undefined))
    sql = extractSql(output)
    if (!sql) {
      error = 'The agent returned no SQL.'
      continue
    }
    const validation = deps.validate(sql)
    if (validation.ok) return { sql, ok: true, attempts: attempt }
    error = validation.error
  }
  return { sql, ok: false, error, attempts: MAX_ATTEMPTS }
}
