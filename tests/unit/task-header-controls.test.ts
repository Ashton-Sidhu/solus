import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PRIORITY_META, PRIORITY_OPTIONS, TASK_STATUSES } from '../../packages/workspace-ui/src/components/tasks/lib/tasks-api'

const read = (path: string) => readFileSync(resolve(import.meta.dir, '../../', path), 'utf8')

const header = read('packages/workspace-ui/src/components/tasks/task-page/TaskHeader.svelte')
const sidebar = read('packages/workspace-ui/src/components/tasks/task-page/TaskSidebar.svelte')
const page = read('packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte')
const statusMenu = read('packages/workspace-ui/src/components/tasks/task-page/TaskStatusMenu.svelte')
const priorityMenu = read('packages/workspace-ui/src/components/tasks/task-page/TaskPriorityMenu.svelte')

/**
 * The masthead states a task's status and priority. Those are also the two
 * decisions a reader most often wants to make about it, so they are the menus
 * that make them rather than labels you have to go find a rail for — which
 * matters more now that the rail is a sheet on any pane under 60rem.
 */

describe('the task masthead edits what it states', () => {
  it('opens a status menu from the status, and a priority menu from the priority', () => {
    expect(header).toContain('<TaskStatusMenu')
    expect(header).toContain('<TaskPriorityMenu')
  })

  it('is handed the same capability the sidebar is, not a blanket permission', () => {
    // `editableStatuses` is the provider's list. A task on a provider Solus
    // cannot move must keep the label and lose only the affordance, rather
    // than offering a move that will be rejected.
    expect(page).toContain('editableStatuses={capabilities?.editableStatuses ?? []}')
    expect(page).toContain('canEditPriority={capabilities?.canEditPriority ?? false}')
  })

  it('saves through the page rather than reaching for the store itself', () => {
    expect(page).toContain('onSaveStatus={(status) => save({ status })}')
    expect(page).toContain('onSavePriority={(priority) => save({ priority })}')
    expect(header).not.toContain('tasksStore')
  })
})

describe('one status menu, one priority menu', () => {
  it('leaves the sidebar and the masthead reading one definition', () => {
    // There were four hand-rolled status pickers before this; the masthead
    // would have been a fifth. The sidebar now goes through the same one, so a
    // change to the option list cannot reach one surface and miss the other.
    for (const surface of [header, sidebar]) {
      expect(surface).toContain('<TaskStatusMenu')
      expect(surface).toContain('<TaskPriorityMenu')
      expect(surface).not.toContain('DropdownMenu.Root')
    }
  })

  it('disables the trigger rather than opening an empty menu', () => {
    expect(statusMenu).toContain('disabled={!options.length}')
    expect(priorityMenu).toContain('<DropdownMenu.Trigger {disabled}')
  })

  it('offers every status the lifecycle has, from the one list', () => {
    // The menu walks whatever `options` it is handed, and the page hands it the
    // provider's list; a local task gets all of them.
    expect(statusMenu).toContain('{#each options as option (option)}')
    expect(TASK_STATUSES).toHaveLength(6)
  })

  it('offers every priority plus the absence of one', () => {
    expect(PRIORITY_OPTIONS.every((option) => option in PRIORITY_META)).toBe(true)
    expect(priorityMenu).toContain('{#each PRIORITY_OPTIONS as option (option)}')
    // Unset is a state a task can be in, so it is an option, not a clear button.
    expect(priorityMenu).toContain('onSelect={() => onSelect(null)}')
  })
})
