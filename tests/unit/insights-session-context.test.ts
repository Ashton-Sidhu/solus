import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionContextBuckets } from '../../src/renderer/components/insights/lib/session-context'
import {
  promptsByTrace,
  sessionSummaryView,
} from '../../src/renderer/components/insights/lib/session-summary'
import type { TurnRow } from '../../src/renderer/components/insights/lib/turn-rows'
import type { MetricsSessionSummary } from '../../src/shared/observability-types'

const FROM = 1_000_000
const TO = FROM + 10_000

function turn(partial: Partial<TurnRow> & { traceId: string; startedAt: number }): TurnRow {
  return {
    sessionId: 'session-a',
    durationMs: 1000,
    status: 'ok',
    model: 'claude',
    provider: 'claude-code',
    origin: 'typed',
    promptSource: null,
    prompt: '',
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    toolCallCount: null,
    ...partial,
  }
}

function buckets(rows: TurnRow[], currentTraceId = 'a1', count = 10) {
  return sessionContextBuckets({
    rows,
    sessionId: 'session-a',
    currentTraceId,
    currentStartedAt: FROM,
    from: FROM,
    to: TO,
    count,
  })
}

describe('Insights session strip counts', () => {
  // Why it matters: the three bar layers are three readings of one bucketing.
  // Counting this session separately is what keeps its bars from disappearing
  // into a backdrop drawn from the same turns.
  test('a bucket counts this session apart from every other one in it', () => {
    const built = buckets([
      turn({ traceId: 'other', startedAt: FROM + 100, sessionId: 'session-b' }),
      turn({ traceId: 'mine', startedAt: FROM + 200 }),
    ])
    expect(built[0].total).toBe(2)
    expect(built[0].sessionCount).toBe(1)
  })

  test('a failed turn is counted as one', () => {
    const built = buckets([turn({ traceId: 'a1', startedAt: FROM + 100, status: 'error' })])
    expect(built[0].failed).toBe(1)
  })

  test('the turn being read marks its bar even when the answer never listed it', () => {
    const built = sessionContextBuckets({
      rows: [],
      sessionId: 'session-a',
      currentTraceId: 'deep-linked',
      currentStartedAt: FROM + 500,
      from: FROM,
      to: TO,
      count: 10,
    })
    expect(built.filter((bar) => bar.isCurrent)).toHaveLength(1)
  })

  test('a turn outside the window is dropped rather than piled onto an edge bar', () => {
    const built = buckets([turn({ traceId: 'late', startedAt: TO + 5000 })])
    expect(built.every((bar) => bar.total === 0)).toBe(true)
  })
})

const SESSION: MetricsSessionSummary = {
  sessionId: 'session-a',
  turnCount: 3,
  totalDurationMs: 6000,
  totalCostUsd: 0.5,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  turns: [
    {
      turnNumber: 1,
      traceId: 'a1',
      startedAt: FROM,
      endedAt: FROM + 1000,
      durationMs: 1000,
      status: 'ok',
      model: 'claude',
      origin: 'typed',
      promptSource: null,
      prompt: null,
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 5,
      toolCallCount: 1,
    },
    {
      turnNumber: 2,
      traceId: 'a2',
      startedAt: FROM + 2000,
      endedAt: FROM + 6000,
      durationMs: 4000,
      status: 'error',
      model: 'claude',
      origin: 'typed',
      promptSource: null,
      prompt: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      toolCallCount: null,
    },
    {
      turnNumber: 3,
      traceId: 'a3',
      startedAt: FROM + 7000,
      endedAt: null,
      durationMs: null,
      status: 'ok',
      model: null,
      origin: 'typed',
      promptSource: null,
      prompt: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      toolCallCount: null,
    },
  ],
}

