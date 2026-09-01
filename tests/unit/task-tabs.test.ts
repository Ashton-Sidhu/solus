import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { taskTabs } from '../../packages/workspace-ui/src/components/tasks/task-page/lib/task-tabs'

describe('the task page keeps its four sections when it becomes a strip', () => {
  it('lists the desktop sections in the desktop order', () => {
    // The strip is the same page, not a mobile subset: a reader moving between
    // a phone and a 1440px window must not have to relearn what a task holds.
    expect(taskTabs({ linked: 0, sessions: 0, activity: 0 }).map((tab) => tab.id)).toEqual([
      'overview',
      'linked',
      'sessions',
      'activity',
    ])
  })

  it('carries a count on every section that is a collection of things', () => {
    const tabs = taskTabs({ linked: 3, sessions: 2, activity: 7 })
    expect(tabs.map((tab) => tab.count)).toEqual([undefined, 3, 2, 7])
  })

  it('gives Overview no count, because it would be counting the task', () => {
    expect(taskTabs({ linked: 1, sessions: 1, activity: 1 })[0].count).toBeUndefined()
  })

  it('reports zero rather than hiding it, and lets the strip decide what to draw', () => {
    // The rule "an empty section draws no number" belongs to the strip, so the
    // model stays honest and one component owns the presentation choice.
    const tabs = taskTabs({ linked: 0, sessions: 0, activity: 0 })
    expect(tabs.slice(1).map((tab) => tab.count)).toEqual([0, 0, 0])
  })
})

describe('the stacked task page keeps every section reachable', () => {
  const page = readFileSync(
    resolve(
      import.meta.dir,
      '../../packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte',
    ),
    'utf8',
  )

  it('hides sections instead of unmounting them', () => {
    // An unmounted tab loses its expanded threads and re-fetches its artifact
    // previews on every switch — the mount-once rule in CLAUDE.md.
    expect(page).toContain('class:hidden={hiddenTab(')
    expect(page).not.toMatch(/\{#if\s+tab === "linked"\}/)
  })

  it('renders the properties panel from one definition, not two', () => {
    // TaskSidebar takes twenty props. A second call site is twenty props kept
    // in step by hand, which is how a sheet drifts from the column it mirrors.
    // The two homes differ by the one argument that names which they are.
    expect(page.match(/<TaskSidebar/g)?.length).toBe(1)
    expect(page).toContain('{#snippet propertiesPanel(')
    expect(page).toContain('{@render propertiesPanel("column")}')
    expect(page).toContain('{@render propertiesPanel("sheet")}')
  })

  it('keeps the composer outside the tabs, so the input is always reachable', () => {
    // Rule one of the redesign. A comment is about the task, not about
    // whichever section happens to be on screen.
    const composerIndex = page.indexOf('<TaskCommentComposer')
    const activityGate = page.indexOf('hiddenTab("activity")')
    expect(composerIndex).toBeGreaterThan(activityGate)
    expect(page.slice(activityGate, composerIndex)).toContain('</div>')
  })

  it('reads the pane rather than the window', () => {
    expect(page).toContain('observePaneWidth')
    expect(page).not.toContain('isMobileViewport')
  })
})

describe('merge state is stated once, wherever it is drawn', () => {
  const bar = readFileSync(
    resolve(
      import.meta.dir,
      '../../packages/workspace-ui/src/components/pr-review/PrMergeBar.svelte',
    ),
    'utf8',
  )
  const feed = readFileSync(
    resolve(
      import.meta.dir,
      '../../packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte',
    ),
    'utf8',
  )

  it('derives the bar from the same model the rail card reads', () => {
    // Not handed a verdict: two renderings of one pure function cannot drift
    // into the "Conflicts with main / no conflicts" pair the model killed.
    expect(bar).toContain('mergeReadiness(')
  })

  it('states the blocker rather than disabling a button that explains itself', () => {
    expect(bar).toContain('readiness.headline')
    expect(bar).toContain('readiness.note')
    // Markup only — the prose above it is allowed to say the word while
    // explaining why the control it names does not exist here.
    const markup = bar.slice(bar.indexOf('</script>'))
    expect(markup).not.toContain('disabled')
  })

  it('shows the readiness in exactly one place at a time', () => {
    // Both mounted at once would put the merge CTA on screen twice; neither
    // would put it past every comment on the pull request. One reading decides,
    // so there is no band of pane widths that gets the wrong count.
    expect(feed).toContain('showReadiness={!railFolded}')
    expect(feed).toContain('{#if railFolded}')
  })
})
