import { describe, expect, test } from 'bun:test'
import { isUlid } from '@solus/contracts/ulid'
import { makeSession } from '@solus/workspace-ui/contexts/workspace/session.factories'
import { newTaskId } from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'

const settings = { rateLimitBehavior: 'ask' } as Parameters<typeof makeSession>[0]

describe('the task id a session plans before its first prompt', () => {
  test('a session that will create a task names it when it is made', () => {
    // WHY: the sidebar keys the session's row by this id before the host
    // answers, and the host mints the task under it, so the row never changes.
    const session = makeSession(settings, { task: { kind: 'new' } })
    const planned = newTaskId(session.task)
    expect(planned).not.toBeNull()
    expect(isUlid(planned!)).toBe(true)
  })

  test('a copied or restored target never shares the id of the session it came from', () => {
    // WHY: a fork copies its source's target. Two sessions under one id would
    // make the host refuse the second mint, and the two rows share one key.
    const source = makeSession(settings, { task: { kind: 'new' } })
    const copy = makeSession(settings, { task: { ...source.task } })
    expect(newTaskId(copy.task)).not.toBe(newTaskId(source.task))
    expect(copy.task).toMatchObject({ kind: 'new' })
  })

  test('only a session that will create a task plans an id', () => {
    const bound = makeSession(settings, { task: { kind: 'existing', taskId: 'task-1' } })
    const taskless = makeSession(settings, { task: { kind: 'none' } })
    expect(bound.task).toEqual({ kind: 'existing', taskId: 'task-1' })
    expect(taskless.task).toEqual({ kind: 'none' })
    expect(newTaskId(taskless.task)).toBeNull()
  })
})
