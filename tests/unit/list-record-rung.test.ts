import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LIST_RECORD_CARD_HEIGHT,
  LIST_RECORD_ROW_HEIGHT,
  listRowHeight,
} from '@solus/workspace-ui/components/ui/list-page/list-page'

/**
 * The record rung (`@max-[30rem]/pane`) is the phone's list, and two of its
 * rules are the kind a stylesheet can break silently.
 *
 * The first is arithmetic. A record is now a card, and the virtualiser is told
 * a slot height *before* the browser lays the card out — so the card states its
 * own height and the slot is that height plus the gutter between cards. If the
 * two drift apart the failure is invisible in review and obvious on a phone:
 * either the cards touch and two records read as one, or a two-line title
 * paints over the card beneath it.
 *
 * The second is reachability. At this rung the page head gives the page title
 * the whole line, which it can only afford because the ✕ stands down — the
 * phone shell renders one pane and the drawer is the way out. If the ✕ comes
 * back without the title giving up its width, the crumb squeezes it below the
 * touch floor again, which is the defect this rung was written to fix.
 */

const UI = join(import.meta.dir, '../../packages/workspace-ui/src/components/ui/list-page')
const source = (file: string) => readFileSync(join(UI, file), 'utf8')

const RECORD = '@max-[30rem]/pane'

describe('the record card and its slot', () => {
  it('leaves a gutter between cards rather than fusing them', () => {
    expect(LIST_RECORD_ROW_HEIGHT).toBeGreaterThan(LIST_RECORD_CARD_HEIGHT)
    // Enough to read as a gap at arm's length, not so much that the list
    // becomes a scroll of mostly background.
    expect(LIST_RECORD_ROW_HEIGHT - LIST_RECORD_CARD_HEIGHT).toBeGreaterThanOrEqual(8)
    expect(LIST_RECORD_ROW_HEIGHT - LIST_RECORD_CARD_HEIGHT).toBeLessThanOrEqual(16)
  })

  it('states the same card height in the stylesheet that the slot reserves', () => {
    // The one number that cannot be inferred from the class list at build time.
    // A card taller than this clips its second title line; shorter, and the
    // gutter grows by the difference on every row.
    expect(source('ListRow.svelte')).toContain(`${RECORD}:h-[${LIST_RECORD_CARD_HEIGHT}px]`)
  })

  it('reserves that slot for every list that draws the record', () => {
    expect(listRowHeight({ record: true, split: false })).toBe(LIST_RECORD_ROW_HEIGHT)
    // The task list draws the drawer row instead, and is deliberately shorter.
    expect(listRowHeight({ record: true, split: false, drawerRow: true })).toBeLessThan(
      LIST_RECORD_ROW_HEIGHT,
    )
  })
})

describe('the record page head', () => {
  const crumbLine = source('PageCrumbLine.svelte')

  it('drops the close control, whose width the page title now takes', () => {
    // Asserted on the ✕'s own wrapper rather than anywhere in the file: the
    // pane-swap control above it carries the same rule for its own reason, so
    // a bare substring search would pass with the ✕ still rendered.
    const closeBlock = crumbLine.slice(crumbLine.indexOf('{#if onClose}'))
    expect(closeBlock).toContain(`${RECORD}:hidden`)
  })

  it('keeps the project switcher on the line, moved past the title', () => {
    // Reachability, not decoration: scope is changed here and nowhere else on
    // the page, so hiding it at this rung would strand a phone on one project.
    expect(crumbLine).not.toMatch(/ListProjectSwitcher[\s\S]{0,400}@max-\[30rem\]\/pane:hidden/)
    expect(crumbLine).toContain(`${RECORD}:order-8`)
  })

  it('gives the page name the title rung instead of a crumb segment', () => {
    expect(source('PageCrumbMenu.svelte')).toContain(`${RECORD}:text-[17px]`)
  })
})

const COMPONENTS = join(import.meta.dir, '../../packages/workspace-ui/src/components')

/**
 * Every band that heads a record: the pull request review, the local review,
 * and the shared sub page crumb. All three were built for a panel *beside*
 * something, so all three put their exit last on a row of six-to-eight slots —
 * and on a phone that row overflows and the exit is the control that falls off
 * the end. Each one now leads with a back control instead.
 */
