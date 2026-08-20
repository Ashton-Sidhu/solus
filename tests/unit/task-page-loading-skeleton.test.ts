import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const paneSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/ui/Pane.svelte'),
  'utf8',
)
const taskPageSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte'),
  'utf8',
)
const skeletonSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/task-page/TaskPageSkeleton.svelte'),
  'utf8',
)
const sidebarSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/task-page/TaskSidebar.svelte'),
  'utf8',
)

describe('task page loading state', () => {
  test('uses the task page skeleton across both loading boundaries', () => {
    // WHY: the task detail must keep its final two-column geometry while both
    // the lazy route module and the task record load.
    expect(paneSource).toMatch(
      /ref\.name === "task"[\s\S]*<TaskPageSkeleton \/>/,
    )
    expect(taskPageSource).toMatch(
      /aria-label="Task"[\s\S]*{#if taskId !== loadedId \|\| loadingTaskId === taskId \|\| !store\.loaded}[\s\S]*<TaskPageSkeleton \/>[\s\S]*{:else if task}/,
    )
  })

  test('builds placeholders with the shared Skeleton component', () => {
    expect(skeletonSource).toContain(
      'import { Skeleton } from "../../ui/skeleton";',
    )
    expect(skeletonSource).toContain('aria-label="Loading task"')
  })

  test('uses narrow-pane geometry for companion panels', () => {
    // WHY: a task opened beside a conversation has less horizontal room than a
    // leading page. Its loading and loaded states must use the same compact
    // geometry, or the sidebar overflows and the page shifts after hydration.
    expect(skeletonSource).toContain('@max-[60rem]:px-6')
    expect(skeletonSource).toContain('@max-[60rem]:flex-col')
    expect(skeletonSource).toContain('@max-[60rem]:w-full')
    expect(taskPageSource).toContain('@max-[60rem]:px-6')
    expect(taskPageSource).toContain('@max-[60rem]:flex-col')
    expect(sidebarSource).toContain('@max-[60rem]:w-full')
  })
})
