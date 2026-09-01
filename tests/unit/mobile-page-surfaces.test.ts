import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The Mobile Redesign spec's page surfaces, asserted by the rule each one keeps
 * rather than by the pixels it produces.
 *
 * Two rungs appear here, and they are not interchangeable. A page renders in a
 * pane, so it asks the `pane` container how much width it has — the same
 * question a companion pane dragged to its floor answers differently from a
 * phone. A picker is portalled to the window and sized against it, so it asks
 * the window. Swapping one for the other is the defect these guard.
 */

const COMPONENTS = resolve(import.meta.dir, '../../packages/workspace-ui/src/components')

function source(path: string): string {
  return readFileSync(resolve(COMPONENTS, path), 'utf8')
}

/** The pane rung both list surfaces and `pane-width.ts` agree on. */
const RUNG = '@max-[30rem]/pane'

describe('the workspace ledger reads as records in cards on a phone', () => {
  const page = source('workspace/WorkspacePage.svelte')

  it('bounds each group, because a run of records needs an edge', () => {
    // The same card the list pages' ListGroup draws, and the same shadow type
    // hint — without it tailwind-merge files the ring under shadow-colour and a
    // stock shadow evicts it.
    expect(page).toContain(`${RUNG}:rounded-xl`)
    expect(page).toContain(`${RUNG}:[&>*+*]:border-t`)
    expect(page).toContain(`${RUNG}:shadow-[shadow:var(--elev-ring)]`)
  })

  it('wraps the rows without adding a box a wide pane has to undo', () => {
    // `display: contents` above the rung leaves the rows as the ledger's own
    // children, so the card costs the desktop layout nothing.
    expect(page).toContain('class="contents ')
  })

  it('keeps one New menu, so one open flag can never open two', () => {
    // Both call sites bind the same `newMenuOpen`. Mounting them together would
    // raise two menus from one press, which is why the head and the filter row
    // are a `stacked` branch rather than a pair of CSS-hidden twins.
    expect(page.match(/<DropdownMenu\.Root bind:open=\{newMenuOpen\}/g)?.length).toBe(1)
    expect(page).toContain('{#snippet newMenu(')
    expect(page).toContain('{#if stacked}')
  })

  it('offers the axes the chip row cannot show, rather than dropping them', () => {
    // Type is chips because type is the axis a reader changes; time, status,
    // the saved views and sort are one axis further out and live in a sheet.
    // Hiding them without a way in would be a capability the phone lacks.
    expect(page).toContain('filterSheetOpen')
    expect(page).toContain('narrowedBeyondType')
  })

  it('reads the pane, never the window', () => {
    expect(page).toContain('observePaneWidth')
    expect(page).not.toMatch(/max-\[\d+px\]:/)
  })
})

describe('the workspace peek sheet carries what the record dropped', () => {
  const row = source('workspace/WorkspaceRow.svelte')
  const peek = source('workspace/WorkspacePeek.svelte')
  const sheet = source('ui/bottom-sheet/bottom-sheet.svelte')

  it('takes pin and delete off the record', () => {
    // A finger cannot hover, so a pointer-revealed control on a record has to
    // become a permanent target crowding the one target that matters.
    expect(row).toContain(`${RUNG}:hidden`)
  })

  it('and puts both in the sheet the tap raises', () => {
    // Pin is a state you can enter, so the sheet is the way back out of it.
    expect(peek).toContain('onTogglePin')
    expect(peek).toContain('onDelete')
    expect(peek).toContain('aria-pressed={item.pinned}')
  })

  it('keeps the sheet above its dismiss backdrop, so its Open button receives the tap', () => {
    expect(sheet).toContain('z-50 bg-black/45')
    expect(sheet).toContain('z-[51]')
  })
})

