import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { taskSourceKey } from '@solus/contracts/task-sources'
import { TASKS_AUTH_ERROR_PREFIX } from '@solus/contracts/task-types'
import { BOARD, boardRead, githubDraft, githubIssue, JIRA, jiraIssue, jiraRead, REPO, repoRead } from './helpers/task-fixtures'
import { openTaskTestHost } from './helpers/task-test-host'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: GitHub and Jira own every task. A change that the provider did not
// take must never show as made: the host's copy changes only from a provider
// answer. The one thing Solus holds back is a comment that was not sent.

const ALICE = 'user:alice'
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'alice' }, displayName: 'Alice' } }
const ISSUE = 'github:I_1'
const REPO_KEY = taskSourceKey(REPO)
const BOARD_KEY = taskSourceKey(BOARD)

let host: Awaited<ReturnType<typeof openTaskTestHost>>
let tasks: typeof import('@solus/server/data/tasks/task')
let store: typeof import('@solus/server/data/tasks/task-store')
let sources: typeof import('@solus/server/data/tasks/task-sources')
let attachments: typeof import('@solus/server/data/tasks/task-attachments')
let sessionTask: typeof import('@solus/server/data/tasks/session-task')
let states: typeof import('@solus/server/data/sessions/session-states')
let search: typeof import('@solus/server/data/tasks/comment-search')

beforeAll(async () => {
  host = await openTaskTestHost('task-writes')
  tasks = await import('@solus/server/data/tasks/task')
  store = await import('@solus/server/data/tasks/task-store')
  sources = await import('@solus/server/data/tasks/task-sources')
  attachments = await import('@solus/server/data/tasks/task-attachments')
  sessionTask = await import('@solus/server/data/tasks/session-task')
  states = await import('@solus/server/data/sessions/session-states')
  search = await import('@solus/server/data/tasks/comment-search')
})
afterEach(() => host.reset())
afterAll(() => host.close())

/** Read these sources into the host's copy as Alice. */
async function readSources(...which: Array<typeof REPO>): Promise<string> {
  const cwd = host.project(which)
  await sources.tasksSources([cwd], ALICE)
  await sources.taskSourceReadsEnd()
  return cwd
}

async function settledAt(sessionId: string): Promise<number | null> {
  return (await new states.SessionShelf(sessionId).state()).settledAt
}

describe('a task write goes to the provider first', () => {
  test('an update that the provider takes changes the copy and tells clients', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    const named: Array<string | undefined> = []
    const stop = store.onTasksChanged((taskId) => named.push(taskId))

    const updated = await tasks.updateTask(ISSUE, { title: 'New title', labels: ['bug'] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    stop()
    expect(updated).toMatchObject({ title: 'New title', labels: ['bug'] })
    expect((await store.loadTask(ISSUE))?.title).toBe('New title')
    expect(host.providers.tasks.get(ISSUE)?.title).toBe('New title')
    expect(named).toEqual([ISSUE])
  })

  test('an update that the provider refuses leaves the copy as it was, and the caller gets the error', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    host.providers.failure = new Error('Validation Failed')
    await expect(tasks.updateTask(ISSUE, { title: 'New title' })).rejects.toThrow('Validation Failed')
    expect((await store.loadTask(ISSUE))?.title).toBe('Issue 1')
  })

  test('a write with no connection carries the marker that lets a client offer to connect', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    host.providers.failure = new Error('GitHub is not connected')
    await expect(tasks.updateTask(ISSUE, { title: 'New title' })).rejects.toThrow(TASKS_AUTH_ERROR_PREFIX)
  })

  test('a field the provider does not take for this task is refused before any provider call', async () => {
    // A GitHub issue that is on no Project has no priority field to write.
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    const before = host.providers.calls.length
    await expect(tasks.updateTask(ISSUE, { priority: 'high' })).rejects.toThrow('does not take a change of the priority')
    expect(host.providers.calls).toHaveLength(before)
  })

  test('a body with a local asset is sent with the provider URL, and an asset the provider cannot hold is refused', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    const asset = `asset://${'a'.repeat(64)}`
    const updated = await tasks.updateTask(ISSUE, { body: `![shot](${asset}.png)` })
    expect(updated.body).toBe('![shot](https://provider.example/asset)')

    host.providers.unpublishable = ['html']
    await expect(tasks.updateTask(ISSUE, { body: `[page](${asset}.html)` })).rejects.toThrow('GitHub cannot hold .html attachments')
    expect((await store.loadTask(ISSUE))?.body).toBe('![shot](https://provider.example/asset)')
  })

  test('a task the host never read is read from its provider before a write', async () => {
    host.providers.hold(githubIssue(5))
    const updated = await tasks.updateTask('github:I_5', { title: 'Found by key' })
    expect(updated.title).toBe('Found by key')
    expect(host.providers.calls).toEqual(['fetch:github:I_5', 'update:github:I_5'])
  })
})