const BANDS = [
  {
    name: 'pull request review',
    file: 'pr-review/PrPanelHeader.svelte',
    rung: '@max-[30rem]/band',
    back: 'aria-label="Back to pull requests"',
    exit: 'aria-label="Close pull request"',
    cluster: 'The one place a divider used to be',
  },
  {
    name: 'local review',
    file: 'diff/ReviewPanelHeader.svelte',
    rung: '@max-[30rem]/band',
    back: 'aria-label="Back to conversation"',
    exit: 'data-testid="review-panel-close"',
    cluster: 'The one place a divider used to be',
  },
  {
    name: 'sub page crumb',
    file: 'ui/list-page/SubPageCrumbLine.svelte',
    rung: '@max-[30rem]/pane',
    back: 'ParentPageCrumb',
    exit: 'closeLabel',
    cluster: '{#if hasWindowControls}',
  },
] as const

describe.each(BANDS)('the $name band on a record', (band) => {
  const text = readFileSync(join(COMPONENTS, band.file), 'utf8')

  it('leads with a back control rather than trailing an exit that clips', () => {
    expect(text).toContain(band.back)
    // The exit must come after the back control in the row, and must be the one
    // that stands down — not the other way round.
    expect(text.indexOf(band.back)).toBeLessThan(text.lastIndexOf(band.exit))
  })

  it('stands the pane cluster down, since a record has one pane', () => {
    const cluster = text.slice(text.indexOf(band.cluster))
    expect(text).toContain(band.cluster)
    expect(cluster).toContain(`${band.rung}:hidden`)
  })
})

describe('a band that queries its own width', () => {
  it('never declares the container it queries', () => {
    // `@container/band` and `@…/band:` on one class list is a rule that never
    // fires and never warns: an element is not its own container. Both review
    // bands shipped that way, so every rung they declared for their own
    // geometry was dead while their children's rungs worked — which is exactly
    // why nobody noticed.
    for (const file of ['pr-review/PrPanelHeader.svelte', 'diff/ReviewPanelHeader.svelte']) {
      const declaring = readFileSync(join(COMPONENTS, file), 'utf8')
        .split('\n')
        .filter((line) => line.includes('@container/band'))
      expect(declaring.length).toBeGreaterThan(0)
      for (const line of declaring) expect(line).not.toContain('/band:')
    }
  })
})

/**
 * The two work shells put the shared `ParentPageCrumb` in a chrome row of their
 * own. That crumb becomes a 44px back chevron at the record rung and the header
 * actions grow to 44px on a coarse pointer — two different reasons for the row
 * to be taller than the 40px chrome height, neither of which is the OS window.
 * Both shells used to state a fixed height with a `max-width: 767px` escape,
 * which is the stale-branch shape: a shell in a 356px companion pane on a wide
 * monitor kept the fixed height and clipped its own controls.
 */
describe.each([
  { name: 'artifact', file: 'artifact/ArtifactShell.svelte', fixed: 'max-md:' },
  { name: 'diagram', file: 'diagram/DiagramShell.css', fixed: 'max-width: 767px' },
])('the $name shell chrome row', (shell) => {
  const text = readFileSync(join(COMPONENTS, shell.file), 'utf8')

  it('sizes on a floor rather than a fixed height', () => {
    expect(text).toMatch(/min-h(-\[|eight:)/)
  })

  it('does not decide its height from the OS window', () => {
    // Comments are blanked first, the way `check-layout-discipline` does it, so
    // the note explaining what this replaced does not read as the thing itself.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    expect(code).not.toContain(shell.fixed)
  })
})

describe('the Insights page head', () => {
  it('opens the band to fit the touch controls the crumb line puts in it', () => {
    // `--solus-chrome-row-h` is 40px, so this header computed to a 36px box
    // while the crumb line's drawer and page-title controls are 44px each.
    const head = readFileSync(join(COMPONENTS, 'insights/InsightsPage.svelte'), 'utf8')
    expect(head).toContain('@max-[30rem]/pane:h-14!')
  })
})
