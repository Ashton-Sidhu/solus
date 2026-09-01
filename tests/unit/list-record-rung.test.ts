import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The record rung is CSS, so these assert the rules it has to keep rather than
 * the pixels it produces. Each one fails if the *reason* for the rung is
 * removed — a title that goes back to truncating, a branch suppressed on the
 * surface built to show it, a width read from the window instead of the pane.
 */

const COMPONENTS = resolve(import.meta.dir, '../../packages/workspace-ui/src/components')

function source(path: string): string {
  return readFileSync(resolve(COMPONENTS, path), 'utf8')
}

/** The one rung both list surfaces and `pane-width.ts` agree on. */
const RUNG = '@max-[30rem]/pane'

describe('a list row becomes a record rather than a narrower row', () => {
  const listRow = source('ui/list-page/ListRow.svelte')

  it('gives the title its own line instead of a smaller share of one', () => {
    // `basis-full` is what declares the two line breaks. Without it the slots
    // merely wrap wherever the chips happen to run out, which is flexbox
    // arbitrating the layout rather than the layout being stated.
    expect(listRow).toContain(`${RUNG}:basis-full`)
  })

  it('lets the title wrap, but only as far as the row was measured for', () => {
    // `truncate` is nowrap + clip + ellipsis; the record undoes the nowrap so a
    // title reads onto a second line instead of ending in a dot after forty
    // characters. It stops there. The row is positioned by a virtualiser that
    // is handed a height before the browser has laid the title out, so an
    // unbounded title makes that height a guess — and a guessed height paints
    // the row over the one beneath it.
    expect(listRow).toContain(`${RUNG}:whitespace-normal`)
    expect(listRow).toContain(`${RUNG}:line-clamp-2`)
    // The clamp only bounds anything if nothing re-opens the overflow.
    expect(listRow).not.toContain(`${RUNG}:overflow-visible`)
    expect(listRow).not.toContain(`${RUNG}:text-clip`)
  })

  it('reads the pane, never the window', () => {
    // A window read is right on a phone and wrong in a companion pane dragged
    // to its floor — the same 393px problem with a different answer.
    expect(listRow).not.toMatch(/max-\[\d+px\]:/)
    expect(listRow).not.toContain('isMobileViewport')
  })

  it('shows the branch on the record, and suppresses it only in the middle band', () => {
    // Above the band the title has slack to lend on hover; below it the branch
    // has a line of its own. It is only between the two that it has nowhere to
    // go. Stated as one range so nothing depends on compiled sheet order.
    expect(listRow).toContain('@min-[30rem]/pane:@max-[45rem]/pane:hidden')
  })
})

describe('a group of records is bounded, because a record needs an edge', () => {
  const listGroup = source('ui/list-page/ListGroup.svelte')

  it('draws the rows as one card with seams at the record rung only', () => {
    expect(listGroup).toContain(`${RUNG}:rounded-xl`)
    expect(listGroup).toContain(`${RUNG}:[&>*+*]:border-t`)
  })

  it('uses the shadow type hint, so the card is not evicted by a stock shadow', () => {
    // `shadow-[var(--x)]` is filed under shadow-*colour* by tailwind-merge and
    // loses to any `shadow-*` beside it; the hint classifies it correctly.
    expect(listGroup).toContain('shadow-[shadow:var(--elev-ring)]')
  })
})

describe('the ledger row keeps the body the peek can no longer show', () => {
  const workspaceRow = source('workspace/WorkspaceRow.svelte')

  it('spends line 2 on the snippet, and drops it where the title is enough', () => {
    expect(workspaceRow).toContain('item.snippet && !item.pinned')
    expect(workspaceRow).toContain(`${RUNG}:line-clamp-2`)
  })

  it('hangs the snippet and the meta line under the title, not under the glyph', () => {
    // A wrapping row puts line two back at the row's left edge, level with the
    // glyph, so the record reads as three unrelated lines. Two columns with the
    // glyph in the first is what makes it one record — and it is declared in
    // CSS, so a wide pane pays for no spacer elements it then has to hide.
    expect(workspaceRow).toContain(`${RUNG}:grid`)
    expect(workspaceRow).toContain(`${RUNG}:grid-cols-[1rem_minmax(0,1fr)]`)
    expect(workspaceRow).toContain(`${RUNG}:col-start-2`)
    expect(workspaceRow).not.toContain(`${RUNG}:before:basis-full`)
  })

  it('keeps the trailing fields as columns above the rung and one line below it', () => {
    // `display: contents` is what lets one definition be four columns beside
    // each other and a single meta line under the title, with no second copy of
    // the four fields for a wide pane to hide.
    expect(workspaceRow).toContain('class="contents ')
  })

  it('drops one of the two dates, so the record never states the age twice', () => {
    expect(workspaceRow).toContain(`${RUNG}:hidden`)
  })
})

describe('the pull request meta band breaks instead of truncating the branch', () => {
  const metaBand = source('pr-review/PrMetaBand.svelte')

  it('gives Branch a row of its own and lets the ref wrap in it', () => {
    // The 26ch cap exists to stop the head ref pushing Files and Changes off
    // the line. On its own row there is nothing left to push.
    expect(metaBand).toContain(`${RUNG}:basis-full`)
    expect(metaBand).toContain(`${RUNG}:max-w-none`)
    expect(metaBand).toContain(`${RUNG}:break-all`)
  })

  it('splits the row under it between the two remaining cells', () => {
    expect(metaBand).toContain(`${RUNG}:flex-1`)
    expect(metaBand).toContain(`${RUNG}:basis-0`)
  })
})
