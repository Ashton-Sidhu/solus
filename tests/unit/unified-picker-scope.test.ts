import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import {
  resolvePickerScope,
  scopeForChoice,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-scope'
import { pickerProjectKeys } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'

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

describe('picker project keys', () => {
  const tasks = [
    task('a', '/Users/me/model-routing'),
    task('b', '/Users/me/solus'),
    task('c', '/home/me/solus'),
  ]
  // Both checkouts of solus belong to one repository.
  const projectKeyOf = (item: Task) => item.projectKey?.endsWith('/solus') ? 'github.com/me/solus' : item.projectKey ?? null

  test('every checkout of a project is one scope', () => {
    // A project checked out in several folders or on several hosts was offered
    // once per folder, every row with the same name.
    expect(pickerProjectKeys(null, tasks, projectKeyOf, [])).toEqual(['/Users/me/model-routing', 'github.com/me/solus'])
  })

  test('the composer’s project leads and is offered even with no task yet', () => {
    // Leaving it out would make the default scope unnameable in its own menu.
    expect(pickerProjectKeys('github.com/me/fresh', tasks, projectKeyOf, [])[0]).toBe('github.com/me/fresh')
    expect(pickerProjectKeys('github.com/me/solus', tasks, projectKeyOf, [])).toEqual(['github.com/me/solus', '/Users/me/model-routing'])
  })

  test('a known project with no task is still offered, once', () => {
    // A project whose work is all sessions has no task to name it.
    expect(pickerProjectKeys(null, tasks, projectKeyOf, ['github.com/me/solus', 'github.com/me/sessions-only']))
      .toEqual(['/Users/me/model-routing', 'github.com/me/solus', 'github.com/me/sessions-only'])
  })

  test('a chat is not a project to scope to', () => {
    expect(pickerProjectKeys(null, [task('chat', '/Users/me/.solus-chats/abc')], (item) => item.projectKey ?? null, [])).toEqual([])
  })
})
