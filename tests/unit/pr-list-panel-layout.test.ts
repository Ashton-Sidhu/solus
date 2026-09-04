import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const page = readFileSync(
  resolve(import.meta.dir, '../../packages/workspace-ui/src/components/prs/PrsPage.svelte'),
  'utf8',
)
const toolbar = readFileSync(
  resolve(import.meta.dir, '../../packages/workspace-ui/src/components/prs/PrListToolbar.svelte'),
  'utf8',
)
const filterSubmenu = readFileSync(
  resolve(import.meta.dir, '../../packages/workspace-ui/src/components/prs/PrFilterSubmenu.svelte'),
  'utf8',
)
const listPage = readFileSync(
  resolve(import.meta.dir, '../../packages/workspace-ui/src/components/ui/list-page/ListPage.svelte'),
  'utf8',
)

describe('the pull request list header', () => {
  it('is one toolbar in every shape the list takes', () => {
    // WHY: the full page and the navigation column beside an open detail
    // used to draw two different narrowing rows — a chip band that clipped in
    // a narrow pane, and a compact toolbar. One row now serves both, so the
    // reader never relearns where search, sort, and filters are.
    expect(page).toContain('<PrListToolbar')
    expect(page).not.toContain('<ListFilterBar')
    expect(page).not.toContain('<ListStatusMenu')
    expect(page).not.toContain('<ListScopeMenu')
    expect(page).not.toContain('<SortMenu')
    expect(toolbar).toContain('>Sort</span>')
    expect(toolbar).toContain('>Filters</span>')
    // The reference's facet rows are one stable, keyboard-navigable submenu
    // list. Project is intentionally absent because project scope is selected
    // by the page switcher, not repeated as a filter.
    expect(toolbar).toContain('{#each filterGroups as group, index (group.key)}')
    expect(toolbar).toContain('<DropdownMenu.SubTrigger>')
    expect(page).toContain('key: "state"')
    expect(page).toContain('key: "involvement"')
    expect(page).toContain('key: "author"')
    expect(page).toContain('key: "labels"')
    expect(page).toContain('key: "draft"')
    expect(page).toContain('key: "review"')
    expect(page).toContain('key: "checks"')
    expect(toolbar).not.toContain('ProjectFavicon')
    expect(toolbar).not.toContain('projectOptions')
    expect(page).toContain('prInboxGroups(filtered, rowContext')
    expect(filterSubmenu).toContain('placeholder={`Search ${group.label.toLowerCase()}`}')
    expect(filterSubmenu).toContain('option.avatarUrl')
    expect(filterSubmenu).toContain('option.color')
    expect(filterSubmenu).toContain(
      'size-2.5 shrink-0 rounded-full bg-[color-mix(in_oklch,var(--label-color)_42%,var(--background))] pointer-fine:[.is-laptop-display_&]:size-2',
    )
    expect(filterSubmenu).toContain('style="--label-color: {option.color}"')
    expect(filterSubmenu).not.toContain('size-3.5 shrink-0 rounded-full')
    expect(page).toContain('{ value: "draft", label: "Drafts only"')
    expect(page).toContain('{ value: "approved", label: "Approved"')
    expect(page).toContain('{ value: "changes-requested", label: "Changes requested"')
    expect(page).toContain('{ value: "review-required", label: "Review required"')
    expect(page).toContain('{ value: "no-reviews", label: "No reviews"')
  })

  it('drops the crumb, keeps refresh on the row, beside an open detail', () => {
    // WHY: the detail owns the visible header while it is open. Leaving the
    // list crumb mounted below it produces a second project / Pull requests
    // row — and with the crumb gone, refresh has nowhere else to live.
    expect(page).toContain('hideHeader={panelOpen}')
    expect(page).toContain('pageSwitcherEnabled={!splitList}')
    expect(page).toContain('onRefresh={splitList ? refreshList : undefined}')
    expect(toolbar).toContain('{#if onRefresh}')
    expect(toolbar).toContain('aria-label={refreshing ? "Refreshing pull requests"')
  })

  it('declares a ladder against the pane instead of clipping', () => {
    // WHY: the chip band overflowed a narrow pane with the last chip
    // unreachable. The toolbar's menus give up their labels under 40rem and
    // the row wraps onto its own line at the record rung; nothing unmounts.
    expect(toolbar).toContain('<span class="@max-[40rem]/pane:hidden">Sort</span>')
    expect(toolbar).toContain('<span class="@max-[40rem]/pane:hidden">Filters</span>')
    expect(toolbar).toContain('@max-[30rem]/pane:order-3 @max-[30rem]/pane:basis-full')
    expect(toolbar).not.toMatch(/window\.innerWidth|isMobileViewport|isCompactViewport/)
  })

  it('reserves the right side for responsive, viewport-bounded submenus', () => {
    // WHY: Filters sits at the window's right edge. Without moving its first
    // column left, collision handling has no room and flips every submenu to
    // the left. The two-column cascade must read in its natural direction.
    expect(toolbar).toContain('alignOffset={400}')
    expect(toolbar).toContain('w-64 pointer-fine:[.is-laptop-display_&]:w-56')
    expect(filterSubmenu).toContain("'w-96 pointer-fine:[.is-laptop-display_&]:w-80'")
    expect(filterSubmenu).toContain("'w-80 pointer-fine:[.is-laptop-display_&]:w-72'")
    expect(filterSubmenu).toContain("'w-72 pointer-fine:[.is-laptop-display_&]:w-60'")
    expect(filterSubmenu).toContain('--bits-dropdown-menu-content-available-height')
    expect(filterSubmenu).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain')
  })

  it('states the toolbar row height on the page as well as the split rail', () => {
    // WHY: the list shell reserved a 30px chip row (26px on a laptop display)
    // under the crumb; a 32px toolbar overflowed it and the skeleton landed on
    // a different y than the real page.
    expect(page).toContain('toolbarFilters')
    expect(listPage).toContain("{split || toolbarFilters\n          ? 'h-8 pb-[14px]'")
  })
})
