import { describe, expect, test } from 'bun:test'
import {
  generatedSql,
  presetsFor,
  sqlPresets,
} from '../../src/renderer/components/insights/lib/insights-queries'
import {
  fromLocalInput,
  isApplicableAbsolute,
  parseStoredRange,
  rangeCondition,
  rangeHeading,
  rangeInstruction,
  rangeLabel,
  resolveRange,
  sameRange,
  toLocalInput,
  type TimeRange,
} from '../../src/renderer/components/insights/lib/time-range'

const DAY = 24 * 60 * 60 * 1000
const RELATIVE: TimeRange = { kind: 'relative', ms: DAY }
const ABSOLUTE: TimeRange = { kind: 'absolute', from: 1_700_000_000_000, to: 1_700_086_400_000 }

describe('time range resolution', () => {
  test('a relative range resolves against the clock, an absolute one against its edges', () => {
    // WHY: the two forms exist for different jobs. A relative window must keep
    // describing "now" as the page sits open; an absolute one must not move,
    // because the incident being investigated does not move either.
    expect(resolveRange(RELATIVE, 5_000_000)).toEqual({ from: 5_000_000 - DAY, to: 5_000_000 })
    expect(resolveRange(ABSOLUTE, 5_000_000)).toEqual({ from: ABSOLUTE.from, to: ABSOLUTE.to })
  })

  test('an inverted or half-filled custom range is refused, not answered', () => {
    // WHY: an end before its start returns zero rows, which the surface would
    // render as "nothing happened here" — a wrong answer, not an empty one.
    expect(isApplicableAbsolute(10, 20)).toBe(true)
    expect(isApplicableAbsolute(20, 10)).toBe(false)
    expect(isApplicableAbsolute(20, 20)).toBe(false)
    expect(isApplicableAbsolute(null, 20)).toBe(false)
  })

  test('the picker string round-trips to the instant it names', () => {
    const at = new Date(2026, 2, 14, 21, 5).getTime()
    expect(fromLocalInput(toLocalInput(at))).toBe(at)
    expect(fromLocalInput('2026-03-14')).toBeNull()
    expect(fromLocalInput('')).toBeNull()
  })

  test('a persisted range is rehydrated only when it is still a range', () => {
    // WHY: local storage is user-writable and survives releases. Anything that
    // is not a usable window must fall back rather than poison every query.
    expect(parseStoredRange(JSON.stringify(RELATIVE))).toEqual(RELATIVE)
    expect(parseStoredRange(JSON.stringify(ABSOLUTE))).toEqual(ABSOLUTE)
    expect(parseStoredRange('{"kind":"absolute","from":20,"to":10}')).toBeNull()
    expect(parseStoredRange('{"kind":"relative","ms":-1}')).toBeNull()
    expect(parseStoredRange('not json')).toBeNull()
    expect(parseStoredRange(null)).toBeNull()
  })

  test('the label names the window in the form the user chose', () => {
    expect(rangeLabel(RELATIVE)).toBe('Last 24 hours')
    // The heading names what the histogram counts, which follows the answer:
    // a tool-call listing is not a count of turns.
    expect(rangeHeading(RELATIVE, 'Turns')).toBe('Turns over the last 24 hours')
    expect(rangeHeading(RELATIVE, 'Tool calls')).toBe('Tool calls over the last 24 hours')
    expect(rangeLabel(ABSOLUTE)).toContain('→')
    expect(sameRange(RELATIVE, { kind: 'relative', ms: DAY })).toBe(true)
    expect(sameRange(RELATIVE, ABSOLUTE)).toBe(false)
  })
})

describe('range conditions in generated SQL', () => {
  test('a relative range compiles to SQLite’s clock, an absolute one to literals', () => {
    // WHY: re-running the same statement an hour later must still answer "the
    // last 24 hours". Pinned edges must survive the same re-run unchanged.
    expect(rangeCondition(RELATIVE)).toBe(
      `started_at > (strftime('%s','now') * 1000 - ${DAY})`,
    )
    expect(rangeCondition(ABSOLUTE)).toBe(
      `started_at >= ${ABSOLUTE.from} and started_at < ${ABSOLUTE.to}`,
    )
  })

  test('every shipped preset is constrained to the selected range', () => {
    // WHY: this is the whole contract of a global time filter. A preset that
    // kept its own baked window would answer a different question from the
    // histogram directly above it.
    const presets = sqlPresets(ABSOLUTE)
    expect(presets.length).toBeGreaterThan(0)
    for (const preset of presets) {
      // A preset that joins two views has to qualify the column or SQLite calls
      // it ambiguous. The bound is still the same bound, so compare with the
      // table alias dropped rather than demanding one spelling.
      const unqualified = preset.text.replace(/\b\w+\.started_at\b/g, 'started_at')
      expect(unqualified).toContain(rangeCondition(ABSOLUTE))
    }
  })

  test('the shipped preset pack contains only the selected questions', () => {
    // WHY: preset chips are a curated product surface. A removed question
    // must not remain reachable through a stale id or the other input form.
    expect(presetsFor('sql', RELATIVE).map((preset) => preset.id)).toEqual([
      'turn-time-by-model',
      'where-time-goes',
      'slowest-tools',
      'tool-time-by-model',
      'cost-by-project',
      'agent-spend-by-service',
    ])
    expect(presetsFor('nl', RELATIVE).map((preset) => preset.id)).toEqual([
      'nl-slowest',
      'nl-spend',
      'nl-waiting',
    ])
  })

  test('preset duration results are presented in seconds', () => {
    // WHY: the schema stores milliseconds, but the preset surface promises
    // readable seconds and must not leak millisecond result columns.
    const timingPresets = sqlPresets(RELATIVE).filter((preset) =>
      /duration_ms|tool_time_ms/.test(preset.text),
    )
    expect(timingPresets.length).toBeGreaterThan(0)
    for (const preset of timingPresets) {
      expect(preset.text).toContain('/ 1000.0')
      expect(preset.text).not.toMatch(/\bas \w*_ms\b/)
    }
  })

  test('a generated statement is re-emitted at a new range, by description', () => {
    // WHY: the surface remembers which question it asked, not the text it
    // produced, so moving the window rewrites the statement instead of
    // stranding the user on a query about yesterday.
    const explore = generatedSql({ kind: 'explore' }, ABSOLUTE)
    expect(explore).toContain(rangeCondition(ABSOLUTE))

    const session = generatedSql({ kind: 'session', sessionId: "o'brien" }, RELATIVE)
    expect(session).toContain("session_id = 'o''brien'")
    expect(session).toContain(rangeCondition(RELATIVE))

    // A task is asked by id, not by title: the title is a point-in-time capture
    // that a rename leaves behind, and one task is often several sessions.
    const task = generatedSql({ kind: 'task', taskId: "o'neill" }, RELATIVE)
    expect(task).toContain("task_id = 'o''neill'")
    expect(task).toContain(rangeCondition(RELATIVE))

    expect(generatedSql({ kind: 'preset', presetId: 'slowest-tools' }, ABSOLUTE)).toContain(
      rangeCondition(ABSOLUTE),
    )
    expect(generatedSql({ kind: 'preset', presetId: 'gone' }, ABSOLUTE)).toBeNull()
  })

  test('the natural-language compile is told the window, not left to guess', () => {
    // WHY: an answer under a histogram must describe the same turns as the
    // bars. The instruction is visible in the compiled SQL the editor shows.
    expect(rangeInstruction(ABSOLUTE)).toContain(rangeCondition(ABSOLUTE))
    expect(rangeInstruction(ABSOLUTE)).toContain('names its own time period')
  })
})
