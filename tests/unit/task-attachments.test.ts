import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { githubIssue, REPO, repoRead } from './helpers/task-fixtures'
import { openTaskTestHost } from './helpers/task-test-host'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: Solus does not own a task; it owns what it attaches to one: session
// links, links to works, plans, automations and pull requests, and snoozes.
// They key on the task key and need no copy of the task, because a host that
// never reads a provider (the organization's Solus API) still holds them.

const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'alice' }, displayName: 'Alice' } }
/** A task key this host has no copy of. */
const UNREAD = 'jira:site:10042'
const ALICE = 'user:alice'
const BOB = 'user:bob'

let host: Awaited<ReturnType<typeof openTaskTestHost>>
let attachments: typeof import('@solus/server/data/tasks/task-attachments')
let links: typeof import('@solus/server/data/tasks/task-links')
let sessions: typeof import('@solus/server/data/tasks/task-sessions')
let snoozes: typeof import('@solus/server/data/tasks/task-snoozes')
let store: typeof import('@solus/server/data/tasks/task-store')
let sources: typeof import('@solus/server/data/tasks/task-sources')

beforeAll(async () => {
  host = await openTaskTestHost('task-attachments')
  attachments = await import('@solus/server/data/tasks/task-attachments')
  links = await import('@solus/server/data/tasks/task-links')
  sessions = await import('@solus/server/data/tasks/task-sessions')
  snoozes = await import('@solus/server/data/tasks/task-snoozes')
  store = await import('@solus/server/data/tasks/task-store')
  sources = await import('@solus/server/data/tasks/task-sources')
})
afterEach(() => host.reset())
afterAll(() => host.close())

describe('attachments of a task this host never read', () => {
  test('a link, its activity, and its unlink need no copy of the task and call no provider', async () => {
    await attachments.linkTask('local', UNREAD, { kind: 'automation', targetKey: 'auto-1', title: 'Nightly' }, BY)
    const linked = await attachments.taskAttachments('local', UNREAD)
    expect(linked.links).toMatchObject([{ taskId: UNREAD, kind: 'automation', targetKey: 'auto-1', title: 'Nightly', createdBy: BY }])
    expect(linked.activity).toMatchObject([{ kind: 'task_changed', change: 'linked' }])

    await attachments.unlinkTask('local', UNREAD, 'automation', 'auto-1', '', BY)
    const unlinked = await attachments.taskAttachments('local', UNREAD)
    expect(unlinked.links).toEqual([])
    // Two changes in one millisecond have no sure order, so the test names the set.
    expect(unlinked.activity.map((entry) => entry.kind === 'task_changed' && entry.change).sort()).toEqual(['linked', 'unlinked'])
    expect(host.providers.calls).toEqual([])
    expect(await store.loadTask(UNREAD)).toBeNull()
  })

  test('an id that is not a task key is refused: an id from before tasks were provider-owned names nothing', async () => {
    await expect(attachments.linkTask('local', '01HZX3K5V0ULIDOFANOLDTASK00', { kind: 'work', targetKey: 'work-1', title: 'A' }, BY))
      .rejects.toThrow('is not a task of GitHub or Jira')
    await expect(attachments.linkTaskSession('local', 'T-184', 'session-1')).rejects.toThrow('is not a task of GitHub or Jira')
    await expect(snoozes.snoozeTaskFor('local', ALICE, 'T-184', Date.now() + 1_000)).rejects.toThrow('is not a task of GitHub or Jira')
  })

  test('an attachment is in the organization of who made it, and another organization does not read it', async () => {
    await attachments.linkTask('org-1', UNREAD, { kind: 'automation', targetKey: 'auto-1', title: 'Nightly' }, BY)
    await attachments.linkTaskSession('org-1', UNREAD, 'session-1')
    expect((await attachments.taskAttachments('org-1', UNREAD)).links).toHaveLength(1)
    expect(await attachments.taskAttachments('org-2', UNREAD)).toEqual({ links: [], activity: [] })
    expect(await sessions.taskSessions('org-2', UNREAD)).toEqual({})
    // An unlink from another organization removes nothing.
    await attachments.unlinkTask('org-2', UNREAD, 'automation', 'auto-1', '', BY)
    await attachments.unlinkTaskSession('org-2', UNREAD, 'session-1', BY)
    expect((await attachments.taskAttachments('org-1', UNREAD)).links).toHaveLength(1)
    expect((await sessions.taskSessions('org-1', UNREAD))[UNREAD]).toHaveLength(1)
  })

  test('two organizations on one host that link one target to one task key have two links', async () => {
    // WHY: a task key is the provider's, so two organizations of the Solus API
    // can name the same public issue and the same pull request. One row for
    // both would let one organization change or remove the other's link.
    const pr = { kind: 'pr' as const, targetKey: '12', targetScope: 'github.com/acme/app', url: 'https://github.com/acme/app/pull/12' }
    await attachments.linkTask('org-1', UNREAD, { ...pr, title: 'Title of organization 1' }, BY)
    await attachments.linkTask('org-2', UNREAD, { ...pr, title: 'Title of organization 2' }, BY)
    await attachments.linkTask('org-2', UNREAD, { kind: 'work', targetKey: 'work-1', title: 'A', pinned: true }, BY)
    await attachments.linkTask('org-1', UNREAD, { kind: 'work', targetKey: 'work-1', title: 'A', pinned: true }, BY)
    expect((await attachments.taskAttachments('org-1', UNREAD)).links.find((link) => link.kind === 'pr')?.title).toBe('Title of organization 1')
    expect((await attachments.taskAttachments('org-2', UNREAD)).links.find((link) => link.kind === 'pr')?.title).toBe('Title of organization 2')

    await attachments.unlinkTask('org-1', UNREAD, 'pr', '12', 'github.com/acme/app', BY)
    await attachments.linkTask('org-1', UNREAD, { kind: 'work', targetKey: 'work-1', title: 'A', pinned: false }, BY)
    const other = (await attachments.taskAttachments('org-2', UNREAD)).links
    expect(other.map((link) => link.kind).sort()).toEqual(['pr', 'work'])
    // The pin is each organization's own.
    expect(other.find((link) => link.kind === 'work')?.pinned).toBe(true)
  })

  test('a snooze is one person\'s own and needs no copy of the task', async () => {
    const until = Date.now() + 3_600_000
    expect(await snoozes.snoozeTaskFor('local', ALICE, UNREAD, until, '  after the release  '))
      .toEqual({ taskId: UNREAD, snoozedUntil: until, snoozeNote: 'after the release' })
    expect(await snoozes.readTaskSnoozes('local', ALICE)).toEqual([{ taskId: UNREAD, snoozedUntil: until, snoozeNote: 'after the release' }])
    // Alice deferring a task must not take it out of Bob's list.
    expect(await snoozes.readTaskSnoozes('local', BOB)).toEqual([])
    expect(await snoozes.snoozeTaskFor('local', ALICE, UNREAD, null)).toBeNull()
    expect(await snoozes.readTaskSnoozes('local', ALICE)).toEqual([])
  })
})

