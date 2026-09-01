import { describe, expect, test } from 'bun:test'
import type { Task, TaskStatus } from '@solus/contracts/task-types'
import {
  OPEN_TASK_STATUS_KEYS,
  TASK_STATUS_GROUPS,
  personalInboxTasks,
  taskGroups,
  taskInboxGroups,
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
    kind: 'task',
    labels: [],
    providerId: 'local',
    projectKey: '/repo',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
  }
}

const noSessions = () => 0
const actions = { open() {}, start() {}, resume() {}, markDone() {} }

describe('task status filter', () => {
  test('the personal inbox keeps native work and only provider issues assigned to the viewer', () => {
    // WHY: the inbox spans projects, but it must not turn into every connected
    // repository's team backlog. Provider-owned issues belong here only when
    // the connected account is their assignee.
    const native = task('native', 'todo')
    const mine = { ...task('mine', 'todo'), providerId: 'github' as const, assignee: 'Sidhu' }
    const teammate = { ...task('teammate', 'todo'), providerId: 'github' as const, assignee: 'alex' }
    const unassigned = { ...task('unassigned', 'todo'), providerId: 'github' as const }

    expect(
      personalInboxTasks(
        [native, mine, teammate, unassigned],
        () => 'sidhu',
      ).map((row) => row.id),
    ).toEqual(['native', 'mine'])
  })

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

  test('the inbox only queues the statuses asked for', () => {
    // WHY: the inbox is a list of decisions. Each of its groups is a lifecycle
    // state, so the one filter has to govern both views or the same task is
    // hidden on one page and waiting on the other.
    const rows = [task('a', 'in_review'), task('b', 'done')]
    const live = taskInboxGroups(rows, noSessions, NOW, actions, taskStatusesFor(OPEN_TASK_STATUS_KEYS))
    expect(live.map((group) => group.key)).toEqual(['needs'])

    const withDone = taskInboxGroups(rows, noSessions, NOW, actions, taskStatusesFor([...OPEN_TASK_STATUS_KEYS, 'done']))
    expect(withDone.find((group) => group.key === 'done')?.rows).toHaveLength(1)
  })

  test('inbox rows keep the right edge clear of status chips', () => {
    // WHY: the inbox group and context line already explain why each task is
    // present. Repeating that state in a chip crowds the time and row actions.
    const rows = [task('a', 'in_review'), task('b', 'in_progress'), task('c', 'todo')]
    const sessionsFor = (taskId: string) => taskId === 'b' ? 1 : 0
    const groups = taskInboxGroups(
      rows,
      sessionsFor,
      NOW,
      actions,
      taskStatusesFor(OPEN_TASK_STATUS_KEYS),
    )

    expect(groups.flatMap((group) => group.rows).every((row) => row.chips === undefined)).toBe(true)
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
