import type { AppCallDetail, AppCallTerm, AppCallView, AppWebhookView } from '@solus/contracts/apps'
import type { AppModelCallView } from '@solus/contracts/app-models'
import { formatFileSize } from '../../../files/lib/non-text-file'
import { formatDuration } from '../../../insights/lib/format'
import { callerText } from '../../lib/app-view'
import { callClockText, callDurationText, callMillisText, callerKindLabel, inputFacts, type CallFieldName } from './activity'
import { modelCallDuration } from './model-calls'

/**
 * The call sheet of the Activity section (docs/plans/apps.md §9.2): one call
 * over the page, read as a log document. Its key facts, its fields in
 * groups, its JSON, its trace, and the calls around it. Pure, so the facts a
 * reader filters by are tested.
 */

export const CALL_SHEET_TABS = ['fields', 'json', 'trace', 'around'] as const
export type CallSheetTab = (typeof CALL_SHEET_TABS)[number]

export const CALL_SHEET_TAB_LABELS = {
  fields: 'Fields',
  json: 'JSON',
  trace: 'Trace',
  around: 'Around this call',
} satisfies { [Tab in CallSheetTab]: string }

/** When a call started, to the millisecond: "Nov 27, 14:02:11.482", or with the year: "Nov 27, 2026 14:02:11.482". */
export function callStampText(at: number, withYear = false): string {
  const day = new Date(at).toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' })
  return `${day}${withYear ? ' ' : ', '}${callClockText(at, false)}${callMillisText(at)}`
}

/** The line under the call's name: how it ended and when it started. "Failed after 30.0 s · Nov 27, 14:02:11.482". */
export function callSheetSummary(call: Pick<AppCallView, 'outcome' | 'durationMs' | 'startedAt'>): string {
  const duration = call.durationMs === null ? null : formatDuration(call.durationMs)
  const ending = call.outcome === 'running' ? 'Running' : call.outcome === 'failed' ? (duration ? `Failed after ${duration}` : 'Failed') : duration ? `Took ${duration}` : 'Ended'
  return `${ending} · ${callStampText(call.startedAt)}`
}

/** One key fact of the call, over the sheet's fields: a label, the value, and a quiet line under it. */
export interface CallSheetFact {
  label: string
  value: string
  detail: string | null
  mono: boolean
}

function callerDetail(call: Pick<AppCallView, 'caller'>, webhooks: readonly AppWebhookView[]): string | null {
  const caller = call.caller
  switch (caller.kind) {
    case 'schedule': return caller.name
    case 'webhook': return webhooks.find((webhook) => webhook.webhookId === caller.webhookId)?.name ?? null
    case 'workflow': return caller.workflow
    default: return null
  }
}

/**
 * The key facts of a call: who called it, its run, how long it took against
 * the p95 of the calls in the query, and its version. `liveVersion` is the
 * version that runs now.
 */
export function callSheetFacts(call: AppCallView, p95Ms: number | null, liveVersion: number | null, webhooks: readonly AppWebhookView[]): CallSheetFact[] {
  const facts: CallSheetFact[] = [{ label: 'Caller', value: callerKindLabel(call.caller), detail: callerDetail(call, webhooks), mono: false }]
  if (call.caller.kind === 'workflow') facts.push({ label: 'Run', value: call.caller.runId, detail: call.caller.step ? `step ${call.caller.step}` : null, mono: true })
  facts.push({ label: 'Duration', value: callDurationText(call), detail: p95Ms === null ? null : `p95 is ${formatDuration(p95Ms)}`, mono: false })
  facts.push({ label: 'Version', value: String(call.version), detail: call.version === liveVersion ? 'live' : null, mono: false })
  return facts
}

/**
 * One field of the call. `term` is what "filter for" and "filter out" add to
 * the query; `column` is the field a row can show as a chip. Null where the
 * field can do neither.
 */
export interface CallSheetField {
  key: string
  value: string
  copyValue: string
  mono: boolean
  term: AppCallTerm | null
  column: CallFieldName | null
}

export interface CallSheetFieldGroup {
  label: string
  fields: CallSheetField[]
}

function field(key: string, value: string, extra: Partial<CallSheetField> = {}): CallSheetField {
  return { key, value, copyValue: value, mono: false, term: null, column: null, ...extra }
}