describe('the task page is a phone page, not a narrowed desktop one', () => {
  const page = source('tasks/task-page/TaskPage.svelte')
  const recordBar = source('tasks/task-page/TaskRecordBar.svelte')
  const strip = source('tasks/task-page/TaskTabStrip.svelte')
  const sidebarStyles = readFileSync(
    resolve(COMPONENTS, 'tasks/task-page/lib/sidebar-styles.ts'),
    'utf8',
  )

  it('replaces the crumb and its six round controls with one overflow', () => {
    // Six 26px targets and an upstream pill do not survive 393px. Everything
    // they held is still reachable — from a menu instead of a strip — and the
    // page picks a head rather than one head hiding half of itself.
    expect(page).toContain('<TaskRecordBar')
    expect(page).toContain('<TaskChromeBar')
    expect(recordBar).toContain('aria-label="Task actions"')
    expect(recordBar).toContain('aria-label="Back to tasks"')
  })

  it('leaves nothing the wide bar reaches out of the record bar’s menu', () => {
    // A control dropped rather than moved is a capability the phone lacks.
    for (const handler of ['onSync', 'onPrevious', 'onNext', 'onOpenSource', 'onOpenPage']) {
      expect(recordBar).toContain(handler)
    }
  })

  it('marks the current section with a seam, not a filled pill', () => {
    // The strip is the page's spine at this rung. Filled pills beside the
    // filter chips the sections use would read as four more filters.
    expect(strip).toContain('shadow-[inset_0_-2px_0_var(--primary)]')
  })

  it('gives the sidebar one rhythm per home and no second copy of a row', () => {
    // The sheet is portalled to the body, so a container query never reaches
    // it — this boolean is what stands in for one.
    expect(sidebarStyles).toContain('export const row = (sheet: boolean)')
    expect(sidebarStyles).toContain('export const group = (sheet: boolean)')
  })
})

describe('a menu anchored to a chip stays on the screen it is anchored in', () => {
  const switcher = source('ui/list-page/ListProjectSwitcher.svelte')

  it('clamps its width to the window rather than pinning 308px', () => {
    // A menu wider than the phone cannot be positioned onto it from either side.
    expect(switcher).toContain('w-[min(19.25rem,calc(100vw-2rem))]')
    expect(switcher).not.toContain('w-[308px]')
  })

  it('opens from the leading edge below the phone rung', () => {
    // Hung from the right edge of a chip 18px in from the left, the whole menu
    // painted at x=-199: it opened, and nothing appeared to happen.
    expect(switcher).toContain('max-[30rem]:right-auto max-[30rem]:left-0')
  })
})

describe('the shared list pages fit the phone they are drawn on', () => {
  const filterBar = source('ui/list-page/ListFilterBar.svelte')
  const listPage = source('ui/list-page/ListPage.svelte')
  const filterStyles = readFileSync(
    resolve(COMPONENTS, 'ui/list-page/filter-styles.ts'),
    'utf8',
  )
  const listLib = readFileSync(resolve(COMPONENTS, 'ui/list-page/list-page.ts'), 'utf8')

  it('breaks the narrowing row in two rather than running off the pane', () => {
    // One line cannot hold a search field and five chips at 393px. Tasks ran
    // 484px past the edge, and the last chip — a status menu — was unreachable.
    expect(listPage).toContain(`${RUNG}:flex-wrap`)
    expect(filterBar).toContain(`${RUNG}:basis-full`)
    expect(filterBar).toContain(`${RUNG}:flex-col`)
  })

  it('marks the wrapped row `!`, because the monitor outranks the pane', () => {
    // `[.is-laptop-display_&]:h-[26px]` is two selectors to the rung's one, so
    // specificity hands it the win and the row wraps inside a 26px box — with
    // the list underneath painting straight through it.
    expect(listPage).toContain(`${RUNG}:h-auto!`)
  })

  it('scrolls the chips it cannot fit, and says so', () => {
    expect(filterStyles).toContain(`${RUNG}:overflow-x-auto`)
    expect(filterStyles).toContain('mask-image:linear-gradient')
  })

  it('tells the virtualiser the record is taller, from one definition', () => {
    // A virtualiser positions rows by a number, so the record rung is one of
    // the few places CSS cannot make the call. Sized at the desktop's 44 the
    // rows overlapped by 51px each.
    expect(listLib).toContain('export function listRowHeight')
    for (const page of [source('tasks/TasksPage.svelte'), source('prs/PrsPage.svelte')]) {
      // The pane, never the window — a companion pane dragged to its floor is
      // the same 393px problem with a different answer.
      expect(page).toContain('isStackedPane(pageWidth)')
      // One definition, asked for by both pages. Which *shape* each asks for is
      // its own decision and is pinned in `list-row-height.test.ts`; what
      // matters here is that neither page hard-codes a number of its own.
      expect(page).toContain('listRowHeight({')
      expect(page).toContain('record: recordRows')
      expect(page).toContain('split: splitList')
      expect(page).not.toMatch(/itemSize=\{\(\) => \d+\}/)
    }
  })
})

