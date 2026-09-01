import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { showsPrPageSkeleton } from '@solus/workspace-ui/components/prs/lib/pr-list-loading'

const workspaceUi = join(import.meta.dir, '../../packages/workspace-ui/src/components')

describe('pull request page skeleton', () => {
  // WHY: a route-module fallback followed by a data fallback makes one page
  // appear to enter two loading states. The page must own the only state in
  // both shells, and that state must use the full PR page skeleton.
  test('the page owns the only loading state in Editor and Pill modes', () => {
    const pane = readFileSync(join(workspaceUi, 'ui/Pane.svelte'), 'utf8')
    const pill = readFileSync(join(workspaceUi, 'layout/PillLayout.svelte'), 'utf8')
    const page = readFileSync(join(workspaceUi, 'prs/PrsPage.svelte'), 'utf8')

    expect(pane).not.toContain('import("../prs/PrsPage.svelte")')
    expect(pill).not.toContain('import("../prs/PrsPage.svelte")')
    expect(pane).not.toContain('PrsPageSkeleton')
    expect(pill).not.toContain('PrsPageSkeleton')
    expect(page).toContain('<PrsPageSkeleton />')
    expect(page).not.toContain('<ListSkeleton')
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
