import type { AppCaller, AppRunDetail, AppStepRetryPolicy, AppStepSource, AppStepView } from '@solus/contracts/apps'
import { formatDuration } from '../../../insights/lib/format'
import { stepKindLabel } from './runs'

/**
 * The graph of one workflow run (docs/plans/apps.md §8.3, §9.2): the trigger,
 * then the steps in the order they ran. A workflow declares no step, so the
 * graph comes from the step receipts: steps that ran at the same time are one
 * layer, and each layer follows the one before it. A run that stopped early
 * shows, dashed, the steps that the newest good run of its workflow did after
 * the last step it reached. `run-flow.ts` lays the graph out on the canvas.
 */

/** A step that ran in this run, or one that the newest good run did and this run did not reach. */
export interface GraphStep {
  name: string
  /** Null for a step that did not run in this run. */
  step: AppStepView | null
}

export interface RunGraph {
  /** The layers of steps, in order. The trigger is before the first one. */
  layers: GraphStep[][]
  /** Every step in order, the ones that did not run last. */
  steps: GraphStep[]
}

/** Groups steps that ran at the same time: a step that starts before every step of the layer ended joins it. */
function layersOf(steps: readonly AppStepView[]): AppStepView[][] {
  const layers: AppStepView[][] = []
  for (const step of [...steps].sort((a, b) => a.startedAt - b.startedAt)) {
    const last = layers.at(-1)
    const lastEnd = last ? Math.min(...last.map((entry) => entry.finishedAt ?? Number.POSITIVE_INFINITY)) : null
    if (last && lastEnd !== null && step.startedAt < lastEnd) last.push(step)
    else layers.push([step])
  }
  return layers
}

/** The graph of `run`. `lastGood` is the newest run of its workflow that succeeded, when this run did not. */
export function runGraph(run: Pick<AppRunDetail, 'state' | 'steps'>, lastGood: Pick<AppRunDetail, 'steps'> | null): RunGraph {
  const layers: GraphStep[][] = layersOf(run.steps).map((layer) => layer.map((step) => ({ name: step.name, step })))
  if (run.state !== 'succeeded' && lastGood) {
    const ran = new Set(run.steps.map((step) => step.name))
    for (const layer of layersOf(lastGood.steps)) {
      const missing = layer.filter((step) => !ran.has(step.name)).map((step): GraphStep => ({ name: step.name, step: null }))
      if (missing.length > 0) layers.push(missing)
    }
  }
  return { layers, steps: layers.flat() }
}

/** The step the inspector opens with: the failed one, else the one in progress, else the last one that ran. */
export function focusStep(graph: RunGraph): string | null {
  const ran = graph.steps.filter((entry) => entry.step !== null)
  const failed = ran.find((entry) => entry.step?.state === 'failed')
  const open = ran.find((entry) => entry.step?.state === 'running' || entry.step?.state === 'sleeping')
  return (failed ?? open ?? ran.at(-1))?.name ?? null
}

// ─── What a node and the inspector say ───

/** The trigger node's kind word: what started the run. */
export function triggerKindLabel(caller: AppCaller): string {
  const labels = { ui: 'Person', agent: 'Agent', schedule: 'Schedule', webhook: 'Webhook', workflow: 'Workflow', model: 'Model' } satisfies { [Kind in AppCaller['kind']]: string }
  return labels[caller.kind]
}

