import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import {
  resolvePickerScope,
  scopeForChoice,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-scope'
import { pickerProjectKeys } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'

/** A task that the named task sources list. */
function task(id: string, ...sourceKeys: string[]): Task {
  return {
    id,
    providerId: 'github',
    kind: 'issue',
    title: id,
    body: '',
    url: null,
    state: { name: 'Open', category: 'open' },
    category: 'open',
    placements: sourceKeys.map((sourceKey) => ({ sourceKey, columnId: null })),
    labels: [],
    writableFields: [],
    updatedAt: 0,
  }
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
    task('a', 'github-repo:me/model-routing'),
    task('b', 'github-repo:me/solus'),
    task('c', 'github-repo:me/solus', 'github-project:me/1'),
  ]
  // A project lists task sources. The board is a source of two projects.
  const projectKeysBySource = new Map([
    ['github-repo:me/model-routing', ['github.com/me/model-routing']],
    ['github-repo:me/solus', ['github.com/me/solus']],
    ['github-project:me/1', ['github.com/me/solus', 'github.com/me/site']],
  ])
  const projectKeysOf = (item: Task) => [...new Set(item.placements.flatMap((placement) => projectKeysBySource.get(placement.sourceKey) ?? []))]

  test('each project that lists a task is one scope, offered once', () => {
    // WHY: a task belongs to no project by itself. A source that two projects
    // list puts its tasks in both scopes, and two tasks of one project must not
    // offer that project two times.
    expect(pickerProjectKeys(null, tasks, projectKeysOf, []))
      .toEqual(['github.com/me/model-routing', 'github.com/me/solus', 'github.com/me/site'])
  })

  test('the composer’s project leads and is offered even with no task yet', () => {
    // Leaving it out would make the default scope unnameable in its own menu.
    expect(pickerProjectKeys('github.com/me/fresh', tasks, projectKeysOf, [])[0]).toBe('github.com/me/fresh')
    expect(pickerProjectKeys('github.com/me/solus', tasks, projectKeysOf, []))
      .toEqual(['github.com/me/solus', 'github.com/me/model-routing', 'github.com/me/site'])
  })

  test('a known project with no task is still offered, once', () => {
    // A project whose work is all sessions has no task to name it.
    expect(pickerProjectKeys(null, [tasks[0]], projectKeysOf, ['github.com/me/model-routing', 'github.com/me/sessions-only']))
      .toEqual(['github.com/me/model-routing', 'github.com/me/sessions-only'])
  })

  test('a task that no known project lists adds no scope', () => {
    // WHY: a task that only a session link brought here has no project to name.
    expect(pickerProjectKeys(null, [task('loose')], projectKeysOf, [])).toEqual([])
  })
})
