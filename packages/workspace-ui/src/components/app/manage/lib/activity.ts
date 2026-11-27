import { z } from 'zod'
import type { AppCallDetail, AppCallKind, AppCallOutcome, AppCallQueryField, AppCallStats, AppCallTerm, AppCallView, AppCaller, AppSummary, AppWebhookView } from '@solus/contracts/apps'
import { appKey } from '../../../../contexts/apps/app-resource.svelte'
import type { AppCallQuery, AppCallStatsQuery } from '../../../../contexts/apps/apps.store.svelte'
import { formatDuration } from '../../../insights/lib/format'
import type { TrendPoint } from '../../../insights/lib/chart-shape'
import { axisInstantFormat, formatClock, formatDayClock } from '../../../insights/lib/format'
import type { TimeSelection } from '../../../insights/lib/volume'
import { callerText } from '../../lib/app-view'
import { callTermText, parseCallQuery } from './call-query'

/**
 * The Activity section (docs/plans/apps.md §9.2): the query of the call log,
 * its fields, its chart, and its event rows. One log holds the calls of
 * operations and the model calls. The host applies the query, so the query is
 * what the read asks for.
 */

/** Which rows the log shows: every call (''), only the calls of operations, or only the model calls. */
export type CallKind = AppCallKind | ''

export const CALL_KIND_CHOICES: { value: CallKind; label: string }[] = [
  { value: '', label: 'All calls' },
  { value: 'operation', label: 'Operation calls' },
  { value: 'model', label: 'Model calls' },
]

/** How far back the log looks. */
export type CallRange = 'hour' | 'day' | 'week' | 'all'

const HOUR_MS = 60 * 60 * 1000
const RANGE_MS = { hour: HOUR_MS, day: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS, all: null } satisfies { [Range in CallRange]: number | null }

export const CALL_RANGE_CHOICES: { value: CallRange; label: string }[] = [
  { value: 'hour', label: 'Last hour' },
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'all', label: 'All calls' },
]

/** The time a range starts; undefined for every call the host keeps. */
export function callRangeSince(range: CallRange, now: number): number | undefined {
  const span = RANGE_MS[range]
  return span === null ? undefined : now - span
}

/** The heading of the chart for a range. */
export function callRangeTitle(range: CallRange): string {
  switch (range) {
    case 'hour': return 'Calls in the last hour'
    case 'day': return 'Calls over the last 24 hours'
    case 'week': return 'Calls over the last 7 days'
    case 'all': return 'Every call the host keeps'
  }
}

/** The time a zoom covers, as the chart's heading names it: "14:00–16:30", with the day when it is not today or spans more than one. */
export function callZoomText(zoom: TimeSelection, now: number = Date.now()): string {
  const format = zoom.to - zoom.from > 24 * HOUR_MS || new Date(zoom.from).toDateString() !== new Date(now).toDateString() ? formatDayClock : formatClock
  return `${format(zoom.from)}–${format(zoom.to)}`
}

/**
 * What the person asked the log for. `text` is the query as typed; a chip is
 * one more term that must match. `zoom` is the time a drag across the chart
 * narrowed the range to; another range clears it.
 */
export interface ActivityView {
  kind: CallKind
  text: string
  chips: AppCallTerm[]
  outcome: AppCallOutcome | ''
  range: CallRange
  zoom: TimeSelection | null
}

export const NEW_ACTIVITY_VIEW: ActivityView = { kind: '', text: '', chips: [], outcome: '', range: 'day', zoom: null }

/** The calls a view reads first, and with "Show more": the most the host gives in one read. */
export const CALL_FIRST_PAGE = 100
export const CALL_FULL_PAGE = 500

/** What the chart asks the host for: every filter of the view. A chip and the outcome are groups of one term each. */
export function callStatsQuery(view: ActivityView, now: number): AppCallStatsQuery {
  const match = [...parseCallQuery(view.text).groups, ...view.chips.map((chip) => [chip])]
  if (view.outcome) match.push([{ field: 'outcome', value: view.outcome }])
  const query: AppCallStatsQuery = {}
  if (view.kind) query.kind = view.kind
  if (view.zoom) {
    query.since = view.zoom.from
    query.until = view.zoom.to
  } else {
    const since = callRangeSince(view.range, now)
    if (since !== undefined) query.since = since
  }
  if (match.length > 0) query.match = match
  return query
}

