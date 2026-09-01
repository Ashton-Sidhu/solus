import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskLinkedTask } from '@solus/contracts/task-types'
import {
  linkVerb,
  linkedTaskRef,
  taskLinkControlState,
  taskLinkPickerRows,
} from '@solus/workspace-ui/components/tasks/link-control/lib/task-link-control'

function edge(taskId: string, title: string, shortId?: number): TaskLinkedTask {
  return { kind: 'work', targetScope: '', targetKey: 'w1', taskId, title, status: 'in_progress', shortId }
}

describe('the Link control on a conversation card', () => {
  test('the task picker trigger keeps the popover click handler', () => {
    // WHY: the card has to stop the click from opening the work, but replacing
    // Bits UI's trigger handler makes the chevron inert. Both handlers must run.
    const source = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/link-control/TaskLinkControl.svelte'),
      'utf8',
    )
    expect(source.match(/mergeProps\(props, \{ onclick: stopTriggerClick \}\)/g)).toHaveLength(3)
  })

  test('link writes show their final state without a progress-label frame', () => {
    // WHY: "Linking…" and "Unlinking…" replace the rail twice around one
    // click. The cache is optimistic, so the final label can render at once.
    const source = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/link-control/TaskLinkControl.svelte'),
      'utf8',
    )
    expect(source).not.toContain('Linking…')
    expect(source).not.toContain('Unlinking…')
    expect(source.indexOf('store.noteUnlinked(target, taskId)')).toBeLessThan(source.indexOf('await task.unlink'))
    expect(source.indexOf('store.noteLinked(target, task)')).toBeLessThan(source.indexOf('await task.link'))
  })

  test('says nothing until the host has answered', () => {
    // WHY: "Link to task…" on a document that is already linked is a lie the
    // user would act on. An unread target draws no verb at all.
    expect(taskLinkControlState(undefined, null)).toEqual({ kind: 'unknown' })
  })

  test('offers the conversation\'s own task as the one-click verb', () => {
    // WHY: the common case is filing the document under the task this chat is
    // already working; that must be one click, and it must name the task so
    // the click is not a guess.
    const current = { taskId: 't1', title: 'Fix sync', status: 'in_progress' as const, shortId: 184 }
    const state = taskLinkControlState([], current)
    expect(state.kind).toBe('none')
    if (state.kind === 'none') expect(linkVerb(state)).toBe('Link to T-184')
    const loose = taskLinkControlState([], null)
    if (loose.kind === 'none') expect(linkVerb(loose)).toBe('Link to task…')
  })

  test('one link names the task; several count them', () => {
    // WHY: a single link is the thing to open and the thing to undo, so it is
    // named. Three links do not fit in a rail, so the rail counts them and
    // the picker manages the set.
    const one = taskLinkControlState([edge('t1', 'Fix sync', 184)], null)
    expect(one).toMatchObject({ kind: 'one', label: 'Linked to T-184 · Fix sync' })
    const many = taskLinkControlState([edge('t1', 'Fix sync', 184), edge('t2', 'Ship it', 190)], null)
    expect(many).toMatchObject({ kind: 'many', label: 'Linked to 2 tasks' })
  })

  test('a task with no short id yet is still referenceable', () => {
    expect(linkedTaskRef({ taskId: '01M157M9QTHDWM8MRQTR8Q998N' })).toBe('01M157')
  })
})

describe('the task picker rows', () => {
  const candidates = [
    { taskId: 't2', title: 'Ship it', status: 'todo' as const, shortId: 190 },
    { taskId: 't1', title: 'Fix sync', status: 'in_progress' as const, shortId: 184 },
  ]

  test('lists the conversation\'s task first, and marks what is already linked', () => {
    const rows = taskLinkPickerRows(candidates, [edge('t2', 'Ship it', 190)], 't1')
    expect(rows.map((row) => row.taskId)).toEqual(['t1', 't2'])
    expect(rows[0]).toMatchObject({ current: true, linked: false })
    expect(rows[1]).toMatchObject({ current: false, linked: true })
  })

  test('a finished task that still links the target stays listed', () => {
    // WHY: the picker only offers live tasks, but an unlink has to reach a
    // done task too — otherwise a stale edge has no way out but the task page.
    const done: TaskLinkedTask = { ...edge('t9', 'Old spike', 12), status: 'done' }
    const rows = taskLinkPickerRows(candidates, [done], null)
    expect(rows.at(-1)).toMatchObject({ taskId: 't9', linked: true, status: 'done' })
    // And never twice, when the linked task is also a live candidate.
    const twice = taskLinkPickerRows(candidates, [edge('t1', 'Fix sync', 184)], 't1')
    expect(twice.filter((row) => row.taskId === 't1')).toHaveLength(1)
  })
})
