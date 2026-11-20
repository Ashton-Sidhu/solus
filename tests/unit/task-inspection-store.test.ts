import { describe, expect, test } from 'bun:test'
import { TaskInspectionStore } from '@solus/client-core/task-inspection'
import { serializeTaskWrite } from '@solus/server/data/tasks/task-writes'
import type { TaskInspection } from '@solus/contracts/task-inspection'

const inspection = (cursor: string | null, ids: string[]): TaskInspection => ({
  author: 'Ada',
  assignees: [],
  reactions: [],
  events: ids.map((id, i) => ({ id, at: i, actor: 'Ada', text: 'changed state' })),
  historyCursor: cursor,
  pullRequests: [],
  capabilities: { history: true, reactions: true, multipleAssignees: true, templates: true }
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('provider task inspection', () => {
  test('a failed continuation retains rows and cursor, so retry can finish the same page', async () => {
    let fail = true
    const store = new TaskInspectionStore('github:I1', () => ({
      tasksInspect: async (_id, cursor) => {
        if (!cursor) return inspection('older', ['new'])
        if (fail) throw new Error('rate limited')
        return inspection(null, ['old', 'new'])
      },
      tasksReact: async () => {}
    }))
    await store.refresh()
    await store.loadMore()
    expect(store.current.value?.events.map((event) => event.id)).toEqual(['new'])
    expect(store.current.value?.historyCursor).toBe('older')
    expect(store.current.error).toBe('rate limited')
    fail = false
    await store.loadMore()
    expect(new Set(store.current.value?.events.map((event) => event.id))).toEqual(
      new Set(['old', 'new'])
    )
    expect(store.current.value?.historyCursor).toBeNull()
  })
  test('a page that finishes after a refresh cannot replace current history', async () => {
    const older = deferred<TaskInspection>()
    let reads = 0
    const store = new TaskInspectionStore('github:I1', () => ({
      tasksInspect: async (_id, cursor) =>
        cursor ? older.promise : inspection('older', [++reads === 1 ? 'first' : 'fresh']),
      tasksReact: async () => {}
    }))
    await store.refresh()
    const page = store.loadMore()
    await store.refresh()
    older.resolve(inspection(null, ['stale']))
    await page
    expect(store.current.value?.events.map((event) => event.id)).toEqual(['fresh'])
  })
  test('a disconnected API getter ends loading and leaves a retryable error', async () => {
    const store = new TaskInspectionStore('github:I1', () => {
      throw new Error('disconnected')
    })
    await store.refresh()
    expect(store.current.pending).toBe(false)
    expect(store.current.error).toBe('disconnected')
  })
})

test('writes to one task stay in order, and a refused write does not block the next', async () => {
  const release = deferred<void>(),
    order: string[] = []
  const first = serializeTaskWrite('github:I1', async () => {
    order.push('first')
    await release.promise
    throw new Error('refused')
  })
  const second = serializeTaskWrite('github:I1', async () => {
    order.push('second')
    return 'ok'
  })
  const other = serializeTaskWrite('github:I2', async () => {
    order.push('other')
  })
  await other
  expect(order).toEqual(['first', 'other'])
  release.resolve()
  await expect(first).rejects.toThrow('refused')
  expect(await second).toBe('ok')
  expect(order).toEqual(['first', 'other', 'second'])
})

test('an account change discards an in-flight inspection and permits a new read', async () => {
  const old = deferred<TaskInspection>()
  let first = true
  const store = new TaskInspectionStore('github:I1', () => ({
    tasksInspect: async () => {
      if (first) {
        first = false
        return old.promise
      }
      return inspection(null, ['new account'])
    },
    tasksReact: async () => {}
  }))
  const reading = store.refresh()
  await Promise.resolve()
  store.reset()
  await store.refresh()
  old.resolve(inspection(null, ['old account']))
  await reading
  expect(store.current.value?.events.map((event) => event.id)).toEqual(['new account'])
  expect(store.current.pending).toBe(false)
})

test('templates from a previous source cannot replace the current source choices', async () => {
  const { TaskTemplateStore } = await import('@solus/client-core/task-inspection')
  const slow =
    deferred<
      Array<{ id: string; name: string; description: string; title: string; body: string }>
    >()
  const store = new TaskTemplateStore()
  const api = {
    tasksTemplates: async (source: import('@solus/contracts/task-sources').TaskSource) =>
      source.kind === 'github-repo' && source.repo === 'old'
        ? slow.promise
        : [{ id: 'new', name: 'New template', description: '', title: '', body: '' }]
  }
  const reading = store.load(api, { kind: 'github-repo', owner: 'acme', repo: 'old' })
  expect(store.pending).toBe(true)
  await store.load(api, { kind: 'github-repo', owner: 'acme', repo: 'new' })
  slow.resolve([{ id: 'old', name: 'Old template', description: '', title: '', body: '' }])
  await reading
  expect(store.templates.map((template) => template.id)).toEqual(['new'])
  expect(store.pending).toBe(false)
})

test('a reaction waits for an older read, then reads the provider after the accepted write', async () => {
  const old = deferred<TaskInspection>(), accepted = deferred<void>()
  let reads = 0
  const store = new TaskInspectionStore('github:I1', () => ({
    tasksInspect: async () => ++reads === 1 ? old.promise : inspection(null, ['after write']),
    tasksReact: async () => { accepted.resolve() },
  }))
  const reading = store.refresh()
  const writing = store.react('I1', 'HEART', true)
  await accepted.promise
  old.resolve(inspection(null, ['before write']))
  await Promise.all([reading, writing])
  expect(reads).toBe(2)
  expect(store.current.value?.events.map((event) => event.id)).toEqual(['after write'])
})
