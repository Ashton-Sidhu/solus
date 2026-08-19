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
})
