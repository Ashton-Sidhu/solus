import { describe, expect, test } from 'bun:test'
import { mergeTaskComments, TaskDataStore } from '@solus/client-core/task-data'
import { serializeTaskWrite } from '@solus/server/data/tasks/task-writes'
import type { TaskProviderData } from '@solus/contracts/task-data'

const inspection = (cursor: string | null, ids: string[]): TaskProviderData => ({
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

describe('provider task data', () => {
  test('history that came with the details needs no second read, and older pages still load', async () => {
    // WHY: GitHub's detail read carries the newest page of history. Asking for
    // it again doubled the issue page's round trips.
    const reads: Array<string | undefined> = []
    const store = new TaskDataStore('github:I1', () => ({
      issuesGet: async (_id, read) => {
        reads.push(read?.cursor)
        return inspection(null, ['old'])
      },
      issuesReact: async () => {}
    }))
    // Jira's detail read carries history too; the section keeps its capabilities.
    const jira = { history: true, reactions: false, multipleAssignees: false, templates: false }
    await store.loadProvider({ ...inspection('older', ['new']), capabilities: jira })
    expect(reads).toEqual([])
    expect(store.current.provider.value?.events.map((event) => event.id)).toEqual(['new'])
    expect(store.current.provider.value?.capabilities).toEqual(jira)

    await store.loadOlderHistory()
    expect(reads).toEqual(['older'])
    expect(store.current.provider.value?.events.map((event) => event.id)).toEqual(['old', 'new'])
  })

  test('loads older GitHub comments and keeps local attribution on duplicate comments', async () => {
    const comment = (id: string) => ({ id, providerCommentId: id, issueId: 'github:I1', body: id, createdAt: 1 })
    const store = new TaskDataStore('github:I1', () => ({
      issuesGet: async (_id, read) => read?.cursor
        ? { ...inspection(null, []), comments: [comment('old'), comment('new')] }
        : { ...inspection('older:1', []), comments: [comment('new')] },
      issuesReact: async () => {}
    }))
    await store.loadProvider()
    await store.loadOlderHistory()
    const local = { ...comment('new'), id: 'local-comment', originSessionId: 'session' }
    expect(mergeTaskComments([local], store.current.provider.value?.comments ?? [])).toEqual([
      comment('old'), local,
    ])
  })

  test('a failed continuation retains rows and cursor, so retry can finish the same page', async () => {
    let fail = true
    const store = new TaskDataStore('github:I1', () => ({
      issuesGet: async (_id, read) => {
        if (!read?.cursor) return inspection('older', ['new'])
        if (fail) throw new Error('rate limited')
        return inspection(null, ['old', 'new'])
      },
      issuesReact: async () => {}
    }))
    await store.loadProvider()
    await store.loadOlderHistory()
    expect(store.current.provider.value?.events.map((event) => event.id)).toEqual(['new'])
    expect(store.current.provider.value?.historyCursor).toBe('older')
    expect(store.current.provider.error).toBe('rate limited')
    fail = false
    await store.loadOlderHistory()
    expect(new Set(store.current.provider.value?.events.map((event) => event.id))).toEqual(
      new Set(['old', 'new'])
    )
    expect(store.current.provider.value?.historyCursor).toBeNull()
  })
  test('a page that finishes after a refresh cannot replace current history', async () => {
    const older = deferred<TaskProviderData>()
    let reads = 0
    const store = new TaskDataStore('github:I1', () => ({
      issuesGet: async (_id, read) =>
        read?.cursor ? older.promise : inspection('older', [++reads === 1 ? 'first' : 'fresh']),
      issuesReact: async () => {}
    }))
    await store.loadProvider()
    const page = store.loadOlderHistory()
    await store.loadProvider()
    older.resolve(inspection(null, ['stale']))
    await page
    expect(store.current.provider.value?.events.map((event) => event.id)).toEqual(['fresh'])
    expect(store.current.provider.loadingMore).toBe(false)
  })
  test('a disconnected API getter ends loading and leaves a retryable error', async () => {
    const store = new TaskDataStore('github:I1', () => {
      throw new Error('disconnected')
    })
    await store.loadProvider()
    expect(store.current.provider.pending).toBe(false)
    expect(store.current.provider.error).toBe('disconnected')
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
  const old = deferred<TaskProviderData>()
  let first = true
  const store = new TaskDataStore('github:I1', () => ({
    issuesGet: async () => {
      if (first) {
        first = false
        return old.promise
      }
      return inspection(null, ['new account'])
    },
    issuesReact: async () => {}
  }))
  const reading = store.loadProvider()
  await Promise.resolve()
  store.reset()
  await store.loadProvider()
  old.resolve(inspection(null, ['old account']))
  await reading
  expect(store.current.provider.value?.events.map((event) => event.id)).toEqual(['new account'])
  expect(store.current.provider.pending).toBe(false)
})

test('templates from a previous source cannot replace the current source choices', async () => {
  const { TaskTemplateStore } = await import('@solus/client-core/task-data')
  const slow =
    deferred<
      Array<{ id: string; name: string; description: string; title: string; body: string }>
    >()
  const store = new TaskTemplateStore()
  const api = {
    issuesTemplates: async (source: import('@solus/contracts/task-sources').IssueSource) =>
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
  const old = deferred<TaskProviderData>(),
    accepted = deferred<void>()
  let reads = 0
  const store = new TaskDataStore('github:I1', () => ({
    issuesGet: async () => (++reads === 1 ? old.promise : inspection(null, ['after write'])),
    issuesReact: async () => {
      accepted.resolve()
    }
  }))
  const reading = store.loadProvider()
  const writing = store.react('I1', 'HEART', true)
  await accepted.promise
  old.resolve(inspection(null, ['before write']))
  await Promise.all([reading, writing])
  expect(reads).toBe(2)
  expect(store.current.provider.value?.events.map((event) => event.id)).toEqual(['after write'])
})