describe('Insights session summary', () => {
  // Why it matters: the card exists to answer "where am I in this session".
  test('it states the reader’s place in the session', () => {
    const view = sessionSummaryView(SESSION, new Map(), 'a2', null)
    expect(view.position).toBe(2)
    expect(view.turnCount).toBe(3)
  })

  test('a turn the session does not hold leaves the place unclaimed', () => {
    const view = sessionSummaryView(SESSION, new Map(), 'elsewhere', null)
    expect(view.position).toBe(0)
  })

  test('a row is named by what was asked when the answer carries the text', () => {
    const prompts = promptsByTrace([
      turn({ traceId: 'a1', startedAt: FROM, prompt: 'fix   the\nflaky test' }),
      turn({ traceId: 'a2', startedAt: FROM, prompt: '   ' }),
    ])
    const view = sessionSummaryView(SESSION, prompts, 'a1', 'Flaky test hunt')
    expect(view.rows[0].title).toBe('fix the flaky test')
    // No prompt text: the session's own name, never the model. A column of
    // repeated model ids names nothing a reader was looking for.
    expect(view.rows[1].title).toBe('Flaky test hunt')
    expect(view.rows[2].title).toBe('Flaky test hunt')
    expect(view.rows.some((row) => row.title === 'claude')).toBe(false)
  })

  test('a turn outside the answer is named by the ask the rollup carries', () => {
    // WHY: the session name is the same on every row, so a card falling back to
    // it names none of them. The rollup's own capped prompt outranks it.
    const session: MetricsSessionSummary = {
      ...SESSION,
      turns: SESSION.turns.map((turnSummary, index) =>
        index === 1 ? { ...turnSummary, prompt: 'rerun the suite' } : turnSummary,
      ),
    }
    const view = sessionSummaryView(session, new Map(), 'a1', 'Flaky test hunt')
    expect(view.rows[1].title).toBe('rerun the suite')
    expect(view.rows[0].title).toBe('Flaky test hunt')
  })

  test('a session the host no longer names falls back to a stated absence', () => {
    const view = sessionSummaryView(SESSION, new Map(), 'a1', null)
    expect(view.rows[0].title).toBe('No prompt text recorded')
  })

  test('a failed turn is marked, so the thread shows where it broke', () => {
    const view = sessionSummaryView(SESSION, new Map(), 'a1', null)
    expect(view.rows[1].failed).toBe(true)
    expect(view.rows[0].failed).toBe(false)
  })

  test('the measures a row drops travel with it, for the hover card', () => {
    // WHY: the row prints three things. Everything else the rollup recorded has
    // to survive the view or the hover card has nothing to answer with.
    const view = sessionSummaryView(SESSION, new Map(), 'a1', null)
    expect(view.rows[0].model).toBe('claude')
    expect(view.rows[0].tokens).toBe(15)
    expect(view.rows[0].status).toBe('ok')
    expect(view.rows[2].tokens).toBeNull()
  })
})

const chart = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/insights/SessionContextChart.svelte'),
  'utf8',
)
const summary = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/insights/SessionSummary.svelte'),
  'utf8',
)
const transcript = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/insights/TurnTranscript.svelte'),
  'utf8',
)
const toolTotals = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/insights/TurnToolTotals.svelte'),
  'utf8',
)
const panel = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/insights/TurnDetailPanel.svelte'),
  'utf8',
)

