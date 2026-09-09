import { describe, expect, test } from 'bun:test'
import {
  showsPrDetailPanel,
  showsPrPageSkeleton,
} from '@solus/workspace-ui/components/prs/lib/pr-list-loading'

describe('pull request page skeleton', () => {
  // WHY: the picker changes which project the page is about. The rows still on
  // screen belong to the project that was left, so showing them under the new
  // title states something untrue about the new scope until its read lands.
  test('a scope switch shows the skeleton even though the old rows are still cached', () => {
    expect(showsPrPageSkeleton('starting', false, 4)).toBe(true)
    expect(showsPrPageSkeleton('reading', true, 4)).toBe(true)
  })

  // WHY: a refresh restates the list already on screen. Blanking rows the
  // reader is looking at — and can act on — to say "still current" is a step
  // backwards, so a refresh is announced in the head band, not by the body.
  test('a refresh of the scope in view keeps its rows', () => {
    expect(showsPrPageSkeleton('idle', true, 4)).toBe(false)
  })

  test('a first read with nothing to show yet is the skeleton', () => {
    expect(showsPrPageSkeleton('idle', true, 0)).toBe(true)
  })

  // WHY: an empty list that is not loading has something to say — no pull
  // requests, no search matches, a failed host — and the skeleton would hide it
  // behind a spinner that never resolves.
  test('an empty list that is not reading falls through to its own surface', () => {
    expect(showsPrPageSkeleton('idle', false, 0)).toBe(false)
  })
})

describe('pull request detail panel', () => {
  test('does not narrow the list for a remembered pull request that is no longer loaded', () => {
    // WHY: an open key can survive a refresh or filter change after its row is
    // gone. Reserving panel width from that key alone leaves the real list in a
    // narrow rail beside a blank page.
    expect(showsPrDetailPanel(false, false)).toBe(false)
    expect(showsPrDetailPanel(true, false)).toBe(false)
    expect(showsPrDetailPanel(true, true)).toBe(true)
  })
})
