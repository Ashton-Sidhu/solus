import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const root = new URL('../..', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')

const sidebar = read('packages/workspace-ui/src/components/session/SessionSidebar.svelte')
const taskRow = read('packages/workspace-ui/src/components/session/TaskRow.svelte')
const sessionRow = read('packages/workspace-ui/src/components/session/TaskSessionRow.svelte')
const mobileList = read('apps/client/src/components/MobileSessionList.svelte')

describe('session sidebar dismissal surfaces', () => {
  test('row X controls use local dismissal commands and never write task status', () => {
    // WHY: a sidebar X is client view state. Writing `dropped` here can close the
    // linked GitHub issue or move a Jira ticket to Done.
    expect(sidebar).not.toContain('setStatus("dropped")')
    expect(sidebar).toContain('onClose={() => removeTask(task)}')
    expect(sidebar).toContain('onCloseSession={removeChild}')
  })

  test('desktop and web name the action as sidebar removal', () => {
    expect(taskRow).toContain('title="Remove from sidebar"')
    expect(taskRow).toContain('aria-label={task.taskId ? "Remove task from sidebar" : "Remove session from sidebar"}')
    expect(sessionRow).toContain('aria-label="Remove session from sidebar"')
    expect(taskRow).not.toContain('title={task.taskId ? "Close task"')
  })

  test('mobile removal does not claim that it stops or drops work', () => {
    expect(mobileList).toContain('<XIcon size={17} />Remove')
    expect(mobileList).toContain('Its run continues.')
    expect(mobileList).toContain('store.restoreTask(task.taskId)')
    expect(mobileList).not.toContain('Stop and remove')
    expect(mobileList).not.toContain('<XIcon size={17} />Drop')
  })
})
