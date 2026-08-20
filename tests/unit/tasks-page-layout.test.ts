import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const tasksPage = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/TasksPage.svelte'),
  'utf8',
)

describe('Tasks page layout', () => {
  test('opens on the list and keeps the Kanban board available', () => {
    // WHY: the dense list is the default Tasks workflow, while the board must
    // remain directly available as another layout for the same task data.
    expect(tasksPage).toContain('let layout = $state<"list" | "board">("list")')
    expect(tasksPage).toContain('onclick={() => (layout = "list")}')
    expect(tasksPage).toContain('onclick={() => (layout = "board")}')
    expect(tasksPage).toContain('<TaskBoard')
  })

  test('keeps the layout toggle and Kanban board available in My inbox', () => {
    // WHY: My inbox is a task scope, not a separate layout. Changing scope must
    // not remove the user's list/Kanban layout choice.
    expect(tasksPage).toMatch(
      /{#snippet headerActions\(\)}[\s\S]*?{#if !splitList}/,
    )
    expect(tasksPage).toContain('const boardLayout = $derived(layout === "board")')
    expect(tasksPage).toContain(
      'const boardTasks = $derived(view === "inbox" ? inboxTasks : visibleTasks)',
    )
    expect(tasksPage.indexOf('{:else if boardLayout}')).toBeLessThan(
      tasksPage.indexOf('{:else if view === "inbox"}'),
    )
    expect(tasksPage).toContain('canReorder={view === "global" && boardUnfiltered}')
  })

  test('keeps the task list visible beside an open task on wide surfaces', () => {
    // WHY: opening a task is a reading action inside the queue. The user must
    // keep the list context instead of losing it to a separate route.
    expect(tasksPage).toContain(
      'const splitList = $derived(panelOpen && roomForSplit && !boardPanel)',
    )
    expect(tasksPage).toContain('split={splitList}')
    expect(tasksPage).toContain('hideHeader={splitList}')
    expect(tasksPage).toContain('<ListRailRow')
    expect(tasksPage).toMatch(
      /<ListRailRow[\s\S]*?responsiveTitle[\s\S]*?showTime=\{false\}/,
    )
    expect(tasksPage).toContain('<TaskPage')
    expect(tasksPage).toContain('onRequestClose={closePanel}')
  })

  test('can promote the embedded task detail to its standalone route', () => {
    // WHY: the list panel is a quick-reading surface. A task must still be
    // available as its own durable route for focused work and deep linking.
    expect(tasksPage).toContain('onOpenRoute={() => openTaskRoute(openTask)}')
    expect(tasksPage).toContain(
      'session.goToTask(task.id, "click", pane.isLeading ? "leading" : "secondary")',
    )
  })

  test('overlays the task panel on the Kanban board without changing its layout', () => {
    // WHY: the board is spatial context. Opening one card must not reflow its
    // columns or silently switch the user back to the list layout.
    expect(tasksPage).toContain('const boardPanel = $derived(panelOpen && boardLayout)')
    expect(tasksPage).not.toContain('layout = "list";\n    selectedKey = task.id;')
    expect(tasksPage).toContain('boardPanel && roomForSplit')
    expect(tasksPage).toContain('w-[clamp(680px,72%,1400px)]')
  })
})