/** The fields of a call of an operation: the call, then its input when it is a JSON object. */
export function callFieldGroups(detail: AppCallDetail, webhooks: readonly AppWebhookView[]): CallSheetFieldGroup[] {
  const call: CallSheetField[] = [
    field('@timestamp', callStampText(detail.startedAt, true), { copyValue: new Date(detail.startedAt).toISOString() }),
    field('operation', detail.operation, { term: { field: 'operation', value: detail.operation } }),
    field('outcome', detail.outcome, { term: { field: 'outcome', value: detail.outcome }, column: 'outcome' }),
    field('caller', callerText(detail.caller, webhooks), { term: { field: 'caller', value: detail.caller.kind }, column: 'caller' }),
    field('duration', callDurationText(detail), { copyValue: detail.durationMs === null ? '' : String(detail.durationMs), column: 'duration' }),
    field('version', String(detail.version), { term: { field: 'version', value: String(detail.version) }, column: 'version' }),
  ]
  if (detail.runId) call.push(field('run', detail.runId, { mono: true, term: { field: 'run', value: detail.runId }, column: 'run' }))
  if (detail.resultBytes !== null) call.push(field('result.size', formatFileSize(detail.resultBytes), { copyValue: String(detail.resultBytes) }))
  // The OpenTelemetry trace id: the key of this call in Insights and at a collector.
  if (detail.traceId) call.push(field('trace.id', detail.traceId, { mono: true }))
  call.push(field('call.id', detail.id, { mono: true }))
  const groups: CallSheetFieldGroup[] = [{ label: 'Call', fields: call }]
  // An input value is found as text: the host keeps the input as JSON, so a term of a key is the nearest it can ask.
  const input = inputFacts(detail.input, detail.inputTruncated).map((fact) => field(fact.key, fact.value, { term: { field: 'text', value: fact.value } }))
  if (input.length > 0) groups.push({ label: 'Input', fields: input })
  return groups
}

/** The fields of a model call. `row` is its row in the log, which has its version and how it ended. */
export function modelCallFieldGroups(call: AppModelCallView, row: AppCallView | null, webhooks: readonly AppWebhookView[]): CallSheetFieldGroup[] {
  const fields: CallSheetField[] = [
    field('@timestamp', callStampText(call.createdAt, true), { copyValue: new Date(call.createdAt).toISOString() }),
    field('model.setting', call.setting, { term: { field: 'operation', value: call.setting } }),
    field('model', call.model ?? 'Not chosen yet', { copyValue: call.model ?? '' }),
  ]
  if (call.provider) fields.push(field('model.provider', call.provider))
  fields.push(field('model.effort', call.effort))
  if (row) fields.push(field('outcome', row.outcome, { term: { field: 'outcome', value: row.outcome }, column: 'outcome' }))
  fields.push(field('caller', callerText(call.caller, webhooks), { term: { field: 'caller', value: call.caller.kind }, column: 'caller' }))
  fields.push(field('duration', modelCallDuration(call, call.endedAt ?? Date.now()), { column: 'duration' }))
  if (row) fields.push(field('version', String(row.version), { term: { field: 'version', value: String(row.version) }, column: 'version' }))
  if (call.caller.kind === 'workflow') fields.push(field('run', call.caller.runId, { mono: true, term: { field: 'run', value: call.caller.runId }, column: 'run' }))
  fields.push(field('call.id', call.id, { mono: true }))
  const groups: CallSheetFieldGroup[] = [{ label: 'Model call', fields }]
  const usage = call.usage
  if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    groups.push({
      label: 'Usage',
      fields: [field('tokens.in', (usage.inputTokens ?? 0).toLocaleString(), { copyValue: String(usage.inputTokens ?? 0) }), field('tokens.out', (usage.outputTokens ?? 0).toLocaleString(), { copyValue: String(usage.outputTokens ?? 0) })],
    })
  }
  return groups
}

/** The groups with the fields whose key or value holds the text, in any case. A group with none goes. */
export function fieldGroupsMatching(groups: readonly CallSheetFieldGroup[], text: string): CallSheetFieldGroup[] {
  const needle = text.trim().toLowerCase()
  if (!needle) return [...groups]
  return groups.flatMap((group) => {
    const fields = group.fields.filter((entry) => entry.key.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle))
    return fields.length > 0 ? [{ label: group.label, fields }] : []
  })
}

/** The call as JSON, as the JSON tab shows it and Copy as JSON gives it: the input as data when it is whole JSON. */
export function callJsonText(detail: AppCallDetail): string {
  if (detail.input === null || detail.inputTruncated) return JSON.stringify(detail, null, 2)
  try {
    return JSON.stringify({ ...detail, input: JSON.parse(detail.input) }, null, 2)
  } catch {
    return JSON.stringify(detail, null, 2)
  }
}

/** The calls next to one call in the list, `reach` on each side, the call among them. Empty when the call is not in the list. */
export function callsAround(calls: readonly AppCallView[], callId: string, reach = 5): readonly AppCallView[] {
  const index = calls.findIndex((call) => call.id === callId)
  return index === -1 ? [] : calls.slice(Math.max(0, index - reach), index + reach + 1)
}

/** The call after (`1`) or before (`-1`) one call in the list; null at either end. */
export function neighbourCall(calls: readonly AppCallView[], callId: string, step: 1 | -1): AppCallView | null {
  const index = calls.findIndex((call) => call.id === callId)
  return index === -1 ? null : (calls[index + step] ?? null)
}
