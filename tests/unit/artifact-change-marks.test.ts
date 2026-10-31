import { describe, expect, test } from 'bun:test'
import { ArtifactChangeMarks, changedWords, withChangeMarks } from '@solus/workspace-ui/components/work/lib/artifact-change-marks'

/**
 * The History dialog highlights what changed between two artifact renders
 * (docs/plans/work-review-and-live-editing.md). An artifact is often a script
 * that builds its page, so the comparison is over the words each frame shows.
 */

describe('changed words', () => {
  test('an edited title marks only the new words on the after side', () => {
    const marks = changedWords(['How', 'WebSockets', 'work'], ['How', 'WebSockets', 'work', 'in', 'Solus'])
    expect(marks).toEqual({ before: [], after: [3, 4] })
  })

  test('a replaced label marks the old words before and the new words after', () => {
    const marks = changedWords(['Send', 'from', 'client'], ['Send', 'a', 'prompt'])
    expect(marks).toEqual({ before: [1, 2], after: [1, 2] })
  })
})

describe('the exchange with the frames', () => {
  function frame() {
    const sent: { channel: string; indexes: number[] }[] = []
    return { sent, postMessage: (message: { channel: string; indexes: number[] }) => sent.push(message) }
  }

  function report(marks: ArtifactChangeMarks, channel: string, side: 'before' | 'after', words: string[], source: ReturnType<typeof frame>) {
    marks.receive({ data: { type: 'solus-history-words', channel, side, words }, source: source as unknown as MessageEventSource })
  }

  test('marks go out only once both frames report, and the toggle clears them', () => {
    const marks = new ArtifactChangeMarks('c1', true)
    const before = frame()
    const after = frame()
    report(marks, 'c1', 'before', ['a', 'b'], before)
    expect(before.sent).toEqual([])
    report(marks, 'c1', 'after', ['a', 'c'], after)
    expect(before.sent.at(-1)?.indexes).toEqual([1])
    expect(after.sent.at(-1)?.indexes).toEqual([1])
    marks.setEnabled(false)
    expect(after.sent.at(-1)?.indexes).toEqual([])
  })

  test('a frame of another comparison is not heard', () => {
    const marks = new ArtifactChangeMarks('c2', true)
    const stale = frame()
    report(marks, 'c1', 'before', ['a'], stale)
    report(marks, 'c1', 'after', ['b'], stale)
    expect(stale.sent).toEqual([])
  })

  test('the frame script names its comparison and side', () => {
    const html = withChangeMarks('<p>Hi</p>', 'c3', 'after')
    expect(html.startsWith('<p>Hi</p><script>')).toBe(true)
    expect(html).toContain('"c3"')
    expect(html).toContain('"after"')
  })
})
