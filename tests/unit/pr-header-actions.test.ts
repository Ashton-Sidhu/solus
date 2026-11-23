import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
const root = 'packages/workspace-ui/src/components/pr-review'
const feed = readFileSync(`${root}/ActivityFeed.svelte`, 'utf8')
const pane = readFileSync(`${root}/PrReviewPane.svelte`, 'utf8')
const railActions = readFileSync(`${root}/PrActions.svelte`, 'utf8')

test('the PR header keeps the same merge control when the Activity rail folds', () => {
  // A resize must not change the action's location, selection, or pending state.
  const headerActions = pane.match(/\{#snippet headerActions\(\)\}([\s\S]+?)\{\/snippet\}/)?.[1]
  expect(headerActions).toMatch(/\{#if readiness\}\s*<PrPrimaryAction/)
  expect(pane).toContain('actions={headerActions}')
  expect(pane).toContain('{@render headerActions()}')
  expect(pane).toContain('showRailPrimaryAction={headless}')
  expect(feed).toContain('showPrimaryAction={showRailPrimaryAction}')
  expect(railActions).toMatch(/\{#if hasPrimaryAction\}\s*<PrPrimaryAction/)
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

  test('more room adds labels, link shortcuts, and line counts in order', () => {
    const primary = readFileSync(`${root}/PrPrimaryAction.svelte`, 'utf8')
    const checkout = readFileSync(`${root}/PrCheckoutButton.svelte`, 'utf8')
    const review = readFileSync(`${root}/PrReviewButton.svelte`, 'utf8')
    const overflow = readFileSync(`${root}/PrOverflowMenu.svelte`, 'utf8')
    const labelRung = (source: string) => Number(source.match(/@max-\[(\d+)rem\]\/band:hidden/)?.[1])
    const linkRung = Number(overflow.match(/@min-\[(\d+)rem\]\/band:inline-flex/)?.[1])
    const countsRung = Number(tabs.match(/@min-\[(\d+)rem\]\/band:inline-flex/)?.[1])
    const panelTabRung = labelRung(tabs)
    expect(labelRung(primary)).toBe(labelRung(checkout))
    expect(labelRung(review)).toBe(labelRung(checkout))
    expect(labelRung(primary)).toBe(panelTabRung)
    expect(panelTabRung).toBeLessThan(linkRung)
    expect(linkRung).toBeLessThan(countsRung)
    expect(header).toContain('@max-[30rem]/band:col-span-full')
    expect(pane).toContain('home={embedded ? "band" : "toolbar"}')
  })

  test('a long merge label truncates instead of pushing the close control off the band', () => {
    // WHY: every other band slot is rigid, and the merge label is a readiness
    // headline of any length ("Conflicts with <base>"). If the merge pill is
    // rigid too, a long headline makes the row wider than the band, and the
    // last slots — the ⋯ menu and the ✕ — go past the edge where nobody can
    // reach them. The pill must shrink, and its label must truncate.
    const primary = readFileSync(`${root}/PrPrimaryAction.svelte`, 'utf8')
    const pillBase = primary.match(/data-testid="pr-primary-action"\s*class="([^{"]*)/)?.[1]
    const bandPill = primary.match(/layout === 'band'\s*\?\s*'([^']*)'/)?.[1]
    expect(pillBase).toBeDefined()
    expect(bandPill).toBeDefined()
    expect(pillBase!.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'overflow-hidden']))
    expect(`${pillBase} ${bandPill}`.split(/\s+/)).not.toContain('shrink-0')
    expect(primary).toMatch(/<span class="min-w-0 truncate @max-\[\d+rem\]\/band:hidden">\{running \? runningLabel : action\.short\}/)
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
