import { z } from 'zod'
import type { AgentId } from '@solus/contracts/types'
import type { MetricsSessionSummary, MetricsTurnTrace } from '@solus/contracts/observability-types'
import type { TurnBaseline } from './turn-analysis'
import { singleLine } from './format'

/**
 * A shared Insights report (docs/plans/cloud-sharing.md §4): one turn's
 * readings, captured when it was shared. It is the data the turn panel reads,
 * so the share page draws the same panel from it. It becomes a work of type
 * `insights-report` and leaves the computer the way any work does, so it reads
 * the same while the computer that ran the turn is off.
 *
 * The panel compares the turn against the window's other turns of the same
 * model. Those rows stay on the computer: the report keeps the comparison
 * (`baselines`) and the session's prompts, not the rows.
 */
export interface TurnReport {
  version: 1
  capturedAt: number
  trace: MetricsTurnTrace
  session: MetricsSessionSummary | null
  sessionName: string | null
  taskTitle: string | null
  baselines: TurnBaseline[]
  /** The one-line prompt of each turn in the session, by trace id. */
  prompts: Record<string, string>
  /** What the turn changed, as git recorded it; null when it was not known. */
  patch: string | null
}

// The trace and session are the host's own answers, carried as they were read.
// The envelope is checked; the readings inside are trusted to their contract.
const traceEnvelope = z.object({
  traceId: z.string(),
  spans: z.array(z.object({ spanId: z.string(), traceId: z.string() })),
  logEvents: z.array(z.object({})),
  gapSegments: z.array(z.object({})),
})
const sessionEnvelope = z.object({ sessionId: z.string(), turns: z.array(z.object({ traceId: z.string() })) })
const traceSchema = z.custom<MetricsTurnTrace>((value) => traceEnvelope.safeParse(value).success)
const sessionSchema = z.custom<MetricsSessionSummary>((value) => sessionEnvelope.safeParse(value).success)

const turnReportSchema = z.object({
  version: z.literal(1),
  capturedAt: z.number(),
  trace: traceSchema,
  session: sessionSchema.nullable(),
  sessionName: z.string().nullable(),
  taskTitle: z.string().nullable(),
  baselines: z.array(z.object({
    label: z.string(),
    value: z.string(),
    sessionMedian: z.string().nullable(),
    modelMedian: z.string().nullable(),
    sessionRatio: z.number().nullable(),
    modelRatio: z.number().nullable(),
  })),
  prompts: z.record(z.string(), z.string()),
  patch: z.string().nullable(),
})

export function turnReportContent(report: TurnReport): string {
  return JSON.stringify(report)
}

/** The report a work holds, or null when its body is not one. */
export function parseTurnReport(content: string): TurnReport | null {
  try {
    const parsed = turnReportSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function turnReportTitle(input: { subject: string; capturedAt: Date }): string {
  return `Turn report · ${input.subject} · ${input.capturedAt.toISOString().slice(0, 10)}`
}

/** The session, task, or prompt the turn is known by. */
export function turnReportSubject(input: { sessionName: string | null; taskTitle: string | null; prompt: string }): string {
  return input.sessionName ?? input.taskTitle ?? (singleLine(input.prompt) || 'Untitled turn')
}

const AGENT_IDS: readonly AgentId[] = ['claude-code', 'codex', 'opencode']

/** The agent the report's work is filed under: the turn's own, or Claude when the trace names none. */
export function reportAgent(provider: string | null | undefined): AgentId {
  return AGENT_IDS.find((agent) => agent === provider) ?? 'claude-code'
}