describe('Insights session surfaces composition', () => {
  // Why it matters: the strip is a picture. A bar names a half hour, so opening
  // one would open whichever turn happened to fall in it; the summary names its
  // turns and owns the navigation.
  test('the strip carries no controls', () => {
    expect(chart).not.toContain('<button')
    expect(chart).not.toContain('onclick')
    expect(chart).not.toContain('onOpenTurn')
  })

  test('the summary is the way to another turn, and it lands on the reader’s own', () => {
    expect(summary).toContain('onclick={() => onOpenTurn(row.traceId)}')
    expect(summary).toContain('scrollIntoView({ block: "nearest" })')
  })

  test('the task-backed summary heading opens the task beside Insights', () => {
    // This heading is the prominent task label the reader sees. The action
    // belongs on it, not only on a task value hidden in the Attributes list.
    expect(summary).not.toContain('{#if taskId}')
    expect(summary).toContain('{taskTitle ?? sessionName ?? shortId(session.sessionId)}')
    expect(summary).toContain('title="Open task in the trailing pane"')
    expect(summary).toContain('onclick={onOpenTask}')
    expect(panel).toContain('{taskTitle}')
    expect(panel).toContain('onOpenTask={() => void openSessionTask()}')
    expect(panel).toContain('workspace.goToTask(taskId, "click", "secondary")')
    expect(panel).toContain('workspace.tasksStore.ensureSessionBinding(')
    expect(panel).toContain('workspace.tasksStore.taskForSession(sessionId)')
    expect(panel).toContain('session?.taskId || boundTask?.id || null')
  })

  test('a row answers its second question on hover, the way a session row does', () => {
    expect(summary).toContain('<SessionTurnTooltip {row} />')
  })

  // Why it matters: a column of coloured dots asks the reader to learn a key
  // before they can read a list they could already read. Status is carried by
  // the ink of the duration and by words on the hover card.
  test('no turn surface marks state with a dot', () => {
    for (const [name, source] of [
      ['SessionSummary', summary],
      ['TurnTranscript', transcript],
    ] as const) {
      expect(source, name).not.toMatch(/size-1\.5[^"]*rounded-full/)
      expect(source, name).not.toMatch(/rounded-full[^"]*size-1\.5/)
    }
  })

  // Why it matters: the card is context beside the turn being read. A 200-turn
  // session that takes the whole page turns the context into the listing, and a
  // bounded list that hides its own thumb reads as a truncated one.
  test('the bounded lists take the app’s standard scroll treatment', () => {
    for (const bounded of summary.match(/class="[^"]*overflow-y-auto[^"]*"/g) ?? []) {
      expect(bounded).toContain('scrollbar-on-hover')
      expect(bounded).toContain('overscroll-contain')
      expect(bounded).toMatch(/max-h-\[/)
    }
    // Three rows on a laptop, five on a taller desktop display. The bound is a
    // vertical one, so it reads the screen's height rather than the panel's
    // width: a wide laptop panel still has no room for five rows.
    expect(summary).toContain('max-h-[6.25rem]')
    expect(summary).toContain('[@media(min-height:1000px)]:max-h-[9.75rem]')
    expect(summary).not.toContain('@xl:max-h-')
    // Why it matters: the list is a bounded flex column, where a row's height
    // is a suggestion the container may take back. Without this the rows
    // compress to fit the cap, so the list shows every turn at a squeezed
    // height and never scrolls — the bound reads as if it were not there.
    expect(summary).toContain('flex h-7 w-full shrink-0')
  })

  // Why it matters: the header already states "Turn 5 of 8". Marking the same
  // row again with a wash and a heavier weight reads as selection on a list
  // whose rows are all hoverable and all openable. Ink strength is the quietest
  // mark that still answers "which one am I reading"; a dot or an edge rail
  // would re-introduce the chrome those surfaces already rejected.
  test('the turn being read is marked by ink alone', () => {
    expect(summary).toContain("? 'text-foreground'")
    expect(summary).not.toMatch(/isCurrent[\s\S]{0,80}font-medium/)
    expect(summary).not.toMatch(/isCurrent[\s\S]{0,120}bg-\[color-mix/)
    expect(summary).not.toMatch(/isCurrent[\s\S]{0,120}inset_2px_0_0/)
    // The row still declares its state to assistive technology.
    expect(summary).toContain('aria-current={row.isCurrent ? "true" : undefined}')
  })

  // Why it matters: the two short lists are useful together, but they measure
  // different depths. They must share a responsive row without being merged
  // into one card or leaving the ranking down beside the attributes.
  test('the tool ranking sits beside the session card and outside the attribute rail', () => {
    expect(summary).not.toContain('toolTotals')
    expect(toolTotals).toContain('totals.slice(0, 5)')
    expect(panel).toContain('@4xl:grid-cols-[minmax(0,1fr)_19.25rem]')
    expect(panel).toMatch(/<SessionSummary[\s\S]*?<TurnToolTotals totals=\{view\.toolTotals\}/)
    const aside = panel.slice(panel.indexOf('<aside'), panel.indexOf('</aside>'))
    expect(aside).not.toContain('<TurnToolTotals')
  })

  // Why it matters: an answer and a system prompt are markdown. Printed as one
  // pre-wrapped string they arrive as literal `#`, fences and list markers at
  // the chrome's size — the state this rework replaced.
  test('the recorded answer is read as prose, not as one pre-wrapped string', () => {
    expect(transcript).toContain('<SvelteMarkdown')
    expect(transcript).toContain('prose-cloud prose-reading prose-transcript')
    // The ask is typed text and keeps its own line breaks.
    expect(transcript).toMatch(/pane\.role === "prompt"/)
    expect(transcript).toContain('whitespace-pre-wrap')
  })
})