describe('moving a task', () => {
  test('a move to a column of a board writes that board and changes the category', async () => {
    const issue = githubIssue(1)
    host.providers.answer(REPO, repoRead([issue]))
    host.providers.answer(BOARD, boardRead([{ task: issue, columnId: 'opt-todo' }]))
    await readSources(REPO, BOARD)
    expect((await store.loadTask(ISSUE))?.category).toBe('open')

    const moved = await tasks.moveTask(ISSUE, { sourceKey: BOARD_KEY, columnId: 'opt-doing' })
    expect(host.providers.callsOf('move:')).toEqual([`move:${BOARD_KEY}:${ISSUE}:opt-doing`])
    // GitHub has no state for work in progress: the board column is what makes the task active.
    expect(moved.category).toBe('active')
    expect(moved.state).toEqual({ name: 'Open', category: 'open' })
    expect(moved.placements).toContainEqual({ sourceKey: BOARD_KEY, columnId: 'opt-doing' })
  })

  test('a move to a category closes a GitHub issue and puts it in the first done column of each board', async () => {
    const issue = githubIssue(1)
    host.providers.answer(REPO, repoRead([issue]))
    host.providers.answer(BOARD, boardRead([{ task: issue, columnId: 'opt-doing' }]))
    await readSources(REPO, BOARD)

    const moved = await tasks.moveTask(ISSUE, { category: 'done' })
    expect(host.providers.calls.slice(-2)).toEqual([`setState:${ISSUE}:done`, `move:${BOARD_KEY}:${ISSUE}:opt-done`])
    expect(moved.category).toBe('done')
    expect(moved.placements).toEqual([
      { sourceKey: BOARD_KEY, columnId: 'opt-done' },
      // The repository column follows the state: nobody has to read the source again.
      { sourceKey: REPO_KEY, columnId: 'closed' },
    ])
  })

  test('a move to the category a task has already makes no provider call', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    const before = host.providers.calls.length
    await tasks.moveTask(ISSUE, { category: 'active' })
    // An open issue on no board has nothing that can say "active".
    expect(host.providers.calls).toHaveLength(before)
  })

  test('a Jira move fails loudly when the workflow has no transition, and the copy does not change', async () => {
    host.providers.answer(JIRA, jiraRead([jiraIssue(1)]))
    await readSources(JIRA)
    host.providers.failure = new Error("No Jira transition from SOL-1's current status reaches done.")
    await expect(tasks.moveTask('jira:site:10001', { category: 'done' })).rejects.toThrow('No Jira transition')
    expect((await store.loadTask('jira:site:10001'))?.state.name).toBe('To Do')
  })

  test('a Jira move to a category changes the state and the column of the project source', async () => {
    host.providers.answer(JIRA, jiraRead([jiraIssue(1)]))
    await readSources(JIRA)
    const moved = await tasks.moveTask('jira:site:10001', { category: 'active' })
    expect(moved).toMatchObject({ category: 'active', state: { name: 'In Progress', category: 'active' } })
    expect(moved.placements).toEqual([{ sourceKey: taskSourceKey(JIRA), columnId: '3' }])
  })

  test('a status in words is a category or the name of a column, and another word is refused with the choices', async () => {
    const issue = githubIssue(1)
    host.providers.answer(BOARD, boardRead([{ task: issue, columnId: 'opt-todo' }]))
    await readSources(BOARD)
    expect((await tasks.moveTaskToStatus(ISSUE, 'in progress')).placements).toEqual([{ sourceKey: BOARD_KEY, columnId: 'opt-doing' }])
    expect((await tasks.moveTaskToStatus(ISSUE, 'Done')).category).toBe('done')
    await expect(tasks.moveTaskToStatus(ISSUE, 'in_review')).rejects.toThrow('or a column: Todo, In progress, Done')
  })
})

