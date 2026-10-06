import { describe, expect, test } from 'bun:test'
import type { Task, TaskStatus } from '@solus/contracts/task-types'
import {
  OPEN_TASK_STATUS_KEYS,
  TASK_STATUS_GROUPS,
  isOpenTaskStatusFilter,
  isTaskSnoozed,
  nextTaskWake,
  taskGroups,
  taskRow,
  taskStatusesFor,
} from '@solus/workspace-ui/components/tasks/lib/tasks-list-view'

const NOW = Date.parse('2026-08-04T13:00:00Z')

function task(id: string, status: TaskStatus): Task {
  return {
    id,
    title: `Task ${id}`,
    body: '',
    url: '',
    status,
    labels: [],
    providerId: 'local',
    projectKey: '/repo',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
  }
}

const noSessions = () => 0

describe('task status filter', () => {
  test('opens on live work only, and reaches finished work in one pick', () => {
    // WHY: a list that leads with everything ever closed buries the handful of
    // things still moving. Closed work stays reachable — it is the record of
    // what shipped — but it is never what the page opens on.
    const open = taskStatusesFor(OPEN_TASK_STATUS_KEYS)
    expect(open.has('in_progress')).toBe(true)
    expect(open.has('done')).toBe(false)
    expect(open.has('dropped')).toBe(false)
    expect(taskStatusesFor([...OPEN_TASK_STATUS_KEYS, 'done']).has('done')).toBe(true)
  })

  test('the status filter a list opens on is not counted as a filter', () => {
    // WHY: the Filters badge and its Clear filters item mean "you narrowed
    // this". Clearing puts status back to live work, so live work in any
    // order must read as unfiltered, or the badge would survive the clear.
    expect(isOpenTaskStatusFilter([...OPEN_TASK_STATUS_KEYS].reverse())).toBe(true)
    expect(isOpenTaskStatusFilter([...OPEN_TASK_STATUS_KEYS, 'done'])).toBe(false)
    expect(isOpenTaskStatusFilter(['todo'])).toBe(false)
    expect(isOpenTaskStatusFilter(TASK_STATUS_GROUPS.map((group) => group.key))).toBe(false)
  })

  test('untriaged tasks ride with Todo rather than earning their own switch', () => {
    // WHY: `inbox` is a storage detail — a task nobody has sorted yet. Naming
    // it in the filter would ask the user to know the difference; the list has
    // always shown it under Todo, and the filter has to agree with the list.
    expect(taskStatusesFor(['todo'])).toEqual(new Set<TaskStatus>(['todo', 'inbox']))
  })

  test('done and dropped are separate answers, not one "closed" bucket', () => {
    // WHY: "I finished this" and "I abandoned this" are different facts, and
    // reviewing what you dropped is a distinct thing to go looking for.
    const rows = [task('a', 'done'), task('b', 'dropped')]
    const groups = taskGroups(rows, noSessions, NOW)
    expect(groups.map((group) => group.label)).toEqual(['Done', 'Closed'])
    expect(TASK_STATUS_GROUPS.map((group) => group.key)).toContain('dropped')
  })
})

describe('where a task row says it lives', () => {
  test('project and host take the place column, not a chip after the title', () => {
    // WHY: the list is a table. A project chip trailing each title sat at a
    // different x on every row and could not be scanned down; a column can.
    const placeFor = () => ({ project: 'acme/app', host: 'Solus Cloud' })
    const row = taskRow({ ...task('t1', 'todo'), labels: ['design'] }, 0, NOW, placeFor)
    expect(row.place).toEqual({ project: 'acme/app', host: 'Solus Cloud' })
    expect(row.chips.map((chip) => chip.label)).toEqual(['design'])
  })

  test('a page that draws no place column gives no row the cell', () => {
    // WHY: every row of one list must agree on the column, or the cells drift.
    const groups = taskGroups([task('a', 'todo'), task('b', 'todo')], noSessions, NOW, () => undefined)
    expect(groups[0].rows.every((row) => row.place === undefined)).toBe(true)
  })
})

describe('the provider a task row names', () => {
  test('a task with no ticket reads as local', () => {
    expect(taskRow(task('a', 'todo'), 0, NOW).source).toEqual({
      id: 'local',
      title: 'Local task · lives in Solus',
    })
  })

  test('a published task reads as GitHub, naming the issue it was filed as', () => {
    // WHY: once the work is on GitHub, that is where colleagues see it. A row
    // still marked "local" tells the user their push did not take.
    const published: Task = {
      ...task('b', 'todo'),
      mirroredTicket: { provider: 'github', externalId: '412', url: 'https://github.com/o/r/issues/412' },
    }

    expect(taskRow(published, 0, NOW).source).toEqual({
      id: 'github',
      title: 'GitHub · synced with #412',
    })
  })
})

