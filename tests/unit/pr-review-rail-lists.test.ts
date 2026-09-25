import { describe, expect, test } from 'bun:test'
import type { ChangedFileStat } from '@solus/contracts/types'
import type { CheckItem } from '@solus/contracts/checks-types'
import {
  FILES_VISIBLE_ROWS,
  fileRowHeight,
  listViewportHeight,
} from '@solus/workspace-ui/components/pr-review/lib/rail-rows'
import { checksSummary } from '@solus/workspace-ui/components/pr-review/lib/check-verdict'

/**
 * The rail's Changed files section is virtualized, so its
 * geometry is arithmetic rather than layout: the list positions each row from
 * the number these functions return, and the row is given that same number as
 * its height. Everything that can go wrong here is silent — overlapping rows,
 * a scrollport that hides its own overflow — so it is asserted directly.
 */

function file(path: string): ChangedFileStat {
  return { path, additions: 1, deletions: 0, status: 'M' }
}

describe('changed-file row heights', () => {
  test('a root file takes the short row, a nested one the tall row', () => {
    // WHY: the row is two lines — filename over directory — but a file at the
    // repository root has no directory to put under it. Giving it the tall
    // height anyway leaves a blank half-row; giving a nested file the short one
    // clips its directory. The list is told the same number either way, so a
    // wrong answer here overlaps every row below it.
    expect(fileRowHeight(file('bun.lock'))).toBeLessThan(
      fileRowHeight(file('web/src/routes/+page.svelte')),
    )
  })
})

describe('the section scrollport', () => {
  test('a short list takes exactly its own height and never scrolls', () => {
    // WHY: most pull requests touch a handful of files. Reserving a fixed
    // scrollport for them would leave dead space under a two-row list and put
    // a scroll region around content that entirely fits.
    const rows = [44, 30, 44]
    expect(listViewportHeight(rows, FILES_VISIBLE_ROWS)).toBe(118)
  })

  test('a list exactly at the cap still does not scroll', () => {
    const rows = Array.from({ length: FILES_VISIBLE_ROWS }, () => 30)
    expect(listViewportHeight(rows, FILES_VISIBLE_ROWS)).toBe(
      FILES_VISIBLE_ROWS * 30,
    )
  })

  test('a long list cuts the next row in half rather than on a row seam', () => {
    // WHY: VirtualList pins `scrollbar-width: none`, so a viewport cut to a
    // whole number of rows gives a reader no signal that there is more below —
    // the list simply appears to end at seven files when there are forty. A row
    // sliced by the fold is the only "keep scrolling" cue that survives a
    // hidden scrollbar.
    const rows = Array.from({ length: 40 }, () => 30)
    const height = listViewportHeight(rows, FILES_VISIBLE_ROWS)
    expect(height).toBe(FILES_VISIBLE_ROWS * 30 + 15)
    expect(height % 30).not.toBe(0)
  })

  test('the peeking row is measured, not assumed', () => {
    // The changed-file list mixes short and tall rows, so the half-row depends
    // on which row actually lands at the fold.
    const rows = [...Array.from({ length: FILES_VISIBLE_ROWS }, () => 44), 30]
    expect(listViewportHeight(rows, FILES_VISIBLE_ROWS)).toBe(
      FILES_VISIBLE_ROWS * 44 + 15,
    )
  })

  test('an empty section asks for no height at all', () => {
    // VirtualList renders nothing at height 0, which is what collapses a
    // section with no rows instead of leaving an empty box under its heading.
    expect(listViewportHeight([], FILES_VISIBLE_ROWS)).toBe(0)
  })
})

function check(conclusion: CheckItem['conclusion'], inFlight = false): CheckItem {
  return {
    id: Math.random().toString(36),
    name: 'ci',
    conclusion,
    inFlight,
    detailsUrl: null,
    appName: null,
    startedAt: null,
    completedAt: null,
  }
}

describe('the folded Checks summary', () => {
  // WHY: Checks start folded, so this one line is all most readers see. It
  // must never call a pull request green while something is broken or still
  // running.
  test('a failure leads, even while other checks run', () => {
    expect(checksSummary([check('success'), check('failure'), check(null, true)])).toEqual({
      text: '1 of 3 failing',
      icon: 'failed',
    })
  })

  test('running and queued checks keep it from saying passed', () => {
    expect(checksSummary([check('success'), check(null, true), check(null)])).toEqual({
      text: '2 of 3 running',
      icon: 'running',
    })
  })

  test('skipped and neutral checks do not block the all-clear', () => {
    expect(checksSummary([check('success'), check('skipped'), check('neutral')])).toEqual({
      text: 'All checks passed',
      icon: 'passed',
    })
  })
})
