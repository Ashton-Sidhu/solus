import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isRailFolded,
  RAIL_FOLD_MAX,
} from '../../packages/workspace-ui/src/components/pr-review/lib/rail-rows'
import {
  isTaskRailFolded,
  TASK_RAIL_FOLD_MAX,
} from '../../packages/workspace-ui/src/components/tasks/task-page/lib/task-page'

const read = (path: string) => readFileSync(resolve(import.meta.dir, '../../', path), 'utf8')

/**
 * A rail with nowhere to be used to stay where it was, full width, under the
 * reading column — which put it below the comment composer, past every comment
 * on the page. Both surfaces now take the rail out at that point and give it a
 * sheet instead.
 *
 * What these tests hold is that the rail leaves and its replacement arrives on
 * one rung. The old defect was two rungs: a container query decided the fold
 * and a JavaScript branch decided the replacement, 500-odd pixels apart, and
 * nothing in the build could notice. So each surface asserts that the rail's
 * column, the sheet, and the control that opens the sheet all read one value.
 */

describe('the PR review rail becomes a sheet the moment it loses its column', () => {
  const rail = read('packages/workspace-ui/src/components/pr-review/PrActivityRail.svelte')
  const feed = read('packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte')
  const bar = read('packages/workspace-ui/src/components/pr-review/PrMergeBar.svelte')

  it('owns the rung in one place, with no stylesheet copy to drift from', () => {
    // The rail used to carry a `@max-[1000px]` fold of its own. Two owners of
    // one number is what put a folded rail and no bottom bar on screen at once.
    expect(rail).not.toContain('@max-[1000px]')
    expect(rail).not.toContain('@min-[1001px]')
  })

  it('draws the rail in the column only while it has a column', () => {
    expect(feed).toContain('{#if !railFolded}\n        {@render railPanel("column")}')
  })

  it('renders the rail from one definition, not two', () => {
    // PrActivityRail takes twenty props. A second call site is twenty props
    // kept in step by hand, which is how a sheet drifts from the column it
    // mirrors.
    expect(feed.match(/<PrActivityRail/g)?.length).toBe(1)
    expect(feed).toContain('{@render railPanel("column")}')
    expect(feed).toContain('{@render railPanel("sheet")}')
  })

  it('opens the sheet, and offers the control that opens it, on that same rung', () => {
    expect(feed).toContain('{#if railFolded && railOpen}')
    expect(feed).toContain('details={railSheetTrigger}')
  })

  it('keeps the way into the sheet even before the readiness loads', () => {
    // The bar is the folded layout's only chrome. Gating all of it on a
    // readiness that arrives with the PR detail would make reviewers and
    // changed files unreachable for as long as the fetch takes.
    expect(bar).toContain('{#if readiness || details}')
  })

  it('measures the container the rung is resolved against, not the surface around it', () => {
    // A container query resolves against the content box. The row's border box
    // is 104px wider, and every pixel of that gap is a pane with a folded rail
    // and no bottom bar — which is the defect this rung exists to prevent.
    expect(feed).toContain('observeContainerWidth(contentRowEl')
    const opening = feed.slice(feed.indexOf('bind:this={contentRowEl}'))
    expect(opening.slice(0, opening.indexOf('>'))).toContain('@container')
  })

  it('does not decide the handoff on a rung of its own', () => {
    // `isStackedPane` is 30rem — it answers "is this a phone", which is a
    // different and much narrower question than "has the rail folded".
    expect(feed).not.toContain('isStackedPane')
  })

  it('is folded exactly at the rung, and not before the observer answers', () => {
    expect(isRailFolded(0)).toBe(false)
    expect(isRailFolded(RAIL_FOLD_MAX)).toBe(true)
    expect(isRailFolded(RAIL_FOLD_MAX + 1)).toBe(false)
  })
})

describe('the task page rail becomes a sheet the moment it leaves the column', () => {
  const page = read('packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte')
  const sidebar = read('packages/workspace-ui/src/components/tasks/task-page/TaskSidebar.svelte')

  it('owns the rung in one place, with no stylesheet copy to drift from', () => {
    // The rail carried `@max-[60rem]:static @max-[60rem]:w-full` for the width
    // it used to fold at, and the content row carried a matching `flex-col`.
    // Both described a state that can no longer happen.
    expect(sidebar).not.toContain('@max-[60rem]')
    expect(page).not.toContain('@max-[60rem]:flex-col')
  })

  it('draws the rail in the column only while it has a column', () => {
    expect(page).toContain('{#if !railFolded}\n          {@render propertiesPanel("column")}')
  })

  it('opens the sheet, and offers the button that opens it, at that same rung', () => {
    // Hiding a destination means building its replacement in the same change.
    // Gating the sheet on the fold but its trigger on `stacked` is the same bug
    // one layer in: the properties become unreachable in between.
    expect(page).toContain('{#if railFolded && propertiesOpen}')
    const trigger = page.indexOf('aria-label="Task properties"')
    expect(trigger).toBeGreaterThan(-1)
    expect(page.lastIndexOf('{#if railFolded}', trigger)).toBeGreaterThan(
      page.lastIndexOf('{#if stacked}', trigger),
    )
  })

  it('keeps the phone layout on its own, narrower rung', () => {
    // The rail loses its column at 60rem; the page does not become a strip with
    // a record bar until 30rem. Collapsing the two would give a 900px pane a
    // phone layout.
    expect(page).toContain('isStackedPane(paneWidth)')
    expect(page).toContain('hiddenTab = (id: TaskTabId) => stacked')
    expect(TASK_RAIL_FOLD_MAX).toBeGreaterThan(30 * 16)
  })

  it('is folded exactly at the rung, and not before the observer answers', () => {
    expect(isTaskRailFolded(0)).toBe(false)
    expect(isTaskRailFolded(TASK_RAIL_FOLD_MAX)).toBe(true)
    expect(isTaskRailFolded(TASK_RAIL_FOLD_MAX + 1)).toBe(false)
  })
})