describe('creating and deleting a task', () => {
  test('a new task is created in the default source of the project and shows in it', async () => {
    host.providers.answer(REPO, repoRead([]))
    host.providers.answer(BOARD, boardRead([]))
    const cwd = host.project([REPO, BOARD], BOARD_KEY)

    const created = await tasks.createTask({ cwd, title: 'Plan the launch' }, ALICE)
    // The default source is a GitHub Project, so the task is a draft item.
    expect(created).toMatchObject({ kind: 'draft', title: 'Plan the launch', url: null })
    expect(created.placements).toEqual([{ sourceKey: BOARD_KEY, columnId: null }])
    expect(host.providers.callsOf('create:')).toEqual([`create:${BOARD_KEY}`])
    expect((await store.listTasks({ personKey: ALICE, scope: 'local' })).map((task) => task.id)).toEqual([created.id])

    const inRepo = await tasks.createTask({ cwd, title: 'Fix the crash', sourceKey: REPO_KEY }, ALICE)
    expect(inRepo).toMatchObject({ kind: 'issue', placements: [{ sourceKey: REPO_KEY, columnId: 'open' }] })
  })

  test('a project with no task source has no place for a task, and the error says so', async () => {
    const cwd = host.project([])
    await expect(tasks.createTask({ cwd, title: 'Nowhere' }, ALICE)).rejects.toThrow('This project has no task source')
    expect(host.providers.calls).toEqual([])
  })

  test('a source of another project is refused', async () => {
    const cwd = host.project([REPO])
    await expect(tasks.createTask({ cwd, title: 'Elsewhere', sourceKey: BOARD_KEY }, ALICE)).rejects.toThrow('is not one of this project')
  })

  test('only a draft item can be deleted; an issue is closed or moved', async () => {
    const draft = githubDraft('DI_1')
    const issue = githubIssue(1)
    host.providers.answer(BOARD, boardRead([{ task: draft, columnId: 'opt-todo' }, { task: issue, columnId: 'opt-todo' }]))
    await readSources(BOARD)

    await expect(tasks.deleteTask(ISSUE)).rejects.toThrow('is an issue')
    expect(host.providers.callsOf('remove:')).toEqual([])

    await attachments.linkTaskSession('local', 'github:DI_1', 'session-1')
    expect(await tasks.deleteTask('github:DI_1')).toBe(true)
    expect(await store.loadTask('github:DI_1')).toBeNull()
    // Nothing can name the draft again, so its attachments go with it.
    expect(await attachments.taskAttachments('local', 'github:DI_1')).toEqual({ links: [], activity: [] })
  })
})