describe('session links', () => {
  test('a session has one working task: a second working link moves it, a reference does not', async () => {
    // WHY: one conversation must not show under two task rows.
    await attachments.linkTaskSession('local', 'github:I_1', 'session-1')
    await attachments.linkTaskSession('local', 'github:I_2', 'session-1', 'referenced')
    await attachments.linkTaskSession('local', 'github:I_3', 'session-1')

    const byTask = await sessions.taskSessions('local')
    expect(byTask['github:I_1']).toBeUndefined()
    expect(byTask['github:I_2'].map((link) => link.role)).toEqual(['referenced'])
    expect(byTask['github:I_3'].map((link) => link.role)).toEqual(['working'])
    expect(await sessions.taskIdForSession('local', 'session-1')).toBe('github:I_3')
    // The task that lost the session records that Solus moved it.
    expect((await attachments.taskAttachments('local', 'github:I_1')).activity.map((entry) => entry.kind === 'task_changed' && entry.change).sort())
      .toEqual(['session_started', 'unlinked'])
  })

  test('linking the same session again is not a second session start', async () => {
    await attachments.linkTaskSession('local', UNREAD, 'session-1', 'working', { startedBy: BY })
    await attachments.linkTaskSession('local', UNREAD, 'session-1')
    const link = (await sessions.taskSessions('local', UNREAD))[UNREAD][0]
    expect(link.startedBy).toEqual(BY)
    expect((await attachments.taskAttachments('local', UNREAD)).activity).toHaveLength(1)
  })

  test('the task of a session is answered with its attempts only when the host has a copy of the task', async () => {
    await attachments.linkTaskSession('local', UNREAD, 'session-1')
    expect(await sessions.tasksForSession('local', 'session-1')).toBeNull()

    host.providers.answer(REPO, repoRead([githubIssue(1)]))
    await sources.tasksSources([host.project([REPO])], ALICE)
    await sources.taskSourceReadsEnd()
    await attachments.linkTaskSession('local', 'github:I_1', 'session-2')
    const found = await sessions.tasksForSession('local', 'session-2')
    expect(found?.task).toMatchObject({ id: 'github:I_1', reference: 'acme/app#1' })
    expect(found?.attempts.map((link) => link.sessionId)).toEqual(['session-2'])
  })

  test('what a working session made goes to its task, and a session with no task links nothing', async () => {
    await attachments.linkTaskSession('local', UNREAD, 'session-1')
    expect(await attachments.linkSessionOutput('local', 'session-1', { kind: 'work', targetKey: 'work-1', title: 'Report' })).toBe(UNREAD)
    expect((await attachments.taskAttachments('local', UNREAD)).links).toMatchObject([{ kind: 'work', targetKey: 'work-1', ownerSessionId: 'session-1' }])
    // Loose conversations are ordinary, not an error.
    expect(await attachments.linkSessionOutput('local', 'loose-session', { kind: 'work', targetKey: 'work-2', title: 'Orphan' })).toBeNull()

    // The output leaves the task with the session that made it.
    await attachments.unlinkTaskSession('local', UNREAD, 'session-1', BY)
    expect((await attachments.taskAttachments('local', UNREAD)).links).toEqual([])
  })
})

