import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const taskChromeSource = readFileSync(
  join(root, 'src/renderer/components/tasks/task-page/TaskChromeBar.svelte'),
  'utf8',
)

describe('task ID copy control', () => {
  test('copies the durable task ID from the visible task breadcrumb', () => {
    // WHY: taskRef(task) can be a short display reference, but agents and task
    // tools need the complete durable ID when the user pastes it elsewhere.
    expect(taskChromeSource).toContain(
      '<CopyButton text={task.id} title="Copy task ID" iconOnly />',
    )
  })
})