describe('reading one task', () => {
  test('a read asks the provider, and keeps its comments so they can be searched', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    host.providers.hold(githubIssue(1, { title: 'Changed on GitHub', updatedAt: 9_000 }))
    host.providers.comments.set(ISSUE, [{ id: 'IC_1', author: 'octocat', body: 'The flaky spec is quarantined', createdAt: 4_000 }])

    const details = await tasks.getTask('local', ISSUE)
    expect(details.fromCache).toBeUndefined()
    expect(details.task.title).toBe('Changed on GitHub')
    expect(details.comments).toMatchObject([{ externalAuthor: 'octocat', body: 'The flaky spec is quarantined' }])
    expect(details.comments[0].unsent).toBeUndefined()

    const hits = await search.searchTaskComments({ personKey: ALICE, scope: 'local' }, { query: 'quarantined' })
    expect(hits.map((hit) => hit.taskId)).toEqual([ISSUE])
    // A person whose connection never read the source does not find the task by its comments.
    expect(await search.searchTaskComments({ personKey: 'user:bob', scope: 'local' }, { query: 'quarantined' })).toEqual([])

    // A second read does not copy the comment again, and a comment deleted on the provider goes.
    await tasks.getTask('local', ISSUE)
    expect((await tasks.taskDetails('local', ISSUE)).comments).toHaveLength(1)
    host.providers.comments.set(ISSUE, [])
    expect((await tasks.getTask('local', ISSUE)).comments).toEqual([])
  })

  test('when the provider does not answer, the answer is the last copy, marked as from the cache', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    host.providers.failure = new Error('socket hang up')
    const details = await tasks.getTask('local', ISSUE)
    expect(details.fromCache).toBe(true)
    expect(details.task.title).toBe('Issue 1')
  })

  test('a task with no copy and no provider answer is an error, not an empty task', async () => {
    host.providers.failure = new Error('socket hang up')
    await expect(tasks.getTask('local', 'github:I_404')).rejects.toThrow('socket hang up')
  })
})

describe('a comment that the provider did not take', () => {
  test('stays on the host as unsent with the reason, is sent again on retry, and then is a provider comment', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    host.providers.failure = new Error('socket hang up')

    const failed = await tasks.commentOnTask('local', ISSUE, { body: 'Ready for review', by: BY })
    expect(failed.comments).toMatchObject([{ body: 'Ready for review', unsent: true, sendError: 'socket hang up', author: BY }])
    const commentId = failed.comments[0].id

    // Still offline: the comment stays, with the new reason.
    host.providers.failure = new Error('still offline')
    expect((await tasks.retryTaskComment('local', ISSUE, commentId)).comments[0]).toMatchObject({ unsent: true, sendError: 'still offline' })

    host.providers.failure = null
    const sent = await tasks.retryTaskComment('local', ISSUE, commentId)
    expect(sent.comments).toHaveLength(1)
    expect(sent.comments[0].unsent).toBeUndefined()
    expect(sent.comments[0].sendError).toBeUndefined()
    expect(host.providers.comments.get(ISSUE)?.map((comment) => comment.body)).toEqual(['Ready for review'])

    // The next read finds the same comment on the provider and does not make a second row.
    const read = await tasks.getTask('local', ISSUE)
    expect(read.comments).toHaveLength(1)
    expect(read.comments[0].author).toEqual(BY)
    // A sent comment is the provider's: Solus does not send or discard it again.
    await expect(tasks.retryTaskComment('local', ISSUE, commentId)).rejects.toThrow('on the provider already')
    await expect(tasks.deleteTaskComment('local', ISSUE, commentId)).rejects.toThrow('on the provider already')
  })

  test('can be discarded, and then nothing is sent', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    host.providers.failure = new Error('socket hang up')
    const failed = await tasks.commentOnTask('local', ISSUE, { body: 'Never mind', by: BY })
    host.providers.failure = null

    expect((await tasks.deleteTaskComment('local', ISSUE, failed.comments[0].id)).comments).toEqual([])
    expect(host.providers.comments.get(ISSUE)).toBeUndefined()
  })

  test('a comment with an asset the provider cannot hold is refused and not kept: it could never be sent', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    host.providers.unpublishable = ['html']
    await expect(tasks.commentOnTask('local', ISSUE, { body: `[page](asset://${'a'.repeat(64)}.html)`, by: BY })).rejects.toThrow('cannot hold .html')
    expect((await tasks.taskDetails('local', ISSUE)).comments).toEqual([])
  })

  test('a comment delivered two times under one id is posted one time', async () => {
    // WHY: a dispatched session's comment arrives through the outbox, which delivers again after a lost answer.
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    await tasks.commentOnTask('local', ISSUE, { id: 'op-1', body: 'From the agent', by: BY })
    await tasks.commentOnTask('local', ISSUE, { id: 'op-1', body: 'From the agent', by: BY })
    expect(host.providers.comments.get(ISSUE)).toHaveLength(1)
  })
})

