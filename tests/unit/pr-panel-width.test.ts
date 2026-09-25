import { describe, expect, test } from 'bun:test'
import {
  PR_PANEL_MIN_WIDTH,
  canSplitPrPanel,
  clampPrPanelWidth,
  prPanelWidth,
  readSavedPrPanelWidth,
  savePrPanelWidth,
} from '@solus/workspace-ui/components/prs/lib/pr-panel-width'

describe('pull request panel width', () => {
  test('leaves half the page for the PR rows until the reader chooses a width', () => {
    // WHY: the list must stay wide enough to scan titles when a review opens.
    expect(prPanelWidth(null, 1400)).toBe(700)
    expect(prPanelWidth(520, 1400)).toBe(520)
  })

  test('never takes more than 70% of the page, so the queue stays visible', () => {
    expect(clampPrPanelWidth(5000, 1400)).toBe(980)
  })

  test('always leaves the list its floor', () => {
    // 70% of 1000 is 700, but the list must keep 360.
    expect(clampPrPanelWidth(900, 1000)).toBe(1000 - PR_PANEL_MIN_WIDTH)
  })

  test('never shrinks the review below its floor', () => {
    expect(clampPrPanelWidth(100, 1400)).toBe(PR_PANEL_MIN_WIDTH)
  })

  test('splits only where both floors fit; narrower pages cover the list', () => {
    expect(canSplitPrPanel(PR_PANEL_MIN_WIDTH * 2)).toBe(true)
    expect(canSplitPrPanel(PR_PANEL_MIN_WIDTH * 2 - 1)).toBe(false)
  })

  test('a remembered width survives a reload and junk is ignored', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    expect(readSavedPrPanelWidth(storage)).toBeNull()
    savePrPanelWidth(612.4, storage)
    expect(readSavedPrPanelWidth(storage)).toBe(612)
    values.set('solus.prs.panel-width', 'wide')
    expect(readSavedPrPanelWidth(storage)).toBeNull()
  })
})
