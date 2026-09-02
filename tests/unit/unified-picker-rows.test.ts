import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { SidebarSessionChild } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import {
  buildPickerRows,
  collapseTarget,
  expandTarget,
  pickerRowHeight,
  selectedRowIndex,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'

function task(id: string, title: string, body = ''): Task {
  return {
    id,
    title,
    body,
    status: 'in_progress',
    priority: null,
    projectKey: 'solus',
    providerId: 'local',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Task
}

function child(sessionId: string, label: string): SidebarSessionChild {
  return {
    sessionId,
    label,
    branchName: null,
    attention: null,
    unread: false,
    serverId: 'local',
    runStartedAt: 0,
    lastActivityAt: 0,
    reviewGuideStatus: null,
  }
}

function build(
  tasks: Task[],
  sessions: Record<string, SidebarSessionChild[]>,
  query = '',
  expanded: string[] = [],
  selectedTaskId: string | null = null,
  openTaskIds: string[] = [],
  snoozedTaskIds: string[] = [],
) {
  return buildPickerRows({
    tasks,
    query,
    sessionsFor: (item) => sessions[item.id] ?? [],
    expandedTaskIds: new Set(expanded),
    selectedTaskId,
    openTaskIds: new Set(openTaskIds),
    snoozedTaskIds: new Set(snoozedTaskIds),
  })
}

describe('unified picker rows', () => {
  const tasks = [task('a', 'Alpha'), task('b', 'Beta')]
  const sessions = {
    a: [child('a1', 'first pass'), child('a2', 'second pass')],
    b: [child('b1', 'beta run')],
  }

  test('tasks and their expanded sessions form one keyboard sequence', () => {
    const { rows, entries } = build(tasks, sessions, '', ['a'])
    expect(rows.map((row) => row.kind)).toEqual(['header', 'task', 'session', 'session', 'task'])
    expect(entries.map((entry) => entry.entryIndex)).toEqual([0, 1, 2, 3])
    // Headers take no index, so ↓ from the last session lands on the next task.
    expect(entries[3]).toMatchObject({ kind: 'task', task: { id: 'b' } })
  })

  test('a collapsed task hides its sessions from the keyboard, not just from view', () => {
    const { entries } = build(tasks, sessions)
    expect(entries.map((entry) => entry.kind)).toEqual(['task', 'task'])
  })

  test('open in-progress and snoozed sidebar tasks are lifted into top sections without duplicates', () => {
    const todo = { ...task('c', 'Gamma'), status: 'todo' as const }
    const { rows } = build([...tasks, todo], sessions, '', [], null, ['a', 'c'], ['b'])
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.label)).toEqual([
      'Open',
      'Snoozed',
      'Todo',
    ])
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.accent)).toEqual([
      false,
      true,
      false,
    ])
    expect(rows.filter((row) => row.kind === 'task').map((row) => row.task.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  test('only the selected task group opens and it closes after selection moves away', () => {
    expect(build(tasks, sessions, '', [], 'a').rows.map((row) => row.kind)).toEqual([
      'header',
      'task',
      'session',
      'session',
      'task',
    ])
    expect(build(tasks, sessions, '', [], 'b').rows.map((row) => row.kind)).toEqual([
      'header',
      'task',
      'task',
      'session',
    ])
  })

  test('a task matched only through its sessions shows only matching sessions', () => {
    const sessionsWithSibling = {
      ...sessions,
      b: [...sessions.b, child('b2', 'unrelated follow-up')],
    }
    const { rows } = build(tasks, sessionsWithSibling, 'beta run')
    expect(rows.filter((row) => row.kind === 'task').map((row) => row.task.id)).toEqual(['b'])
    expect(rows.filter((row) => row.kind === 'session').map((row) => row.session.sessionId)).toEqual([
      'b1',
    ])
  })

  test('a task matching on its own name opens all of its sessions', () => {
    const { rows } = build(tasks, sessions, 'alpha')
    expect(rows.map((row) => row.kind)).toEqual(['header', 'task', 'session', 'session'])
    expect(rows.filter((row) => row.kind === 'session').map((row) => row.session.sessionId)).toEqual([
      'a1',
      'a2',
    ])
  })

  test('a task matching nothing is dropped', () => {
    const { entries } = build(tasks, sessions, 'nothing here')
    expect(entries).toEqual([])
  })

  test('→ opens a collapsed task, then steps into it', () => {
    const collapsed = build(tasks, sessions).entries[0]
    expect(expandTarget(collapsed)).toEqual({ action: 'expand', taskId: 'a' })
    const opened = build(tasks, sessions, '', ['a']).entries[0]
    expect(expandTarget(opened)).toEqual({ action: 'step' })
  })

  test('→ does nothing on a task with no sessions', () => {
    const { entries } = build([task('c', 'Gamma')], {})
    expect(expandTarget(entries[0])).toBeNull()
  })

  test('← returns from a session to its task, then collapses it', () => {
    const { entries } = build(tasks, sessions, '', ['a'])
    expect(collapseTarget(entries, 2)).toEqual({ action: 'select', entryIndex: 0 })
    expect(collapseTarget(entries, 0)).toEqual({ action: 'collapse', taskId: 'a' })
    expect(collapseTarget(entries, 3)).toBeNull()
  })

  test('the footer counts sessions of kept tasks whether or not they are open', () => {
    expect(build(tasks, sessions).sessionCount).toBe(3)
    expect(build(tasks, sessions, 'alpha').sessionCount).toBe(2)
  })

  test('the cursor maps to a row index past the headers', () => {
    const { rows } = build(tasks, sessions, '', ['a'])
    expect(selectedRowIndex(rows, 0)).toBe(1)
    expect(selectedRowIndex(rows, 3)).toBe(4)
    expect(selectedRowIndex([], 0)).toBe(-1)
  })

  // The virtualiser positions rows from this table before they paint, so a
  // row kind with no height, or a touch row shorter than a thumb, would put
  // every row after it in the wrong place.
  test('every row kind has a height and touch rows are never shorter than pointer rows', () => {
    const { rows } = build(tasks, sessions, '', ['a'])
    for (const row of rows) {
      const pointer = pickerRowHeight(row, false)
      const touch = pickerRowHeight(row, true)
      expect(pointer).toBeGreaterThan(0)
      expect(touch).toBeGreaterThanOrEqual(pointer)
      if (row.kind !== 'header') expect(touch).toBeGreaterThanOrEqual(44)
    }
  })

  test('the last session under a task is taller by the nest padding on a pointer display', () => {
    const { rows } = build(tasks, sessions, '', ['a'])
    const [first, last] = rows.filter((row) => row.kind === 'session')
    expect(pickerRowHeight(last, false) - pickerRowHeight(first, false)).toBe(4)
  })
})