describe('every page-level narrowing row is the same band', () => {
  // Workspace, Tasks and Pull requests each put a search field over a run of
  // filter chips. Written four times, they drifted into four dialects on a
  // phone: a 15px magnifier against a 16px one, a 26px menu chip beside a 32px
  // toggle pill, two different idle rings, and one field at `text-sm` that iOS
  // then zoomed the page into. One recipe is what stops that happening again.
  const stylesPath = resolve(COMPONENTS, 'ui/list-page/filter-styles.ts')
  const filterStyles = readFileSync(stylesPath, 'utf8')

  const CONSUMERS = [
    'ui/list-page/ListFilterBar.svelte',
    'ui/list-page/ListStatusMenu.svelte',
    'ui/list-page/ListScopeMenu.svelte',
    'workspace/WorkspaceSearchField.svelte',
    'workspace/WorkspacePage.svelte',
    'tasks/TasksPage.svelte',
    'prs/PrsPage.svelte',
  ]

  it('states the field and the chip once, and every surface reads it', () => {
    for (const path of CONSUMERS) {
      expect(source(path)).toMatch(/FILTER_(CHIP|SEARCH|SORT)/)
    }
  })

  it('never restates the chip skin beside the one that owns it', () => {
    // The tint is what says "this list is not showing everything". Two pages
    // disagreeing on it by one percent is how the drift started.
    for (const path of CONSUMERS) {
      expect(source(path)).not.toContain('var(--primary)_14%')
    }
  })

  it('keeps the record field at 16px, so focusing it never zooms the page in', () => {
    // iOS zooms into any field under 16px on focus and does not zoom back out,
    // which leaves the page magnified with half the list off-screen.
    expect(filterStyles).toContain(`${RUNG}:text-base!`)
  })

  it('rings the chip from the inside, because its row is a scroller', () => {
    // `overflow-x: auto` forces `overflow-y: auto` with it, and the row is
    // exactly one chip tall — so an outer ring painted its top and bottom runs
    // outside the scroll box and they were clipped, leaving a pill with two
    // curved ends and no lid.
    // Scoped to the idle chip: the search field's own ring is legitimately
    // outer, because the field sits in no scroller.
    const chipOff = /FILTER_CHIP_OFF =\s*'([^']*)'/.exec(filterStyles)?.[1] ?? ''
    expect(chipOff).toContain('shadow-[inset_0_0_0_.5px_')
    expect(chipOff).not.toMatch(/shadow-\[0_0_0_/)
  })

  it('makes the crumb row as tall as the drawer button it holds', () => {
    // At 27px around a 44px button the button overflowed its row and ate the
    // whole measure under it, leaving the filter band 1px below the button.
    const listPage = source('ui/list-page/ListPage.svelte')
    const skeleton = source('ui/list-page/ListPageSkeleton.svelte')
    for (const surface of [listPage, skeleton]) {
      expect(surface).toContain(`${RUNG}:h-11!`)
      expect(surface).toContain(`${RUNG}:pb-2.5!`)
    }
  })

  it('marks the chip’s record geometry `!`, because two rules outrank the rung', () => {
    // A laptop-display variant is two selectors to the rung's one, and
    // `PAGE_GHOST_BTN`'s coarse-pointer `min-h-10` would otherwise leave a sort
    // chip 8px taller than the toggle chip beside it.
    for (const rule of [`${RUNG}:h-8!`, `${RUNG}:min-h-0!`, `${RUNG}:px-[13px]!`]) {
      expect(filterStyles).toContain(rule)
    }
  })
})

describe('the pickers are sized against the window they are portalled to', () => {
  const sessionPicker = source('session/SessionPicker.svelte')
  const taskPicker = source('session/TaskPicker.svelte')

  it('gives a thumb a target it can hit and a title it can read', () => {
    // 46px is a pointer's row. The picker is one of the few surfaces where the
    // window is the honest question, because it is sized against the window.
    expect(sessionPicker).toContain('runtime.isMobileViewport ? 62 : 46')
    expect(taskPicker).toContain('max-md:h-[62px]')
  })

  it('raises the search field into the card shape every phone list uses', () => {
    for (const picker of [sessionPicker, taskPicker]) {
      expect(picker).toContain('max-md:bg-card')
      expect(picker).toContain('max-md:shadow-[shadow:var(--elev-ring)]')
    }
  })

  it('keeps the field at 16px, so focusing it never zooms the page in', () => {
    // iOS zooms into any field under 16px on focus and does not zoom back out,
    // which leaves the picker half off-screen with no way to recover it.
    for (const picker of [sessionPicker, taskPicker]) {
      expect(picker).toContain('max-md:text-base')
    }
  })
})
