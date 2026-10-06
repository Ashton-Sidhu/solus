import { describe, expect, test } from 'bun:test'
import { deriveLayout, deriveThreadFeedColumn } from '../../apps/mobile/src/lib/layout'

describe('native adaptive layout', () => {
  test('a full or wide iPad window keeps a sidebar; a narrow window or landscape phone stacks', () => {
    expect(deriveLayout({ width: 1024, height: 1366 })).toMatchObject({ variant: 'split', listPaneWidth: 328 })
    expect(deriveLayout({ width: 1366, height: 1024 })).toMatchObject({ variant: 'split', listPaneWidth: 380 })
    // iPad Split View at a third of the screen, and an iPhone in landscape.
    expect(deriveLayout({ width: 375, height: 1024 })).toMatchObject({ variant: 'compact', usesSplitView: false })
    expect(deriveLayout({ width: 932, height: 430 })).toMatchObject({ variant: 'compact', usesSplitView: false })
  })
})

describe('native thread feed column', () => {
  test('assistant prose uses the full phone pane less the normal edge padding, not the desktop 65% column', () => {
    // A 390pt phone: the composer is inset 16pt, so the feed must be too.
    const column = deriveThreadFeedColumn({ viewportWidth: 390, contentMaxWidth: null, horizontalPadding: 16 })
    expect(column).toEqual({ contentHorizontalPadding: 16, contentWidth: 358 })
  })

  test('a width cap from the screen still centers the column, with at least the edge padding', () => {
    const column = deriveThreadFeedColumn({ viewportWidth: 1200, contentMaxWidth: 800, horizontalPadding: 20 })
    expect(column).toEqual({ contentHorizontalPadding: 220, contentWidth: 760 })
  })
})