describe('links', () => {
  test('pinning one artifact unpins the other, and a re-link that says nothing about pinning keeps the pin', async () => {
    // WHY: a task page opens with exactly one render. Every other writer of a
    // link knows nothing about pinning, so absence must not mean "unpin".
    await attachments.linkTask('local', UNREAD, { kind: 'work', targetKey: 'work-a', title: 'A', pinned: true }, BY)
    await attachments.linkTask('local', UNREAD, { kind: 'work', targetKey: 'work-b', title: 'B', pinned: true }, BY)
    await attachments.linkTask('local', UNREAD, { kind: 'work', targetKey: 'work-b', title: 'B renamed' }, BY)
    const pinned = (await attachments.taskAttachments('local', UNREAD)).links.filter((link) => link.pinned)
    expect(pinned.map((link) => link.targetKey)).toEqual(['work-b'])

    // A pin is not a link: moving it adds no second "linked" line to the feed.
    await attachments.linkTask('local', UNREAD, { kind: 'work', targetKey: 'work-b', title: 'B', pinned: false }, BY)
    const after = await attachments.taskAttachments('local', UNREAD)
    expect(after.links.some((link) => link.pinned)).toBe(false)
    expect(after.activity.filter((entry) => entry.kind === 'task_changed' && entry.change === 'linked')).toHaveLength(2)
  })

  test('the reverse read names each task on an edge: by its copy when the host has one, else by its key', async () => {
    // WHY: a conversation card says "Linked to acme/app#1 · Issue 1" from this read alone.
    host.providers.answer(REPO, repoRead([githubIssue(1, { state: { name: 'Closed', category: 'done' } })]))
    await sources.tasksSources([host.project([REPO])], ALICE)
    await sources.taskSourceReadsEnd()
    await attachments.linkTask('local', 'github:I_1', { kind: 'plan', targetScope: 'session-1', targetKey: 'plan-1', title: 'A plan' }, BY)
    await attachments.linkTask('local', UNREAD, { kind: 'plan', targetScope: 'session-1', targetKey: 'plan-1', title: 'A plan' }, BY)

    const target = { kind: 'plan' as const, targetScope: 'session-1', targetKey: 'plan-1' }
    const linked = await links.readTasksLinkingTargets(store.database(), 'local', [target, { kind: 'automation', targetScope: '', targetKey: 'nothing-links-this' }])
    expect(linked.find((edge) => edge.taskId === 'github:I_1')).toMatchObject({ title: 'Issue 1', category: 'done', reference: 'acme/app#1' })
    const unread = linked.find((edge) => edge.taskId === UNREAD)
    expect(unread).toMatchObject({ title: UNREAD, category: 'open' })
    expect(unread?.reference).toBeUndefined()
    expect(linked).toHaveLength(2)

    // Unlink on the card is the reverse state: the next read must not still say "Linked".
    await attachments.unlinkTask('local', UNREAD, 'plan', 'plan-1', 'session-1', BY)
    expect((await links.readTasksLinkingTargets(store.database(), 'local', [target])).map((edge) => edge.taskId)).toEqual(['github:I_1'])
    expect(await links.readTasksLinkingTargets(store.database(), 'org-2', [target])).toEqual([])
  })

  test('a pull request link has one identity, its repository, whatever spelling linked it', async () => {
    const url = 'https://github.com/Acme/App/pull/12'
    await attachments.linkTask('local', UNREAD, { kind: 'pr', targetKey: '12', targetScope: '/checkout/path', url, title: 'Fix it' }, BY)
    await attachments.linkTask('local', UNREAD, { kind: 'pr', targetKey: '12', targetScope: 'github.com/acme/app', url, automatic: true }, BY)
    const prs = (await attachments.taskAttachments('local', UNREAD)).links
    expect(prs).toMatchObject([{ kind: 'pr', targetScope: 'github.com/acme/app', targetKey: '12', title: 'Fix it' }])
    // A pull request that live work links is one PR sync reads: a task with no copy is not known to be done.
    expect(await links.readPrLinkInterests(store.database(), 'local')).toMatchObject([{ projectScope: 'github.com/acme/app', number: 12, isActive: true }])
  })
})
