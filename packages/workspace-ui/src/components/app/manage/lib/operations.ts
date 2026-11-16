import { z } from 'zod'
import { appOperationCallName, type AppJsonSchema, type AppSpan } from '@solus/contracts/apps'
import { appCallValue, type AppCallValue } from '@solus/client-core/app-calls'
import type { AppHostCall } from '@solus/client-core/app-files'
import type { DraftResult } from '../../../webhooks/lib/webhook-draft'

/** The Operations section (docs/plans/apps.md §9.2): the form that runs one operation with a JSON input. */

const inputSchema = z.record(z.string(), z.json())

/** The input a form sends, from what the person typed: a JSON object. Nothing typed is an empty object. */
export function operationInput(text: string): DraftResult<string> {
  if (!text.trim()) return { ok: true, value: '{}' }
  let parsed: AppCallValue
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `The input is not JSON: ${error instanceof Error ? error.message : 'it does not parse'}.` }
  }
  const input = inputSchema.safeParse(parsed)
  if (!input.success) return { ok: false, error: 'The input must be a JSON object.' }
  return { ok: true, value: JSON.stringify(input.data) }
}

/** Runs one operation as the UI does, and answers its value. The call is in the call log with the caller `ui`. */
export async function runOperation(call: AppHostCall, operation: string, inputJson: string): Promise<AppCallValue> {
  return appCallValue(await call(appOperationCallName(operation), inputJson))
}

/** A schema or a value as the page shows it. */
export function jsonText(value: AppJsonSchema | AppCallValue): string {
  return JSON.stringify(value, null, 2)
}

/** Whether a schema says something: a build writes `{}` for an operation that takes no input. */
export function hasSchema(schema: AppJsonSchema | undefined): schema is AppJsonSchema {
  return schema !== undefined && Object.keys(schema).length > 0
}

/** Whether text is longer than the four lines the instructions show closed, so the page offers to show it all. */
export function isLongText(text: string): boolean {
  return text.length > 280 || text.split('\n').length > 4
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`

/** A list as a sentence says it: "a, b, and c". */
function sentenceList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`
}

/** The host of a request span named `GET api.github.com/repos`: "api.github.com". */
function requestHost(name: string): string {
  const target = name.split(/\s+/).at(-1) ?? name
  return target.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] || target
}

/**
 * What a call waited for, in one line under its response: "2 SQL statements
 * and 1 request to api.github.com." The SQL of a call is one span that
 * counts its statements.
 */
export function spanSummary(spans: readonly AppSpan[]): string {
  const parts: string[] = []
  const sql = spans.filter((span) => span.kind === 'sql')
  if (sql.length > 0) {
    const statements = sql.reduce((sum, span) => sum + Number(/(\d+)\s+statement/i.exec(span.name)?.[1] ?? 1), 0)
    parts.push(plural(statements, 'SQL statement', 'SQL statements'))
  }
  const hosts = new Map<string, number>()
  for (const span of spans) if (span.kind === 'fetch') hosts.set(requestHost(span.name), (hosts.get(requestHost(span.name)) ?? 0) + 1)
  for (const [host, count] of hosts) parts.push(`${plural(count, 'request', 'requests')} to ${host}`)
  const counted: [AppSpan['kind'], string, string][] = [['tool', 'tool call', 'tool calls'], ['model', 'model call', 'model calls'], ['file', 'file operation', 'file operations'], ['signal', 'signal', 'signals']]
  for (const [kind, one, many] of counted) {
    const count = spans.filter((span) => span.kind === kind).length
    if (count > 0) parts.push(plural(count, one, many))
  }
  return parts.length === 0 ? 'The call waited for nothing outside its own code.' : `${sentenceList(parts)}.`
}

/** The operations of a version in their two groups: the reads, then the writes. */
export function operationGroups<Operation extends { kind: 'query' | 'mutation' }>(operations: readonly Operation[]): { label: string; operations: Operation[] }[] {
  return [
    { label: 'Reads', operations: operations.filter((operation) => operation.kind === 'query') },
    { label: 'Writes', operations: operations.filter((operation) => operation.kind === 'mutation') },
  ].filter((group) => group.operations.length > 0)
}
