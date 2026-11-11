import { describe, expect, test } from 'bun:test'
import type { TaskLinkedTask } from '@solus/contracts/task-types'
import {
  linkVerb,
  linkedTaskRef,
  taskLinkControlState,
  taskLinkPickerRows,
} from '@solus/workspace-ui/components/tasks/link-control/lib/task-link-control'

function edge(taskId: string, title: string, reference?: string): TaskLinkedTask {
  return { kind: 'work', targetScope: '', targetKey: 'w1', taskId, title, category: 'active', reference }
}

describe('the Link control on a conversation card', () => {
  test('says nothing until the host has answered', () => {
    // WHY: "Link to task…" on a document that is already linked is a lie the
    // user would act on. An unread target draws no verb at all.
    expect(taskLinkControlState(undefined, null)).toEqual({ kind: 'unknown' })
  })

  test('offers the conversation\'s own task as the one-click verb', () => {
    // WHY: the common case is filing the document under the task this chat is
    // already working; that must be one click, and it must name the task so
    // the click is not a guess.
    const current = { taskId: 't1', title: 'Fix sync', category: 'active' as const, reference: 'acme/app#184' }
    const state = taskLinkControlState([], current)
    expect(state.kind).toBe('none')
    if (state.kind === 'none') expect(linkVerb(state)).toBe('Link to #184')
    const loose = taskLinkControlState([], null)
    if (loose.kind === 'none') expect(linkVerb(loose)).toBe('Link to task…')
  })

  test('one link names the task; several count them', () => {
    // WHY: a single link is the thing to open and the thing to undo, so it is
    // named. Three links do not fit in a rail, so the rail counts them and
    // the picker manages the set.
    const one = taskLinkControlState([edge('t1', 'Fix sync', 'acme/app#184')], null)
    expect(one).toMatchObject({ kind: 'one', label: 'Linked to #184 · Fix sync' })
    const many = taskLinkControlState([edge('t1', 'Fix sync', 'acme/app#184'), edge('t2', 'Ship it', 'SOL-190')], null)
    expect(many).toMatchObject({ kind: 'many', label: 'Linked to 2 tasks' })
  })

  test('names a task by the reference its provider gives it', () => {
    // WHY: the task key is a provider node id, which a person cannot read.
    // The rail shows what the person sees on GitHub or Jira. A row leaves the
    // repository out, as the task lists do.
    expect(linkedTaskRef({ reference: 'acme/app#184' })).toBe('#184')
    expect(linkedTaskRef({ reference: 'SOL-190' })).toBe('SOL-190')
  })

  test('a draft item of a board has no reference, and says that it is a draft', () => {
    expect(linkedTaskRef({})).toBe('Draft')
  })
})

describe('the task picker rows', () => {
  const candidates = [
    { taskId: 't2', title: 'Ship it', category: 'open' as const, reference: 'SOL-190' },
    { taskId: 't1', title: 'Fix sync', category: 'active' as const, reference: 'acme/app#184' },
  ]

  test('lists the conversation\'s task first, and marks what is already linked', () => {
    const rows = taskLinkPickerRows(candidates, [edge('t2', 'Ship it', 'SOL-190')], 't1')
    expect(rows.map((row) => row.taskId)).toEqual(['t1', 't2'])
    expect(rows[0]).toMatchObject({ current: true, linked: false })
    expect(rows[1]).toMatchObject({ current: false, linked: true })
  })

  test('a finished task that still links the target stays listed', () => {
    // WHY: the picker only offers live tasks, but an unlink has to reach a
    // done task too — otherwise a stale edge has no way out but the task page.
    const done: TaskLinkedTask = { ...edge('t9', 'Old spike', 'SOL-12'), category: 'done' }
    const rows = taskLinkPickerRows(candidates, [done], null)
    expect(rows.at(-1)).toMatchObject({ taskId: 't9', linked: true, category: 'done' })
    // And never twice, when the linked task is also a live candidate.
    const twice = taskLinkPickerRows(candidates, [edge('t1', 'Fix sync', 'acme/app#184')], 't1')
    expect(twice.filter((row) => row.taskId === 't1')).toHaveLength(1)
  })
})