/** What the rows ask the host for: the chart's filters, and how many rows. */
export function callQuery(view: ActivityView, now: number, limit: number = CALL_FIRST_PAGE): AppCallQuery {
  return { ...callStatsQuery(view, now), limit }
}

/** Whether the view narrows the log at all, beyond its range. */
export function isActivityFiltered(view: ActivityView): boolean {
  return view.text.trim() !== '' || view.chips.length > 0 || view.outcome !== '' || view.kind !== ''
}

/** How many filters of the Filters menu narrow the log: its count. */
export function activityFilterCount(view: Pick<ActivityView, 'kind' | 'outcome'>): number {
  return (view.kind ? 1 : 0) + (view.outcome ? 1 : 0)
}

/** A view adds a chip once: the same term twice narrows nothing. The term turned over takes the place of the term. */
export function withChip(chips: readonly AppCallTerm[], term: AppCallTerm): AppCallTerm[] {
  const others = chips.filter((chip) => chip.field !== term.field || chip.value !== term.value)
  return [...others, term]
}

/** The saved views the bar offers with one press: a query, an order, or a kind of call. */
export type QuickQuery = { label: string } & ({ text: string } | { order: CallOrder } | { kind: AppCallKind })

export const QUICK_QUERIES: QuickQuery[] = [
  { label: 'Failed calls', text: 'outcome:failed' },
  { label: 'Slowest operations', order: 'slowest' },
  { label: 'Agent calls', text: 'caller:agent' },
  { label: 'Model calls', kind: 'model' },
]

// A view that opens again starts from the query it left.
const rememberedViews = new Map<string, ActivityView>()

/**
 * The view the section opens on. Another section opens it on a filter by
 * reading the log with that filter first (the Overview's failed calls, the
 * calls of one operation). Those reads name their filters as fields; this
 * section's own read names them as a query (`match`).
 */
export function activityViewOf(serverId: string, appId: string, lastQuery: AppCallQuery): ActivityView {
  if (lastQuery.operation || lastQuery.outcome || lastQuery.callerKind || lastQuery.search) {
    const chips: AppCallTerm[] = []
    if (lastQuery.operation) chips.push({ field: 'operation', value: lastQuery.operation })
    if (lastQuery.callerKind) chips.push({ field: 'caller', value: lastQuery.callerKind })
    return { ...NEW_ACTIVITY_VIEW, range: 'all', chips, outcome: lastQuery.outcome ?? '', text: lastQuery.search ? callTermText({ field: 'text', value: lastQuery.search }) : '' }
  }
  return structuredClone(rememberedViews.get(appKey(serverId, appId)) ?? NEW_ACTIVITY_VIEW)
}

export function rememberActivityView(serverId: string, appId: string, view: ActivityView): void {
  rememberedViews.set(appKey(serverId, appId), structuredClone(view))
}

export const OUTCOME_CHOICES: { value: AppCallOutcome | ''; label: string }[] = [
  { value: '', label: 'All outcomes' },
  { value: 'ok', label: 'OK' },
  { value: 'failed', label: 'Failed' },
  { value: 'running', label: 'Running' },
]

/** Whether the host can hold more calls than the view read: the read came back full, and a larger read exists. */
export function canShowMoreCalls(calls: readonly AppCallView[], limit: number): boolean {
  return calls.length >= limit && limit < CALL_FULL_PAGE
}

/** How long a call took; "Running" while it has no end. */
export function callDurationText(call: Pick<AppCallView, 'durationMs' | 'outcome'>): string {
  return call.durationMs === null ? (call.outcome === 'running' ? 'Running' : '—') : formatDuration(call.durationMs)
}