describe('which provider a task row names', () => {
  test('a task that has been published reads as its ticket\'s provider', () => {
    // WHY: once the work is filed on GitHub, that is where other people see it.
    // Still calling the row "local" hides the thing the user just did — and the
    // ticket is the same work, not a second item.
    const published: Task = {
      ...task('t1', 'todo'),
      mirroredTicket: { provider: 'github', externalId: '412', url: 'https://github.com/o/r/issues/412' },
    }

    expect(taskRow(published, 0, NOW).source).toEqual({
      id: 'github',
      title: 'GitHub · synced with #412',
    })
  })

  test('a task with no ticket still reads as local', () => {
    expect(taskRow(task('t2', 'todo'), 0, NOW).source).toEqual({
      id: 'local',
      title: 'Local task · lives in Solus',
    })
  })
})

describe('the identifier column', () => {
  test('a provider-owned ticket keeps the provider reference, not a sliced uuid', () => {
    // WHY: an upstream ticket has no Solus number — its id IS the provider's
    // reference — so `T-${id.slice(0, 4)}` turned `ACME-128` into `T-ACME`: an
    // id nobody can look up, and one that reads as a truncated cell.
    const jira: Task = { ...task('ACME-128', 'todo'), providerId: 'jira' }
    const github: Task = { ...task('4127', 'todo'), providerId: 'github' }

    expect(taskRow(jira, 0, NOW).ident).toBe('ACME-128')
    expect(taskRow(github, 0, NOW).ident).toBe('#4127')
  })

  test('a native task keeps its per-install number', () => {
    expect(taskRow({ ...task('t1', 'todo'), shortId: 412 }, 0, NOW).ident).toBe('T-412')
  })

  test('the provider mark names the provider that owns the ticket', () => {
    // WHY: the tooltip said "GitHub" for every provider, so a Jira row claimed
    // to sync with GitHub.
    const jira: Task = { ...task('ACME-128', 'todo'), providerId: 'jira' }
    expect(taskRow(jira, 0, NOW).source).toEqual({
      id: 'jira',
      title: 'Jira · status and comments sync back',
    })
  })
})

describe('the label chip', () => {
  test('a task label is the shared pastel pill in the accent, not a neutral ring', () => {
    // WHY: a label reads the same on a task row, a task page and a pull
    // request row. The colour is what selects the pill skin.
    expect(taskRow({ ...task('t1', 'todo'), labels: ['design'] }, 0, NOW).chips[0]).toEqual({
      label: 'design',
      labelColor: 'var(--solus-accent)',
    })
  })
})

describe('snoozed tasks', () => {
  test('a snooze holds until its wake time, whatever the status', () => {
    // WHY: snooze is independent of the lifecycle. A task returns to the list
    // at its wake time without anyone having to unsnooze it.
    for (const status of ['in_progress', 'done'] as const) {
      const sleeping = { ...task('s', status), snoozedUntil: NOW + 60_000 }
      expect(isTaskSnoozed(sleeping, NOW)).toBe(true)
      expect(isTaskSnoozed(sleeping, NOW + 60_000)).toBe(false)
    }
    expect(isTaskSnoozed(task('a', 'todo'), NOW)).toBe(false)
  })

  test('the list wakes at the earliest wake time still ahead', () => {
    // WHY: the list sets one timer for the next task to return.
    const tasks = [
      { ...task('late', 'todo'), snoozedUntil: NOW + 7_200_000 },
      { ...task('soon', 'todo'), snoozedUntil: NOW + 60_000 },
      { ...task('past', 'todo'), snoozedUntil: NOW - 60_000 },
      task('awake', 'todo'),
    ]
    expect(nextTaskWake(tasks, NOW)).toBe(NOW + 60_000)
    expect(nextTaskWake([task('awake', 'todo')], NOW)).toBeNull()
  })

  test('a snoozed row says when it comes back', () => {
    // WHY: the Snoozed filter is the way back to a hidden task, so each row
    // must show its return time.
    const row = taskRow({ ...task('s', 'todo'), snoozedUntil: NOW + 3 * 3_600_000, priority: 'urgent' }, 0, NOW)
    expect(row.chips).toContainEqual(expect.objectContaining({ label: 'wakes in 3h' }))
    expect(row.chips.some((chip) => chip.label === 'urgent')).toBe(false)
  })
})
