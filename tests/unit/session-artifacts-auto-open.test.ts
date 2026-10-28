import { describe, expect, test } from 'bun:test'
import {
  HIGHLIGHT_WINDOW_MS,
  highlightedArtifactKey,
  shouldOpenArtifacts,
} from '@solus/workspace-ui/components/session/artifacts/lib/auto-open'

describe('artifacts auto-open rule', () => {
  test('opens only when a later read finds more artifacts', () => {
    // WHY: new output is news worth showing beside the conversation; the first
    // read (a load or an app reload) is not, and a fall never is.
    expect(shouldOpenArtifacts(null, 3)).toBe(false)
    expect(shouldOpenArtifacts(0, 1)).toBe(true)
    expect(shouldOpenArtifacts(2, 5)).toBe(true)
    expect(shouldOpenArtifacts(3, 3)).toBe(false)
    expect(shouldOpenArtifacts(3, 2)).toBe(false)
  })
})

describe('newest row highlight', () => {
  const rise = { sessionId: 's', previousCount: 1, count: 2, newestKey: 'work:w2', seenAt: 1000 }

  test('highlights the newest row of a recent rise once its window is open', () => {
    expect(highlightedArtifactKey(rise, 1000 + HIGHLIGHT_WINDOW_MS)).toBe('work:w2')
    expect(highlightedArtifactKey(rise, 1001 + HIGHLIGHT_WINDOW_MS)).toBeNull()
  })

  test('a fall or a first read highlights nothing', () => {
    expect(highlightedArtifactKey({ ...rise, previousCount: 3 }, 1000)).toBeNull()
    expect(highlightedArtifactKey({ ...rise, previousCount: null }, 1000)).toBeNull()
    expect(highlightedArtifactKey(null, 1000)).toBeNull()
  })
})
