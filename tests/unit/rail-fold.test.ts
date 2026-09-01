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
 * A rail folding under the reading column is a designed behaviour. Folding
 * *without* the control that is supposed to replace it is not — it leaves the
 * one thing you act on below the comment bar, past everything.
 *
 * The fold is a container query and the replacement is a JavaScript branch, so
 * nothing in the build makes them agree. These tests are what makes them agree:
 * each asserts that the number the stylesheet folds at is the number the
 * branch reads, measured off the same box.
 */

describe('the PR review rail hands merge readiness over the moment it folds', () => {
  const rail = read('packages/workspace-ui/src/components/pr-review/PrActivityRail.svelte')
  const feed = read('packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte')

  it('reads the same width the stylesheet folds at', () => {
    const rung = rail.match(/@max-\[(\d+)px\]:w-full/)
    expect(rung).not.toBeNull()
    expect(Number(rung![1])).toBe(RAIL_FOLD_MAX)
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

  it('is folded exactly where the query is, and not before the observer answers', () => {
    expect(isRailFolded(0)).toBe(false)
    expect(isRailFolded(RAIL_FOLD_MAX)).toBe(true)
    expect(isRailFolded(RAIL_FOLD_MAX + 1)).toBe(false)
  })
})

describe('the task page rail becomes a sheet the moment it leaves the column', () => {
  const page = read('packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte')
  const sidebar = read('packages/workspace-ui/src/components/tasks/task-page/TaskSidebar.svelte')

  it('reads the same width the content row folds at', () => {
    const rung = page.match(/@max-\[(\d+)rem\]:flex-col/)
    expect(rung).not.toBeNull()
    expect(Number(rung![1]) * 16).toBe(TASK_RAIL_FOLD_MAX)
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

  it('leaves the rail no fold rung it can never reach', () => {
    // The column instance is not rendered below the fold any more, so a rule
    // saying what it does there describes a state that cannot happen.
    expect(sidebar).not.toContain('@max-[60rem]')
  })

  it('is folded exactly where the query is, and not before the observer answers', () => {
    expect(isTaskRailFolded(0)).toBe(false)
    expect(isTaskRailFolded(TASK_RAIL_FOLD_MAX)).toBe(true)
    expect(isTaskRailFolded(TASK_RAIL_FOLD_MAX + 1)).toBe(false)
  })
})
