import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { taskRow } from '@solus/workspace-ui/components/tasks/lib/tasks-list-view'
import type { Task } from '@solus/contracts/task-types'

const read = (path: string) => readFileSync(path, 'utf8')

describe('task label management', () => {
  test('uses one shared pastel chip on pull requests and tasks', () => {
    // WHY: labels that move between list, detail, and create surfaces should
    // not change shape or visual weight based on the record type.
    const pullRequestLabels = read('packages/workspace-ui/src/components/pr-review/PrLabelFacts.svelte')
    const taskLabels = read('packages/workspace-ui/src/components/tasks/task-page/TaskLabelMenu.svelte')
    const composer = read('packages/workspace-ui/src/components/tasks/TaskComposer.svelte')

    expect(pullRequestLabels).toContain('LabelChip')
    expect(taskLabels).toContain('LabelChip')
    expect(composer).toContain('LabelChip')
  })

  test('edits detail labels through a searchable multi-select', () => {
    // WHY: task label editing should have the same find, add, and remove flow
    // as pull request labels instead of a separate blur-to-save text field.
    const menu = read('packages/workspace-ui/src/components/tasks/task-page/TaskLabelMenu.svelte')
    const sidebar = read('packages/workspace-ui/src/components/tasks/task-page/TaskSidebar.svelte')
    const page = read('packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte')

    expect(menu).toContain('DropdownMenu.CheckboxItem')
    expect(menu).toContain('Search or create labels')
    expect(menu).toContain('import { Input } from "../../ui/input"')
    expect(menu).toContain('class="h-9 text-workspace-chrome pointer-fine:[.is-laptop-display_&]:h-8"')
    expect(menu).toContain('Create “{query.trim()}”')
    expect(menu).toContain('closeOnSelect={false}')
    expect(menu).toContain('disabled={mutation}')
    expect(sidebar).toContain('onSet={canEditLabels ? (labels) => onSave({ labels }) : undefined}')
    expect(page).toContain('{labelCandidates}')
    expect(sidebar).not.toContain('onblur={addLabel}')
    expect(sidebar).toContain('class="flex min-h-[34px] items-center {sheet')
    expect(sidebar).not.toContain('leading-[34px]')
  })

  test('draws task-list labels as pastel pills', () => {
    const task = {
      id: 'task-1',
      providerId: 'local',
      kind: 'task',
      title: 'Polish labels',
      body: '',
      status: 'todo',
      labels: ['design'],
      updatedAt: 1,
    } satisfies Task

    expect(taskRow(task, 0, 2).chips[0]).toEqual({
      label: 'design',
      labelColor: 'var(--solus-accent)',
    })
  })
})
