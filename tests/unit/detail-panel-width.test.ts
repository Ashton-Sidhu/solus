import { describe, expect, test } from 'bun:test'
import {
  DETAIL_PANEL_MIN_WIDTH,
  canSplitDetailPanel,
  clampDetailPanelWidth,
  detailPanelWidth,
  readSavedDetailPanelWidth,
  saveDetailPanelWidth,
} from '@solus/workspace-ui/components/ui/list-page/detail-panel-width'

describe('detail panel width', () => {
  test('leaves half the page for the PR rows until the reader chooses a width', () => {
    // WHY: the list must stay wide enough to scan titles when a review opens.
    expect(detailPanelWidth('prs', null, 1400)).toBe(700)
    expect(detailPanelWidth('prs', 520, 1400)).toBe(520)
  })

  test('never takes more than 70% of the page, so the queue stays visible', () => {
    expect(clampDetailPanelWidth(5000, 1400)).toBe(980)
  })

  test('always leaves the list its floor', () => {
    // 70% of 1000 is 700, but the list must keep 360.
    expect(clampDetailPanelWidth(900, 1000)).toBe(1000 - DETAIL_PANEL_MIN_WIDTH)
  })

  test('never shrinks the review below its floor', () => {
    expect(clampDetailPanelWidth(100, 1400)).toBe(DETAIL_PANEL_MIN_WIDTH)
  })

  test('splits only where both floors fit; narrower pages cover the list', () => {
    expect(canSplitDetailPanel(DETAIL_PANEL_MIN_WIDTH * 2)).toBe(true)
    expect(canSplitDetailPanel(DETAIL_PANEL_MIN_WIDTH * 2 - 1)).toBe(false)
  })

  test('a remembered width survives a reload and junk is ignored', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    expect(readSavedDetailPanelWidth('prs', storage)).toBeNull()
    saveDetailPanelWidth('prs', 612.4, storage)
    expect(readSavedDetailPanelWidth('prs', storage)).toBe(612)
    values.set('solus.prs.panel-width', 'wide')
    expect(readSavedDetailPanelWidth('prs', storage)).toBeNull()
  })

  test('a turn opens wider than a review, but a dragged width still wins', () => {
    // WHY: a turn's trace and cards need the room; the list beside it is only
    // navigation. The reader's own drag is theirs on either page.
    expect(detailPanelWidth('insights', null, 1400)).toBe(910)
    expect(detailPanelWidth('insights', 600, 1400)).toBe(600)
    // The list keeps its floor even at the wider default.
    expect(detailPanelWidth('insights', null, 900)).toBe(900 - DETAIL_PANEL_MIN_WIDTH)
  })

  test('each page remembers its own width', () => {
    // WHY: a wide review and a narrow turn are different reading habits; one
    // page's drag must not resize the other's panel.
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    saveDetailPanelWidth('insights', 800, storage)
    expect(readSavedDetailPanelWidth('insights', storage)).toBe(800)
    expect(readSavedDetailPanelWidth('prs', storage)).toBeNull()
  })
})