/** The input as the detail shows it: indented when it is whole JSON, as the host kept it when it was cut. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** The order of the list. The host gives the newest first. */
export type CallOrder = 'newest' | 'oldest' | 'slowest'

export const CALL_ORDER_OPTIONS: { value: CallOrder; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'slowest', label: 'Slowest' },
]

/** The calls in the order the person chose. `calls` is the newest first. A call that still runs has no time, so it goes after the slowest ones. */
export function orderedCalls(calls: readonly AppCallView[], order: CallOrder): readonly AppCallView[] {
  if (order === 'newest') return calls
  if (order === 'oldest') return calls.toReversed()
  return calls.toSorted((left, right) => (right.durationMs ?? -1) - (left.durationMs ?? -1))
}

/** The rows the list draws first, and adds with each "Show more". */
export const CALL_LIST_STEP = 50

/** What the list says of its rows: how many, and how many failed. */
export function callsSummary(calls: readonly Pick<AppCallView, 'outcome'>[], limit: number): string {
  const count = calls.length.toLocaleString()
  const failed = calls.filter((call) => call.outcome === 'failed').length
  const head = calls.length >= limit ? `The newest ${count} calls` : `${count} ${calls.length === 1 ? 'call' : 'calls'}`
  return failed > 0 ? `${head} · ${failed.toLocaleString()} failed` : head
}

// ─── The trend ───

/**
 * The calls in view as points of the Insights trend chart: when each started
 * and how long it took. A call that still runs has no time yet, so it has no
 * point. A point carries the call's span id, and the chart hands it back on
 * a click.
 */
export function callTrendPoints(calls: readonly AppCallView[]): TrendPoint[] {
  return calls.flatMap((call) =>
    call.durationMs === null ? [] : [{ at: call.startedAt, value: call.durationMs, failed: call.outcome === 'failed', series: '', traceId: call.traceId, spanId: call.spanId ?? call.id }],
  )
}

/** The call a point of the trend stands for. */
export function callAtPoint(calls: readonly AppCallView[], point: Pick<TrendPoint, 'spanId'>): AppCallView | undefined {
  return calls.find((call) => (call.spanId ?? call.id) === point.spanId)
}

// ─── The rows ───

const two = (value: number) => String(value).padStart(2, '0')

/** When a call started, to the second: "14:02:31". The day comes first when the log spans more than one. */
export function callClockText(at: number, withDay: boolean): string {
  const date = new Date(at)
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  return withDay ? `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clock}` : clock
}

/** The milliseconds after the second, which two calls in one second differ by: ".048". */
export function callMillisText(at: number): string {
  return `.${String(new Date(at).getMilliseconds()).padStart(3, '0')}`
}

// ─── One call ───

const inputObjectSchema = z.record(z.string(), z.json())
const scalarSchema = z.union([z.string(), z.number(), z.boolean()])

/** A call's input as fields, `input.repo`, when it is a JSON object: the facts a reader filters by. Nested values stay in the Input tab. */
export function inputFacts(input: string | null, inputTruncated: boolean): { key: string; value: string }[] {
  if (input === null || inputTruncated) return []
  let parsed: ReturnType<typeof inputObjectSchema.safeParse>
  try {
    parsed = inputObjectSchema.safeParse(JSON.parse(input))
  } catch {
    return []
  }
  if (!parsed.success) return []
  return Object.entries(parsed.data).flatMap(([key, value]) => {
    const scalar = scalarSchema.safeParse(value)
    return scalar.success ? [{ key: `input.${key}`, value: String(scalar.data) }] : []
  })
}

/** What "Ask an agent to fix" names of a call: a row of the log has all of it but the stack. */
export type CallFixFacts = Pick<AppCallDetail, 'id' | 'operation' | 'version' | 'error'> & { errorStack?: string | null }