/** "Webhook · 14:01:41": the second line of the trigger's node. */
export function triggerDetailText(run: Pick<AppRunDetail, 'startedBy' | 'startedAt'>): string {
  return `${triggerKindLabel(run.startedBy)} · ${new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
}

/** "3 tries failed", "1m36", "Not run": the second line of a step's node. */
export function stepNodeText(entry: GraphStep, nowMs = Date.now()): string {
  const { step } = entry
  if (!step) return 'Not run'
  const time = formatDuration((step.finishedAt ?? nowMs) - step.startedAt)
  if (step.state === 'failed') return step.attempts > 1 ? `${step.attempts} tries failed · ${time}` : `Failed · ${time}`
  if (step.state === 'sleeping') return 'Sleeping'
  if (step.state === 'running') return step.attempts > 1 ? `Try ${step.attempts} · ${time}` : `Running · ${time}`
  return time
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : formatDuration(ms)
}

/** "3 retries, backoff from 2 s, 30 s limit": how a step tries again. */
export function retryPolicyText(policy: AppStepRetryPolicy): string {
  const limit = `${seconds(policy.timeoutMs)} limit`
  if (policy.limit === 0) return `No retry, ${limit}`
  const retries = policy.limit === 1 ? '1 retry' : `${policy.limit} retries`
  const wait = policy.backoff === 'constant' ? `${seconds(policy.delayMs)} apart` : `${policy.backoff === 'linear' ? 'linear' : ''} backoff from ${seconds(policy.delayMs)}`.trim()
  return `${retries}, ${wait}, ${limit}`
}

/** The line under a step's name in the inspector: its retry options, or its kind. */
export function stepPolicyLine(step: AppStepView): string {
  if (step.retryPolicy) return retryPolicyText(step.retryPolicy)
  return stepKindLabel(step.kind)
}

/** One row of a step's tries: "Try 2", "timed out · 30.0s". */
export interface TryRow {
  label: string
  detail: string
  isFailure: boolean
  /** The last try that failed: the one that ended the step. */
  isFinal: boolean
}

/** The tries of a step, or one row for a step whose tries the log does not keep. */
export function tryRows(step: AppStepView, nowMs = Date.now()): TryRow[] {
  // A host older than the tries sends none.
  const tries = step.tries ?? []
  if (tries.length === 0) {
    const time = formatDuration((step.finishedAt ?? nowMs) - step.startedAt)
    const outcome = step.state === 'done' ? 'done' : step.state === 'failed' ? 'failed' : step.state === 'sleeping' ? 'sleeping' : 'running'
    return [{ label: step.attempts > 1 ? `Try ${step.attempts}` : 'Try 1', detail: `${outcome} · ${time}`, isFailure: step.state === 'failed', isFinal: step.state === 'failed' }]
  }
  return tries.map((attempt, index) => {
    const isLast = index === tries.length - 1
    const outcome = attempt.ok ? 'done' : shortError(attempt.error)
    return { label: `Try ${attempt.attempt}`, detail: `${outcome} · ${formatDuration(attempt.durationMs)}`, isFailure: !attempt.ok, isFinal: isLast && !attempt.ok && step.state === 'failed' }
  })
}

/**
 * Why the inspector's Code button cannot open the step's source, or null
 * when it can. `source` is undefined while the host looks, and null when the
 * version's source has no `step.do('<name>'` call.
 */
export function stepCodeRefusal(step: string, version: number | null, source: AppStepSource | null | undefined, error: string | null): string | null {
  if (error) return `The source was not read: ${error}`
  if (source === undefined) return 'Finding the step in the source…'
  if (source === null) return `The source of ${version === null ? 'the active version' : `version ${version}`} has no step.do('${step}') call.`
  return null
}

/** What the inspector says of a step this run did not reach. */
export function notRunText(lastGood: Pick<AppStepView, 'startedAt' | 'finishedAt'> | null): string {
  if (!lastGood || lastGood.finishedAt === null) return 'This run did not reach this step.'
  return `This run did not reach this step. In the newest run that succeeded, it took ${formatDuration(lastGood.finishedAt - lastGood.startedAt)}.`
}

/** The first line of an error, short enough for a row. */
function shortError(error: string | null): string {
  const line = (error ?? 'failed').split('\n')[0].trim()
  return line.length > 32 ? `${line.slice(0, 31)}…` : line || 'failed'
}

// ─── The timeline ───

export interface TimelineBar {
  key: string
  /** From the start of the run, as a share of the axis (0–100). */
  left: number
  width: number
  tone: 'ok' | 'failed' | 'final' | 'running'
}

export interface TimelineLane {
  name: string
  bars: TimelineBar[]
  /** The waits between tries: dashed. */
  gaps: { key: string; left: number; width: number }[]
}

export interface RunTimeline {
  /** The length of the axis, in milliseconds. */
  spanMs: number
  ticks: { at: number; label: string }[]
  lanes: TimelineLane[]
}

/** One lane for each step that ran, with a bar for each try, on an axis from the run's start to its end (or now). */
export function runTimeline(run: Pick<AppRunDetail, 'startedAt' | 'finishedAt' | 'steps'>, nowMs = Date.now()): RunTimeline {
  const end = Math.max(run.finishedAt ?? nowMs, ...run.steps.map((step) => step.finishedAt ?? nowMs))
  const spanMs = Math.max(end - run.startedAt, 1)
  const share = (ms: number) => Math.max(0, Math.min(100, (ms / spanMs) * 100))
  const lanes = [...run.steps].sort((a, b) => a.startedAt - b.startedAt).map((step): TimelineLane => {
    const tries = step.tries ?? []
    const spans = tries.length > 0
      ? tries.map((attempt, index) => ({ start: attempt.startedAt, ms: attempt.durationMs, ok: attempt.ok, isLast: index === tries.length - 1 }))
      : [{ start: step.startedAt, ms: (step.finishedAt ?? nowMs) - step.startedAt, ok: step.state !== 'failed', isLast: true }]
    const bars = spans.map((part, index): TimelineBar => ({
      key: `${step.name}:${index}`,
      left: share(part.start - run.startedAt),
      width: share(part.ms),
      tone: !part.ok ? (part.isLast && step.state === 'failed' ? 'final' : 'failed') : part.isLast && (step.state === 'running' || step.state === 'sleeping') ? 'running' : 'ok',
    }))
    const gaps = bars.slice(1).map((bar, index) => {
      const before = bars[index]
      return { key: `${step.name}:gap:${index}`, left: before.left + before.width, width: Math.max(bar.left - before.left - before.width, 0) }
    })
    return { name: step.name, bars, gaps }
  })
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((part) => ({ at: part * 100, label: part === 0 ? '0s' : formatDuration(part * spanMs) }))
  return { spanMs, ticks, lanes }
}
