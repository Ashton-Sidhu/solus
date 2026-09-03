import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  showsPrDetailPanel,
  showsPrPageSkeleton,
} from '@solus/workspace-ui/components/prs/lib/pr-list-loading'

const workspaceUi = join(import.meta.dir, '../../packages/workspace-ui/src/components')

describe('pull request page skeleton', () => {
  // WHY: a route-module fallback followed by a data fallback makes one page
  // appear to enter two loading states. What a reader must never see is the
  // *transition* between them — one silhouette replaced by a different one
  // before any pull request has arrived.
  //
  // The page used to be imported eagerly to guarantee that, which put its whole
  // review stack (PrReviewPane -> DiffPanel + DocumentEditor, ~3 MB of Tiptap
  // and diff machinery) on the boot path of every launch, worth 180 ms of
  // startup. It is now lazy like every other route, and the guarantee is met
  // the other way: whatever covers the module load must be the same skeleton
  // the page draws for its own read, so the two states are indistinguishable.
  test('both loading states of the PR page draw the same skeleton', () => {
    const pane = readFileSync(join(workspaceUi, 'ui/Pane.svelte'), 'utf8')
    const pill = readFileSync(join(workspaceUi, 'layout/PillLayout.svelte'), 'utf8')
    const page = readFileSync(join(workspaceUi, 'prs/PrsPage.svelte'), 'utf8')

    // The page's own data-loading state, and the only silhouette it may use.
    expect(page).toContain('<PrsPageSkeleton />')
    expect(page).not.toContain('<ListSkeleton')

    // Editor and web reach the page through the route outlet, so the outlet
    // covers the module load — with that same skeleton and no other.
    expect(pane).toContain('<PrsPageSkeleton />')
    // Pill renders the page directly and so crosses no module boundary; a
    // skeleton there would be a second state with nothing to cover.
    expect(pill).not.toContain('PrsPageSkeleton')
  })

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