/** The prompt of "Ask an agent to fix": a new chat that names the call, so the agent reads it with inspect_app. */
export function callFixPrompt(app: Pick<AppSummary, 'name' | 'slug'>, call: CallFixFacts): string {
  const lines = [
    `The call ${call.id} of the operation ${call.operation} in the app ${app.name} (${app.slug}) failed on version ${call.version}.`,
    '',
    `Error: ${call.error ?? 'none recorded'}`,
  ]
  if (call.errorStack) lines.push('', 'Stack:', call.errorStack)
  lines.push('', 'Read the call with inspect_app, find the cause, and fix the app with checkout_app, save_app, and deploy_app.')
  return lines.join('\n')
}

// ─── The fields ───

/** A field the Fields list names. A field with a query field can filter the log; duration only shows its spread. */
export type CallFieldName = 'operation' | 'caller' | 'outcome' | 'version' | 'run' | 'error' | 'duration'

export interface CallField {
  name: CallFieldName
  /** `#` for a number, `t` for text: what kind of value it holds. */
  type: 'text' | 'number'
  queryField: AppCallQueryField | null
}

export const CALL_FIELDS: CallField[] = [
  { name: 'operation', type: 'text', queryField: 'operation' },
  { name: 'caller', type: 'text', queryField: 'caller' },
  { name: 'run', type: 'text', queryField: 'run' },
  { name: 'duration', type: 'number', queryField: null },
  { name: 'outcome', type: 'text', queryField: 'outcome' },
  { name: 'version', type: 'number', queryField: 'version' },
  { name: 'error', type: 'text', queryField: 'error' },
]

/** One value of a field, with its share of the calls in view. */
export interface FieldValue {
  value: string
  count: number
  share: number
}

const DURATION_RANGES: { label: string; below: number }[] = [
  { label: 'under 100 ms', below: 100 },
  { label: '100 ms – 1 s', below: 1000 },
  { label: '1 – 10 s', below: 10_000 },
  { label: '10 s or more', below: Infinity },
]

/** What a call holds in a field; null when it holds nothing there. */
export function callFieldValue(call: AppCallView, field: CallFieldName): string | null {
  switch (field) {
    case 'operation': return call.operation
    case 'caller': return call.caller.kind
    case 'outcome': return call.outcome
    case 'version': return String(call.version)
    case 'run': return call.caller.kind === 'workflow' ? call.caller.runId : null
    case 'error': return call.error
    case 'duration': {
      const durationMs = call.durationMs
      return durationMs === null ? null : DURATION_RANGES.find((range) => durationMs < range.below)?.label ?? null
    }
  }
}

/** The most common values of a field in the calls in view, the most first. A share is of every call in view. */
export function fieldValues(calls: readonly AppCallView[], field: CallFieldName, count = 5): FieldValue[] {
  const counts = new Map<string, number>()
  for (const call of calls) {
    const value = callFieldValue(call, field)
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  const values = [...counts].map(([value, found]) => ({ value, count: found, share: calls.length === 0 ? 0 : found / calls.length }))
  // The ranges of a duration keep their order: their spread is the point.
  if (field === 'duration') return DURATION_RANGES.flatMap((range) => values.filter((value) => value.value === range.label))
  return values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, count)
}

/** A share as the Fields list writes it: "98%", "<1%". */
export function shareText(share: number): string {
  if (share > 0 && share < 0.01) return '<1%'
  return `${Math.round(share * 100)}%`
}

// ─── The documents ───

/** The fields a row shows as chips under its document, in this order. The Fields list adds and removes them. */
export const DEFAULT_CALL_COLUMNS: CallFieldName[] = ['caller', 'duration', 'run', 'version']

const CALLER_KIND_LABELS = {
  ui: 'UI',
  agent: 'Agent',
  schedule: 'Schedule',
  webhook: 'Webhook',
  workflow: 'Workflow',
  model: 'Model call',
} satisfies { [Kind in AppCaller['kind']]: string }

/** The kind of a caller as one word: "Workflow", "Schedule". */
export function callerKindLabel(caller: Pick<AppCaller, 'kind'>): string {
  return CALLER_KIND_LABELS[caller.kind]
}

