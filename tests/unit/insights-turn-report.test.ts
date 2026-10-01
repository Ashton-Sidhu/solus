import { describe, expect, test } from 'bun:test'
import type { MetricsSpan, MetricsTurnTrace } from '@solus/contracts/observability-types'
import { workPreview } from '@solus/contracts/work-preview'
import {
  parseTurnReport,
  reportAgent,
  turnReportContent,
  turnReportSubject,
  turnReportTitle,
  type TurnReport,
} from '../../packages/workspace-ui/src/components/insights/lib/turn-report'
import { buildTraceView } from '../../packages/workspace-ui/src/components/insights/lib/waterfall'

// docs/plans/cloud-sharing.md §4: a shared Insights report carries the readings
// the turn panel reads, so the share page draws the same panel while the
// computer that ran the turn is off.

const root: MetricsSpan = {
  spanId: 'root',
  parentSpanId: null,
  traceId: 'trace-1',
  kind: 'turn',
  name: 'turn',
  service: 'solus',
  sessionId: 's1',
  provider: 'claude-code',
  model: 'claude-opus',
  projectRoot: '/repo',
  origin: 'typed',
  startedAt: 1_000,
  endedAt: 65_000,
  durationMs: 64_000,
  status: 'error',
  attrs: { prompt: 'Make sharing work\nwithout the link' },
}

const trace: MetricsTurnTrace = { traceId: 'trace-1', spans: [root], logEvents: [], providerWaitMs: null, gapSegments: [] }

const report: TurnReport = {
  version: 1,
  capturedAt: Date.parse('2026-09-30T12:00:00Z'),
  trace,
  session: null,
  sessionName: 'Fix sharing',
  taskTitle: 'Release',
  baselines: [{ label: 'Cost', value: '$0.42', sessionMedian: '$0.20', modelMedian: null, sessionRatio: 2.1, modelRatio: null }],
  prompts: { 'trace-1': 'Make sharing work' },
  patch: 'diff --git a/x b/x\n',
}

describe('a shared Insights report', () => {
  test('keeps everything the turn page reads across the trip to the cloud', () => {
    // WHY: the guest's page is drawn from this body alone; a reading that does
    // not survive the round trip is a card missing from the shared page.
    const read = parseTurnReport(turnReportContent(report))
    expect(read).toEqual(report)
    expect(buildTraceView(read!.trace)?.root?.spanId).toBe('root')
  })

  test('reads no report from a body that is not one', () => {
    // WHY: an unreadable body must show the "could not be read" state, never a
    // page drawn from half a trace.
    expect(parseTurnReport('# Turn report · Fix sharing')).toBeNull()
    expect(parseTurnReport(JSON.stringify({ ...report, version: 2 }))).toBeNull()
    expect(parseTurnReport(JSON.stringify({ ...report, trace: { traceId: 'trace-1' } }))).toBeNull()
  })

  test('names its subject and capture day', () => {
    const subject = turnReportSubject({ sessionName: null, taskTitle: 'Release', prompt: 'Ship it' })
    expect(subject).toBe('Release')
    expect(turnReportSubject({ sessionName: null, taskTitle: null, prompt: '  ' })).toBe('Untitled turn')
    expect(turnReportTitle({ subject, capturedAt: new Date(report.capturedAt) })).toBe('Turn report · Release · 2026-09-30')
  })

  test('previews as a report in the Workspace list, not as raw JSON', () => {
    expect(workPreview('insights-report', turnReportContent(report))).toBe('Insights report')
  })

  test('files the report under the turn\'s agent, or Claude when the trace names none', () => {
    expect(reportAgent('codex')).toBe('codex')
    expect(reportAgent(null)).toBe('claude-code')
    expect(reportAgent('unknown-agent')).toBe('claude-code')
  })
})