describe('a finished task ends the work of its sessions', () => {
  test('a write that makes the task done settles its working session, and a reopen makes it active again', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    await attachments.linkTaskSession('local', ISSUE, 'session-1')
    await attachments.linkTaskSession('local', ISSUE, 'session-ref', 'referenced')

    await tasks.moveTask(ISSUE, { category: 'done' })
    expect(await settledAt('session-1')).not.toBeNull()
    // A session the task only refers to is not the task's work.
    expect(await settledAt('session-ref')).toBeNull()

    await tasks.moveTask(ISSUE, { category: 'open' })
    expect(await settledAt('session-1')).toBeNull()
  })

  test('a source read that finds the task closed on the provider settles its session too', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    const cwd = await readSources(REPO)
    await attachments.linkTaskSession('local', ISSUE, 'session-1')

    // Somebody closed the issue on GitHub.
    host.providers.answer(REPO, repoRead([githubIssue(1, { state: { name: 'Closed', category: 'done' }, updatedAt: 3_000 })]))
    await sources.tasksSources([cwd], ALICE, { refresh: 'force' })
    await sources.taskSourceReadsEnd()
    expect(await settledAt('session-1')).not.toBeNull()
  })

  test('a detail read that finds the task closed settles its session too', async () => {
    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await readSources(REPO)
    await attachments.linkTaskSession('local', ISSUE, 'session-1')
    host.providers.hold(githubIssue(1, { state: { name: 'Closed', category: 'done' }, updatedAt: 3_000 }))
    await tasks.getTask('local', ISSUE)
    expect(await settledAt('session-1')).not.toBeNull()
  })
})

describe('a session that starts on a task', () => {
  test('binds the session and moves an open task to active on the provider', async () => {
    const issue = jiraIssue(1)
    host.providers.answer(JIRA, jiraRead([issue]))
    await readSources(JIRA)
    const task = await sessionTask.prepareSessionTask('local', { taskId: 'jira:site:10001', sessionId: 'session-1' })
    expect(task).toMatchObject({ category: 'active', state: { name: 'In Progress' } })
    expect(host.providers.callsOf('setState:')).toEqual(['setState:jira:site:10001:active'])
    expect((await attachments.taskAttachments('local', 'jira:site:10001')).activity).toMatchObject([
      { kind: 'task_changed', change: 'session_started', target: { kind: 'session', key: 'session-1' } },
    ])
  })

  test('a failed move to active does not stop the session', async () => {
    host.providers.answer(JIRA, jiraRead([jiraIssue(1)]))
    await readSources(JIRA)
    host.providers.failure = new Error("No Jira transition from SOL-1's current status reaches active.")
    const task = await sessionTask.prepareSessionTask('local', { taskId: 'jira:site:10001', sessionId: 'session-1' })
    expect(task?.category).toBe('open')
  })

  test('a task the host cannot read is still bound: the link needs no copy', async () => {
    host.providers.failure = new Error('GitHub is not connected')
    const task = await sessionTask.prepareSessionTask('local', { taskId: 'github:I_77', sessionId: 'session-1' })
    expect(task).toBeNull()
    const { taskSessions } = await import('@solus/server/data/tasks/task-sessions')
    expect((await taskSessions('local', 'github:I_77'))['github:I_77'].map((link) => link.sessionId)).toEqual(['session-1'])
  })

  test('a resumed provider session is bound already: nothing is read or written', async () => {
    expect(await sessionTask.prepareSessionTask('local', { taskId: ISSUE, sessionId: 'session-1', existingAgentSessionId: 'thread-1' })).toBeNull()
    expect(host.providers.calls).toEqual([])
  })
})