/** What a row shows for a field in its chips; null when the call holds nothing there. */
export function callChipText(call: AppCallView, field: CallFieldName): string | null {
  switch (field) {
    case 'caller': return callerKindLabel(call.caller)
    case 'duration': return call.durationMs === null ? null : formatDuration(call.durationMs)
    case 'run': return call.caller.kind === 'workflow' ? call.caller.runId : null
    default: return callFieldValue(call, field)
  }
}

/**
 * The message of a row, after its operation: the error of a failed call, the
 * operation a model call worked for, or what the call left to read. Null when
 * there is nothing to say.
 */
export function callMessage(call: Pick<AppCallView, 'kind' | 'error' | 'caller' | 'logCount' | 'spanCount'>): string | null {
  if (call.error) return call.error
  if (call.kind === 'model') return call.caller.kind === 'workflow' ? `model call in ${call.caller.workflow}` : 'model call'
  const parts: string[] = []
  if (call.logCount > 0) parts.push(call.logCount === 1 ? '1 log line' : `${call.logCount.toLocaleString()} log lines`)
  if (call.spanCount > 0) parts.push(call.spanCount === 1 ? '1 span' : `${call.spanCount.toLocaleString()} spans`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The run a step's call belongs to and its step, "run_8f2c · ask-model"; null for a call outside a run. */
export function callRunText(call: Pick<AppCallView, 'caller'>): string | null {
  if (call.caller.kind !== 'workflow') return null
  return call.caller.step ? `${call.caller.runId} · ${call.caller.step}` : call.caller.runId
}

/** The calls of one run, or the calls outside every run. */
export interface CallRunGroup {
  runId: string | null
  workflow: string | null
  calls: AppCallView[]
}

/** The rows grouped by their run, in the order the rows came: a group goes where its first row went. */
export function callRunGroups(calls: readonly AppCallView[]): CallRunGroup[] {
  const groups = new Map<string | null, CallRunGroup>()
  for (const call of calls) {
    const runId = call.caller.kind === 'workflow' ? call.caller.runId : null
    let group = groups.get(runId)
    if (!group) {
      group = { runId, workflow: call.caller.kind === 'workflow' ? call.caller.workflow : null, calls: [] }
      groups.set(runId, group)
    }
    group.calls.push(call)
  }
  return [...groups.values()]
}

/** The rows in view that hold the text, in any case, in what a row shows. The host never sees this filter. */
export function callsInViewMatching(calls: readonly AppCallView[], text: string, webhooks: readonly AppWebhookView[]): readonly AppCallView[] {
  const needle = text.trim().toLowerCase()
  if (!needle) return calls
  return calls.filter((call) => [call.operation, callerText(call.caller, webhooks), callRunText(call) ?? '', call.error ?? ''].some((value) => value.toLowerCase().includes(needle)))
}

// ─── The chart ───

/** One bar of the Activity chart: the calls that started in its time, the failed ones on top. */
export interface CallBar {
  at: number
  total: number
  ok: number
  failed: number
}

/** The bars of the chart, from the host's numbers. */
export function callBars(stats: Pick<AppCallStats, 'buckets'>): CallBar[] {
  return stats.buckets.map((bucket) => ({ at: bucket.start, total: bucket.calls, ok: bucket.calls - bucket.failed, failed: bucket.failed }))
}

/** How the time axis names a bar's start: a clock within a day, the day and clock over a few days, else the day. */
export function callTickFormat(stats: Pick<AppCallStats, 'since' | 'until'>): (at: number) => string {
  return axisInstantFormat(stats.until - stats.since)
}

/** The time one bar covers, for its tooltip. */
export function bucketRangeLabel(start: number, bucketMs: number): string {
  const withDay = bucketMs >= 6 * HOUR_MS
  const format = (at: number) =>
    withDay ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' }) : new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${format(start)} – ${format(start + bucketMs)}`
}

/** What a bar says on hover after its time: its calls, and how many failed. */
export function callBarText(bar: Pick<CallBar, 'total' | 'failed'>): string {
  const calls = bar.total === 1 ? '1 call' : `${bar.total.toLocaleString()} calls`
  return `${calls}${bar.failed > 0 ? `, ${bar.failed.toLocaleString()} failed` : ''}`
}
