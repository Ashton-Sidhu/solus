import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  CONTENT_GUTTER,
  RAIL_FOLD_MAX,
  isRailFolded,
  isRailFoldedInPane,
} from '@solus/workspace-ui/components/pr-review/lib/rail-rows'

/**
 * Once the pull request's rail has folded, the merge control has one home:
 * the pane's chrome band, beside Review and Check out. The band decides from
 * the pane's own width, so the answer must be the rail's answer, read off the
 * same row.
 */

const root = 'packages/workspace-ui/src/components/pr-review'
const feed = readFileSync(`${root}/ActivityFeed.svelte`, 'utf8')
const pane = readFileSync(`${root}/PrReviewPane.svelte`, 'utf8')
const rail = readFileSync(`${root}/PrActivityRail.svelte`, 'utf8')

describe('the folded rail hands the move to the band', () => {
  test('the pane folds exactly when the content row does', () => {
    // WHY: two rungs for one fold would leave a band of pane widths with a
    // merge button in both homes, or in neither. The pane's answer is the
    // row's answer plus the gutter the row pads itself with.
    const contentWidth = RAIL_FOLD_MAX
    expect(isRailFoldedInPane(contentWidth + CONTENT_GUTTER)).toBe(isRailFolded(contentWidth))
    expect(isRailFoldedInPane(contentWidth + CONTENT_GUTTER + 1)).toBe(isRailFolded(contentWidth + 1))
    expect(isRailFoldedInPane(0)).toBe(false)
  })

  test('the gutter the pane takes off is the gutter the row pads', () => {
    // WHY: the gutter is a Tailwind literal on the row and a number here. If
    // one moves without the other, the band's fold drifts from the rail's.
    const padding = feed.match(/class="@container [^"]*\bpx-\[(\d+)px\]/)
    expect(padding).not.toBeNull()
    expect(Number(padding![1]) * 2).toBe(CONTENT_GUTTER)
  })

  test('the band carries the move once folded, and the page draws no second one', () => {
    // WHY: the reverse-state guarantee. A narrow pane still lands the pull
    // request from its first screen, and only from one control, so a click
    // cannot leave a stale twin behind.
    expect(pane).toMatch(/\{#if railFolded && readiness\}\s*<PrPrimaryAction/)
    expect(pane.match(/\{@render mergeButton\(\)\}/g)).toHaveLength(2)
    expect(feed).not.toContain('<PrPrimaryAction')
    expect(rail).not.toContain('actions("row"')
  })
})

describe('the view tabs stay reachable at every width', () => {
  const header = readFileSync(`${root}/PrPanelHeader.svelte`, 'utf8')
  const tabs = readFileSync(`${root}/PrViewTabs.svelte`, 'utf8')

  test('where the tab row hides, the switcher shows, and it lists every tab', () => {
    // WHY: a hidden tab is a hidden destination. The row may fold into a
    // switcher only if the switcher appears at that same rung, in each of the
    // group's homes, and its menu walks the same list the row does.
    const hideRungs = [...tabs.matchAll(/@max-\[(\d+)rem\]\/band:hidden/g)].map((m) => m[1])
    const showRungs = [...tabs.matchAll(/@max-\[(\d+)rem\]\/band:inline-flex/g)].map((m) => m[1])
    expect(hideRungs.length).toBeGreaterThan(0)
    expect(showRungs).toEqual(hideRungs)
    expect(tabs.match(/\{#each TABS as t \(t\.id\)\}/g)).toHaveLength(2)
  })

  test('in the band the tabs fold before the row is tight, and before the verbs drop their labels', () => {
    // WHY: the band without a single tab already needs about 22rem once the
    // labels are gone, and the five tabs about 19rem more. A rung under that
    // sum leaves a band of widths where the row overflows and the overflow
    // menu and the close control are pushed off the edge.
    const bandRung = Number(tabs.match(/home === 'band'\s*\?\s*'@max-\[(\d+)rem\]\/band:hidden'/)?.[1])
    const mastheadRung = Number(tabs.match(/:\s*'@max-\[(\d+)rem\]\/band:hidden'/)?.[1])
    expect(bandRung).toBeGreaterThanOrEqual(42)
    expect(bandRung).toBeLessThanOrEqual(52)
    expect(mastheadRung).toBeLessThan(bandRung)
    expect(readFileSync(`${root}/PrDetailMasthead.svelte`, 'utf8')).toContain('home="masthead"')
  })

  test('the band row stays one line: the merge pill drops its label where its neighbours do', () => {
    // WHY: the tabs and every verb share the band row down to the phone rung.
    // That holds only if the merge pill gives what Review and Check out give
    // at 52rem — its label — and keeps its glyph, so the row never needs a
    // second line above the phone.
    const primary = readFileSync(`${root}/PrPrimaryAction.svelte`, 'utf8')
    const checkout = readFileSync(`${root}/PrCheckoutButton.svelte`, 'utf8')
    const labelRung = (source: string) => source.match(/@max-\[(\d+)rem\]\/band:hidden/)?.[1]
    expect(labelRung(primary)).toBe(labelRung(checkout))
    expect(primary).toContain('action.short')
    // The band never stacks: no rung turns the row into a column.
    expect(header).not.toMatch(/@max-\[[^\]]+\]\/band:flex-col/)
  })
})

describe('a pull request has one ⋯ menu', () => {
  test('the band carries it, and Activity draws it only for a host with no band', () => {
    // WHY: two ⋯ menus on one screen split the pull request's commands and
    // repeat some of them. The band holds the one menu in both shapes; only
    // Review Mode (headless, no band) hands it to the Activity status card.
    const header = readFileSync(`${root}/PrPanelHeader.svelte`, 'utf8')
    expect(pane.match(/<PrOverflowMenu\b/g)).toHaveLength(1)
    expect(pane).toContain('menu={overflowMenu}')
    expect(pane.match(/\{@render overflowMenu\(\)\}/g)).toHaveLength(1)
    expect(pane).toContain('menu={headless ? overflowMenu : undefined}')
    expect(header).not.toMatch(/import .*OverflowMenu/)
    expect(feed).not.toMatch(/import .*OverflowMenu/)
    expect(feed).toMatch(/\{#if railFolded && menu\}\s*\{@render menu\(\)\}/)
  })
})
