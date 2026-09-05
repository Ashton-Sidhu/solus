import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import {
  resolvePickerScope,
  scopeForChoice,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-scope'
import { pickerProjectChoices } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'

function task(id: string, projectKey: string): Task {
  return {
    id,
    title: id,
    body: '',
    status: 'in_progress',
    priority: null,
    projectKey,
    providerId: 'local',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Task
}

/**
 * The picker opens where the user already is, and keeps doing so as the user
 * moves. These assert the two halves of that: the default follows the composer,
 * and an explicit choice is only sticky when it is genuinely somewhere else.
 */
describe('picker scope', () => {
  test('the default follows the composer rather than pinning a project', () => {
    expect(resolvePickerScope({ kind: 'current' }, 'model-routing')).toBe('model-routing')
    // The same scope value, read again after the composer moved.
    expect(resolvePickerScope({ kind: 'current' }, 'solus')).toBe('solus')
  })

  test('a composer in no project leaves the list wide rather than empty', () => {
    expect(resolvePickerScope({ kind: 'current' }, null)).toBeNull()
  })

  test('an explicit choice holds against the composer', () => {
    expect(resolvePickerScope({ kind: 'project', projectKey: 'solus' }, 'model-routing')).toBe('solus')
    expect(resolvePickerScope({ kind: 'all' }, 'model-routing')).toBeNull()
  })

  test('choosing the composer’s own project resumes following it', () => {
    // Pinning it instead would go stale the moment the user moved on, with no
    // visible difference in the control to explain why.
    expect(scopeForChoice('model-routing', 'model-routing')).toEqual({ kind: 'current' })
    expect(scopeForChoice('solus', 'model-routing')).toEqual({ kind: 'project', projectKey: 'solus' })
    expect(scopeForChoice(null, 'model-routing')).toEqual({ kind: 'all' })
  })
})

describe('picker project choices', () => {
  const tasks = [
    task('a', 'model-routing'),
    task('b', 'solus'),
    task('c', 'model-routing'),
  ]

  test('every project the picker can list is offered, with its task count', () => {
    expect(pickerProjectChoices(tasks, null)).toEqual([
      { projectKey: 'model-routing', label: 'model-routing', count: 2 },
      { projectKey: 'solus', label: 'solus', count: 1 },
    ])
  })

  test('the composer’s project leads and is offered even with no task yet', () => {
    // The case that sent us here: a fresh composer in a project whose first
    // task does not exist. Leaving it out would make the default scope
    // unnameable in its own menu.
    const choices = pickerProjectChoices(tasks, { projectKey: 'fresh', label: 'fresh' })
    expect(choices[0]).toEqual({ projectKey: 'fresh', label: 'fresh', count: 0 })
    expect(choices.map((choice) => choice.projectKey)).toEqual(['fresh', 'model-routing', 'solus'])
  })

  test('the composer’s project is not listed twice when it already has work', () => {
    const choices = pickerProjectChoices(tasks, { projectKey: 'solus', label: 'solus' })
    expect(choices.filter((choice) => choice.projectKey === 'solus')).toHaveLength(1)
    expect(choices[0]).toEqual({ projectKey: 'solus', label: 'solus', count: 1 })
  })
})
