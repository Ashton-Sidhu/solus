import { describe, expect, test } from 'bun:test'
import { personalSettingsWithDefaults, personalSettingsDocumentSchema } from '@solus/contracts/settings'
import { initialLocation, openSurface, companionOf } from '@solus/workspace-ui/contexts/workspace/routing/location'
import {
  HIGHLIGHT_WINDOW_MS,
  highlightedArtifactKey,
  opensBehindNewestItem,
  shouldOpenArtifacts,
} from '@solus/workspace-ui/components/session/artifacts/lib/auto-open'

describe('artifacts auto-open rule', () => {
  test('new artifacts do not open the surface unless enabled', () => {
    expect(shouldOpenArtifacts(0, 1, false)).toBe(false)
    expect(shouldOpenArtifacts(2, 5, false)).toBe(false)
  })

  test('opens only when a later read finds more artifacts', () => {
    // WHY: new output is news worth showing beside the conversation; the first
    // read (a load or an app reload) is not, and a fall never is.
    expect(shouldOpenArtifacts(null, 3, true)).toBe(false)
    expect(shouldOpenArtifacts(0, 1, true)).toBe(true)
    expect(shouldOpenArtifacts(2, 5, true)).toBe(true)
    expect(shouldOpenArtifacts(3, 3, true)).toBe(false)
    expect(shouldOpenArtifacts(3, 2, true)).toBe(false)
  })
})

describe('a new app link', () => {
  test('the list opens behind the app, and in front for every other kind', () => {
    // WHY: a deploy opens the app's own surface beside the conversation. The
    // Artifacts surface joins the strip too, and must not cover the app.
    expect(opensBehindNewestItem('app:h1:app_1')).toBe(true)
    expect(opensBehindNewestItem('work:w1')).toBe(false)
    expect(opensBehindNewestItem('file:h1:/repo/app:notes.md')).toBe(false)
    expect(opensBehindNewestItem(null)).toBe(false)
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

test('automatic opening defaults off and is a valid personal preference', () => {
  expect(personalSettingsWithDefaults({}).autoOpenArtifacts).toBe(false)
  const document = personalSettingsDocumentSchema.parse({ autoOpenArtifacts: true })
  expect(personalSettingsWithDefaults(document).autoOpenArtifacts).toBe(true)
})

test('Artifacts opens in a narrow companion pane and keeps a resized pane', () => {
  const location = initialLocation()
  openSurface(location, { name: 'artifacts', params: { sessionId: 's' } })
  expect(companionOf(location)?.defaultSize).toBe(30)
  companionOf(location)!.defaultSize = 42
  openSurface(location, { name: 'artifacts', params: { sessionId: 'other' } })
  expect(companionOf(location)?.defaultSize).toBe(42)
})
