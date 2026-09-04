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
 * on the page. Both surfaces now take the rail out of the column at that point.
 *
 * What these tests hold is that the rail leaves its column and its other home
 * arrives on one rung. The old defect was two rungs: a container query decided
 * the fold and a JavaScript branch decided the replacement, 500-odd pixels
 * apart, and nothing in the build could notice.
 */

describe('the PR review rail moves under the title the moment it loses its column', () => {
  const rail = read('packages/workspace-ui/src/components/pr-review/PrActivityRail.svelte')
  const feed = read('packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte')
  const type = read('packages/workspace-ui/src/index.css')

  it('owns the rung in one place, with no stylesheet copy to drift from', () => {
    // The rail used to carry a `@max-[1000px]` fold of its own. Two owners of
    // one number is what put a folded rail and no replacement on screen at once.
    expect(rail).not.toContain('@max-[1000px]')
    expect(rail).not.toContain('@min-[1001px]')
  })

  it('draws the rail in the column only while it has a column', () => {
    expect(feed).toContain('{#if !railFolded}\n        {@render railPanel("column")}')
  })

  it('draws it inline under the title on that same rung, from the same definition', () => {
    // WHY: the folded layout used to be a bottom bar plus a sheet, which on a
    // desktop pane beside the list — where the rail is nearly always folded —
    // read as a mobile surface stapled to the bottom of a window. The rail's
    // other home is now the reading column itself, above the description, so
    // the merge state is still the first thing on screen and nothing is
    // portalled. PrActivityRail takes twenty props; a second call site would
    // be twenty props kept in step by hand.
    expect(feed.match(/<PrActivityRail/g)?.length).toBe(1)
    expect(feed).toContain('{#if railFolded}')
    expect(feed).toContain('{@render railPanel("inline")}')
    expect(feed).not.toContain('PrMergeBar')
    expect(feed).not.toContain('BottomSheet')
  })

  it('moves the reviewers into the facts list once the rail folds, and out of the rail', () => {
    // WHY: inline, the rail's sections start folded, so the reviewers sat
    // behind a disclosure under the title. They are the one fact a reader
    // wants at a glance, so the folded page lists them beside the branch and
    // the churn instead — and the inline rail must not list them a second time.
    expect(feed).toContain('leading={detail ? leadingFacts : undefined}')
    expect(feed).toContain('{#if railFolded}\n    <PrReviewerFacts')
    expect(feed).toContain('<PrReviewerFacts')
    // The row is not a read-only stand-in: both moves the rail's rows offer
    // — ask someone, take a request back — are wired to the same handlers.
    expect(feed).toContain('onRequest={canRequestReviewers ? requestReviewer : undefined}')
    expect(feed).toContain('onRemove={canRequestReviewers ? removeReviewer : undefined}')
    const reviewersSection = rail.slice(
      rail.indexOf('<!-- Reviewers.'),
      rail.indexOf('<!-- Checks -->'),
    )
    expect(reviewersSection).toContain('{#if !inline}')
  })

  it('keeps the inline rail inside the header, before the description', () => {
    // The point of the move is that the state is read before the body, not
    // after it. The inline render has to precede the description section.
    expect(feed.indexOf('{@render railPanel("inline")}')).toBeLessThan(
      feed.indexOf('aria-label="Pull request description"'),
    )
  })

  it('starts the reference sections folded only when inline', () => {
    // Inline, three open sections would push the description off the first
    // screen; in a column of its own there is room for them.
    expect(rail).toContain('const startsOpen = untrack(() => variant === "column")')
  })

  it('scales changed-file rows to 12px on desktop and 10px on laptop displays', () => {
    // WHY: file paths are dense reference data, so they sit below the rail's
    // action-label rung while still taking the shared display-density step.
    const files = rail.slice(rail.indexOf('<!-- Changed files -->'))
    expect(files).toContain('text-review-file')
    expect(type).toContain('--text-review-file: 0.75rem;')
    expect(type).toContain('html.is-laptop-display {')
    expect(type).toContain('--text-review-file: 0.625rem;')
  })

  it('measures the container the rung is resolved against, not the surface around it', () => {
    // A container query resolves against the content box. The row's border box
    // is 104px wider, and every pixel of that gap is a pane with the rail in
    // the wrong home — which is the defect this rung exists to prevent.
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
  // The request menu is its own definition, so its geometry is asserted where
  // it lives rather than on the rail row that opens it.
  const reviewerMenu = read('packages/workspace-ui/src/components/pr-review/ReviewerRequestMenu.svelte')
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

  it('opens the same menu surface every other picker in the app opens', () => {
    // WHY: the reviewer, assignee and label menus used to be hand-styled
    // dropdowns with their own search field, so they read as a different
    // control from the task and provider pickers beside them. All of them now
    // stand on the shared surface, filter header and row primitive; the rows
    // take their laptop and touch geometry from that primitive rather than
    // restating it.
    const labelMenu = read('packages/workspace-ui/src/components/ui/labels/LabelPicker.svelte')
    for (const menu of [reviewerMenu, assignees, labelMenu]) {
      expect(menu).toContain('<Popover.Content')
      expect(menu).toContain('menu-surface')
      expect(menu).toContain('<MenuSearch')
      expect(menu).toContain('<Command.Item')
      expect(menu).not.toContain('DropdownMenu')
      // A menu opened in a 356px pane still drops out into the window; its
      // width is capped by the window, and steps down on a precise-pointer
      // laptop with the rows it lists.
      expect(menu).toContain('w-[min(15rem,calc(100vw-2rem))]')
      expect(menu).toContain('pointer-fine:[.is-laptop-display_&]:w-[min(13rem,calc(100vw-2rem))]')
      // The row primitive pins `text-menu`, which holds 14px on every display.
      // A picker's rows and search field take the workspace chrome rung
      // instead, as the task and project pickers do, so the type steps to 12px
      // on a precise-pointer laptop with the rest of the page's chrome.
      expect(menu).toContain('[&_.menu-row]:text-workspace-chrome')
      expect(menu).toContain('[&_[data-slot=command-input]]:text-workspace-chrome')
    }
  })

  it('gives reviewer candidates a viewport while the search field stays fixed', () => {
    // WHY: the host returns up to fifty collaborators and a dropdown has no
    // height of its own, so the menu ran off the bottom of the window. The cap
    // has to sit on the list: capping the menu instead would scroll the search
    // field — the only way to reach a name past the fold — out of view.
    const list = reviewerMenu.indexOf('{#each available as candidate')
    const search = reviewerMenu.indexOf('<MenuSearch')
    expect(list).toBeGreaterThan(-1)
    expect(search).toBeGreaterThan(-1)

    const scrollport = reviewerMenu.slice(search, list)
    expect(scrollport).toContain('<Command.List')
    expect(scrollport).toContain('overflow-y-auto')
    expect(scrollport).toContain('max-h-[')
    // The window is what the ceiling is measured against, not a guessed number:
    // a menu opened near the bottom of the screen has less room than one opened
    // at the top, and only the floating layer knows which it is.
    expect(scrollport).toContain('--bits-popover-content-available-height')
  })

  it('draws every reviewer from their host avatar, not their initials', () => {
    // WHY: the host hands each reviewer's image back with their verdict, and
    // the rail used to drop it on the floor — the author had a face and every
    // reviewer under them was a coloured disc.
    const row = reviewers.slice(reviewers.indexOf('{#each reviewers as reviewer'))
    expect(row.slice(0, row.indexOf('{/each}'))).toContain('url={reviewer.avatarUrl ?? ""}')
  })

  it('puts the verdict and its action in one cell, so the verdicts stay in a single edge', () => {
    // WHY: a pending row used to carry an ✕ beside its verdict word, which
    // pushed that row's word left of every other row's. Sharing a grid cell
    // means the action takes the word's place on hover instead of a place
    // beside it.
    const row = reviewers.slice(reviewers.indexOf('{#each reviewers as reviewer'))
    const cell = row.slice(0, row.indexOf('{/each}'))
    expect(cell.match(/col-start-1 row-start-1/g)?.length).toBe(2)
    expect(cell).toContain('pointer-fine:group-hover/reviewer:invisible')
    expect(cell).toContain('pointer-fine:group-hover/reviewer:opacity-100')
  })
})

/**
 * The action cluster has two homes with opposite geometry: a stacked column of
 * full-width controls inside the rail's status card, and a row of content-width
 * controls once the card is drawn inline beside its own headline.
 *
 * Both render one snippet, so the home has to be an argument. It was not, and
 * the row drew the card's column — top margin and all — beside the readiness
 * sentence, with the buttons hanging below the line they were meant to be on.
 */
describe("the status card's actions keep their geometry when the card becomes a row", () => {
  const dir = 'packages/workspace-ui/src/components/pr-review/'
  const cluster = read(`${dir}PrActions.svelte`)
  const merge = read(`${dir}MergeControl.svelte`)
  const rail = read(`${dir}PrActivityRail.svelte`)
  const feed = read(`${dir}ActivityFeed.svelte`)

  it('tells the shared cluster which of its two homes it is rendering in', () => {
    expect(feed).toContain(
      '{#snippet prActions(layout: PrActionsLayout, action: MergeAction | null)}',
    )
    expect(rail).toContain('{@render actions("card", readiness.action)}')
    expect(rail).toContain('{@render actions("row", readiness.action)}')
  })

  it('renders only the move the shared readiness model chose', () => {
    // WHY: permission to merge is not the same as readiness to merge. A PR
    // with a pending review must not contradict its own status with a merge
    // CTA — so the cluster never reads the host state itself; it draws the
    // action the same table that wrote the headline handed it.
    expect(feed).toContain('{action}')
    expect(cluster).toContain('action?.kind === "merge"')
    expect(cluster).not.toContain('mergeStateStatus')
    expect(cluster).not.toContain('isMergeReady')
  })

  it('lets the guide note shrink before its trailing action disappears', () => {
    // WHY: the laptop rail is narrower. A long status such as "Generation
    // failed" must yield space to the Generate action instead of clipping it.
    const start = rail.indexOf('{#snippet guideRow()}')
    const guide = rail.slice(start, rail.indexOf('{/snippet}', start))
    expect(guide).toContain('class="min-w-0 truncate text-xs text-muted-foreground"')
    expect(guide).not.toContain('class="shrink-0 truncate text-xs text-muted-foreground"')
  })

  it('passes that answer down to every control the cluster owns', () => {
    // A parent cannot override a child's own width or height from the outside,
    // so a control that is not told which home it is in stays card-shaped in
    // the row no matter what the cluster around it does. The merge is the one
    // control with a component of its own; every other move is one button in
    // the cluster, so there is nothing else to hand the answer to.
    const open = cluster.slice(cluster.indexOf('<MergeControl'))
    expect(open.slice(0, open.indexOf('/>'))).toContain('{layout}')
    expect(merge).toContain('const row = $derived(layout === "row")')
    expect(cluster).not.toContain('ResolveConflictsButton')
  })

  it('keeps the stacked card geometry out of the row arm of every branch', () => {
    // The card's utilities are the defect when they reach a one-line row:
    // `w-full` makes a row-item claim the whole line, `mt-*` drops it off the
    // centre line, and `h-[34px]` leaves it taller than the text beside it.
    for (const [name, source] of [
      ['PrActions', cluster],
      ['MergeControl', merge],
    ] as const) {
      const arms = rowArms(source)
      expect(arms.length).toBeGreaterThan(0)
      for (const arm of arms) {
        expect(`${name}: ${arm}`).not.toMatch(/\bw-full\b|\bmt-|h-\[34px\]/)
      }
    }
  })
})

/** Every `row ? "…" : "…"` arm taken when the control is rendering in the row. */
function rowArms(source: string): string[] {
  return [...source.matchAll(/\brow\s*\?\s*(['"])(.*?)\1/g)].map((match) => match[2])
}