describe('people pickers follow the display density rung', () => {
  const feed = read('packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte')
  const reviewers = read('packages/workspace-ui/src/components/pr-review/PrActivityRail.svelte')
  const assignees = read('packages/workspace-ui/src/components/tasks/task-page/TaskAssigneeMenu.svelte')

  it('loads reviewer candidates only when the reviewer menu opens', () => {
    // WHY: an assignable-user query can be large and is irrelevant until the
    // user asks to assign someone. Opening a PR must not pay for it.
    expect(feed).toContain('onOpenReviewerMenu={openReviewerMenu}')
    const initialLoad = feed.slice(
      feed.indexOf('function load(force'),
      feed.indexOf('function loadReviewerCandidates'),
    )
    expect(initialLoad).not.toContain('loadReviewerCandidates(')
  })

  it('uses smaller menu geometry on a precise-pointer laptop', () => {
    // WHY: canonical type already follows `text-workspace-chrome`; width and
    // control height must step with it instead of leaving a desktop-sized box.
    expect(reviewers).toContain('w-52 [.is-laptop-display_&]:w-48')
    expect(reviewers).toContain('pointer-fine:[.is-laptop-display_&]:h-8')
    expect(assignees).toContain('w-60 pointer-fine:[.is-laptop-display_&]:max-h-64 pointer-fine:[.is-laptop-display_&]:w-52')
    expect(assignees).toContain('pointer-fine:[.is-laptop-display_&]:h-8')
  })

  it('gives the reviewer candidates a ceiling, and gives it to the list rather than the menu', () => {
    // WHY: the host returns up to fifty collaborators and a dropdown has no
    // height of its own, so the menu ran off the bottom of the window. The cap
    // has to sit on the list: capping the menu instead would scroll the search
    // field — the only way to reach a name past the fold — out of view.
    const list = reviewers.indexOf('{#each availableReviewerCandidates')
    const search = reviewers.indexOf('aria-label="Search reviewers"')
    expect(list).toBeGreaterThan(-1)
    expect(search).toBeGreaterThan(-1)

    const scrollport = reviewers.lastIndexOf('overflow-y-auto', list)
    expect(scrollport).toBeGreaterThan(search)

    const opening = reviewers.slice(reviewers.lastIndexOf('<div', scrollport), list)
    expect(opening).toContain('max-h-[')
    // The window is what the ceiling is measured against, not a guessed number:
    // a menu opened near the bottom of the screen has less room than one opened
    // at the top, and only the floating layer knows which it is.
    expect(opening).toContain('--bits-dropdown-menu-content-available-height')
  })
})

/**
 * The action cluster has two homes with opposite geometry: a stacked column of
 * full-width controls inside the rail's merge card, and a row of content-width
 * controls in the bar that card becomes below the fold.
 *
 * Both render one snippet, so the home has to be an argument. It was not, and
 * the bar drew the card's column — top margin and all — beside the readiness
 * sentence, with the buttons hanging below the line they were meant to be on.
 */
describe("the merge card's actions keep their geometry when the card becomes a bar", () => {
  const dir = 'packages/workspace-ui/src/components/pr-review/'
  const cluster = read(`${dir}PrActions.svelte`)
  const merge = read(`${dir}MergeControl.svelte`)
  const conflicts = read(`${dir}ResolveConflictsButton.svelte`)
  const rail = read(`${dir}PrActivityRail.svelte`)
  const bar = read(`${dir}PrMergeBar.svelte`)
  const feed = read(`${dir}ActivityFeed.svelte`)

  it('tells the shared cluster which of its two homes it is rendering in', () => {
    expect(feed).toContain('{#snippet prActions(layout: PrActionsLayout)}')
    expect(rail).toContain('{@render actions("card")}')
    expect(bar).toContain('{@render actions("bar")}')
  })

  it('passes that answer down to every control the cluster owns', () => {
    // A parent cannot override a child's own width or height from the outside,
    // so a control that is not told which home it is in stays card-shaped in
    // the bar no matter what the cluster around it does.
    for (const tag of ['<ResolveConflictsButton', '<MergeControl']) {
      const open = cluster.slice(cluster.indexOf(tag))
      expect(open.slice(0, open.indexOf('/>'))).toContain('{layout}')
    }
    expect(merge).toContain('const bar = $derived(layout === "bar")')
    expect(conflicts).toContain('const bar = $derived(layout === "bar")')
  })

  it('keeps the stacked card geometry out of the bar arm of every branch', () => {
    // The card's utilities are the defect when they reach a one-line bar:
    // `w-full` makes a row-item claim the whole bar, `mt-*` drops it off the
    // bar's centre line, and `h-[34px]` leaves it taller than the Details
    // trigger beside it.
    for (const [name, source] of [
      ['PrActions', cluster],
      ['MergeControl', merge],
      ['ResolveConflictsButton', conflicts],
    ] as const) {
      const arms = barArms(source)
      expect(arms.length).toBeGreaterThan(0)
      for (const arm of arms) {
        expect(`${name}: ${arm}`).not.toMatch(/\bw-full\b|\bmt-|h-\[34px\]/)
      }
    }
  })
})

/** Every `bar ? "…" : "…"` arm taken when the control is rendering in the bar. */
function barArms(source: string): string[] {
  return [...source.matchAll(/\bbar\s*\?\s*(['"])(.*?)\1/g)].map((match) => match[2])
}
