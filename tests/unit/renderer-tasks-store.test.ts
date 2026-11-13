import { afterAll, afterEach, describe, expect, jest, test } from 'bun:test'
import type {
  Task as TaskRecord,
  TaskDetails,
  TaskLink,
  TaskSidebarFilter,
  TaskSidebarSnapshot,
  TaskSummary,
} from '@solus/contracts/task-types'
import {
  BOARD_SOURCE_KEY,
  REPO_SOURCE_KEY,
  createTasksWorld,
  disposeTasksWorlds,
  draftRow,
  issueRecord,
  issueRow,
  sessionLink,
  settle,
  snapshotOf,
  sourceState,
} from './helpers/tasks-world'

// These tests run the task stores on Svelte's runtime, without a component.
// GitHub and Jira own every task (docs/plans/provider-owned-tasks.md): a task
// id here is a task key, and each fake host answers what a real host answers.

afterAll(disposeTasksWorlds)
afterEach(() => jest.useRealTimers())

const TASK = 'github:I_1'

function detailsOf(task: TaskRecord, overrides: Partial<TaskDetails> = {}): TaskDetails {
  return { task, comments: [], links: [], activity: [], ...overrides }
}

function reconnect(world: Awaited<ReturnType<typeof createTasksWorld>>, serverId: string): void {
  world.connections.emitReadiness(serverId, 'reconnecting')
  world.connections.emitReadiness(serverId, 'ready')
}

describe('renderer task hydration', () => {
  test('a list row never blanks the body or the epic a detail read filled in', async () => {
    // WHY: the sidebar snapshot carries `TaskSummary` rows, without body or
    // epic (plans/029 §8), and every `tasks.invalidated` re-hydrates from it.
    // A row that spoke for the body would empty the open task page on each
    // refresh. A full record still clears an epic it no longer has.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: async () => snapshotOf([issueRow()]) })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const epic = { provider: 'jira' as const, externalId: 'ACME-7', url: 'https://acme.atlassian.net/browse/ACME-7', title: 'Release 2.0', body: 'Ship it.' }
    const full = issueRecord(TASK, { body: 'Full body', epic })
    const hydrated = store.get(TASK).hydrate(full)
    expect(hydrated.body).toBe('Full body')
    expect(hydrated.epic).toEqual(epic)

    const { body: _body, epic: _epic, ...summary } = full
    const listRow: TaskSummary = summary
    hydrated.hydrate(listRow)
    expect(hydrated.body).toBe('Full body')
    expect(hydrated.epic).toEqual(epic)

    const { epic: _dropped, ...withoutEpic } = full
    hydrated.hydrate(withoutEpic)
    expect(hydrated.body).toBe('Full body')
    expect(hydrated.epic).toBeUndefined()
  })

  test('a re-read that changes nothing keeps the identity of the composite fields', async () => {
    // WHY: each read hands the task fresh arrays. Most reads change nothing,
    // and a new identity would invalidate every derived that reads the
    // placements or the labels: the board, the lists, and the sidebar's pull
    // request discovery, whose effect issued the read.
    const world = await createTasksWorld()
    const row = () => issueRow(TASK, { labels: ['bug'], pr: { number: 5, url: 'https://github.com/acme/app/pull/5' } })
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: async () => snapshotOf([row()]) })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const task = store.get(TASK)
    const held = { placements: task.placements, labels: task.labels, state: task.state, pr: task.pr, writableFields: task.writableFields }

    await store.load()
    expect({ placements: task.placements, labels: task.labels, state: task.state, pr: task.pr, writableFields: task.writableFields })
      .toEqual(held)
    expect(task.placements).toBe(held.placements)
    expect(task.labels).toBe(held.labels)
    expect(task.state).toBe(held.state)
    expect(task.pr).toBe(held.pr)

    // A column change on the provider is a change.
    task.hydrate(issueRow(TASK, { labels: ['bug'], placements: [{ sourceKey: REPO_SOURCE_KEY, columnId: 'closed' }] }))
    expect(task.placements).not.toBe(held.placements)
    expect(task.placements).toEqual([{ sourceKey: REPO_SOURCE_KEY, columnId: 'closed' }])
    expect(task.labels).toBe(held.labels)
  })

  test('a task is one object per task key, so a detail read reaches every holder', async () => {
    // WHY: the task key is the only id of a task. A surface that held a second
    // copy could render a task the rest of the workspace had already moved
    // past. One object per key makes that impossible: a reference taken before
    // a read sees the result of it.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()]),
      tasksGet: async () => detailsOf(issueRecord(TASK, { title: 'Read from the provider' }), {
        comments: [{ id: 'comment-1', taskId: TASK, body: 'Landed', createdAt: 1 }],
      }),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const heldBeforeTheRead = store.get(TASK)
    expect(heldBeforeTheRead.id).toBe(TASK)
    expect(store.get(TASK)).toBe(heldBeforeTheRead)
    expect(store.tasks[0]).toBe(heldBeforeTheRead)

    await store.get(TASK).loadDetails()

    expect(heldBeforeTheRead.details?.comments).toHaveLength(1)
    expect(heldBeforeTheRead.title).toBe('Read from the provider')
  })

  test('a task key that no host described is not a task to draw', async () => {
    // WHY: `get` mints a task for a deep link or a session link. Until a host
    // describes it, a surface must not draw its empty defaults as a real task.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: async () => snapshotOf([]) })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const minted = store.get('jira:cloud-1:10001')
    expect(minted.isKnown).toBe(false)
    expect(store.peek('jira:cloud-1:10001')).toBeNull()
    expect(store.tasks).toHaveLength(0)

    minted.hydrate(issueRecord('jira:cloud-1:10001', { providerId: 'jira', reference: 'SOL-1' }), 'local')
    expect(store.peek('jira:cloud-1:10001')).toBe(minted)
  })

  test('only a draft item can be deleted', async () => {
    // WHY: an issue belongs to GitHub or Jira and is closed there. Only a draft
    // item of a GitHub Project is removed, so no surface may offer Delete for
    // an issue, or for a key that no host described.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow(), draftRow('github:DI_1')]),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.get(TASK).canDelete).toBe(false)
    expect(store.get('github:DI_1').canDelete).toBe(true)
    expect(store.get('github:DI_unknown').canDelete).toBe(false)
  })

  test('a field can be written only when the provider takes it for this task', async () => {
    // WHY: a GitHub issue takes a priority only when a Project it is on has
    // that field. A control for a field the provider drops would lose input.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow(TASK, { writableFields: ['title', 'labels'] })]),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.get(TASK).canWrite('labels')).toBe(true)
    expect(store.get(TASK).canWrite('priority')).toBe(false)
  })

  test('loads assignees lazily and reuses the result of one source', async () => {
    // WHY: repositories can have many assignable users. Opening a task must
    // not fetch them until the user opens the assignee menu. The people for a
    // new task depend on the source it is created in.
    const world = await createTasksWorld()
    const calls: unknown[] = []
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()]),
      tasksListAssigneeCandidates: async (target: unknown) => {
        calls.push(target)
        return [{ login: 'octocat', avatarUrl: 'https://avatars.test/octocat' }]
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const target = { source: sourceState(REPO_SOURCE_KEY).source }

    expect(calls).toHaveLength(0)
    await store.loadAssigneeCandidates(target)
    await store.loadAssigneeCandidates(target)

    expect(calls).toEqual([target])
    expect(store.assigneeCandidates(target)).toEqual([
      { login: 'octocat', avatarUrl: 'https://avatars.test/octocat' },
    ])
    // Another source has its own people.
    expect(store.assigneeCandidates({ source: sourceState(BOARD_SOURCE_KEY).source })).toEqual([])

    await store.loadAssigneeCandidates({ taskId: TASK })
    expect(calls.at(-1)).toEqual({ taskId: TASK })
  })

  test('only the working link answers for a session, whatever order the snapshot lists it', async () => {
    // WHY: a task that merely references a session lists it, but does not own
    // it. Letting that link claim the session sent the next prompt, and its
    // sidebar row, to the referrer instead of the task the work belongs to.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf(
        [issueRow('github:I_referrer'), issueRow('github:I_owner')],
        {
          'github:I_referrer': [sessionLink('shared-session', { role: 'referenced', linkedAt: 2 })],
          'github:I_owner': [sessionLink('shared-session', { role: 'working', linkedAt: 1 })],
        },
      ),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.taskForSession('shared-session')?.id).toBe('github:I_owner')
    expect(store.get('github:I_referrer').sessions.map((attempt) => attempt.sessionId)).toEqual(['shared-session'])
  })

  test('creates a new task through the task host, in the source it names', async () => {
    // WHY: a task belongs to no project, so no project names a host. The task
    // host — this device when it runs agents — has the provider connection
    // that reads the person's sources. Another connected host must not take
    // the write only because it is the primary connection.
    const world = await createTasksWorld()
    const created: Array<{ serverId: string; input: unknown }> = []
    world.connections.registerPrimary('workshop', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()]),
      tasksCreate: async (input: unknown) => {
        created.push({ serverId: 'workshop', input })
        return issueRecord('github:I_created_workshop')
      },
    })
    world.connections.registerHost('local', {
      tasksSidebarSnapshot: async () => snapshotOf([]),
      tasksCreate: async (input: unknown) => {
        created.push({ serverId: 'local', input })
        return issueRecord('github:I_created_local')
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const source = sourceState(REPO_SOURCE_KEY).source

    const task = await store.create({ source, title: 'On this device' })

    expect(created).toEqual([{ serverId: 'local', input: { source, title: 'On this device' } }])
    expect(store.get(task.id).serverId).toBe('local')
    // The provider took the task, so the list shows it before the next snapshot.
    expect(store.tasks.map((row) => row.id)).toContain('github:I_created_local')
  })

  test('a create that the provider refuses throws and lists nothing', async () => {
    // WHY: there are no local tasks. A task that GitHub or Jira did not take
    // does not exist, so the list must not show a row for it.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([]),
      tasksCreate: async () => { throw new Error('This project has no task source.') },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    await expect(store.create({ cwd: '/workspace/app', title: 'Nowhere' }, 'local')).rejects.toThrow('no task source')
    expect(store.tasks).toHaveLength(0)
  })

  test('an attempt is running only while its host says so, not because it is linked', async () => {
    // WHY: the task board used to call every task with a linked session
    // "Agent running", so a task whose agent stopped hours ago still showed a
    // live tint. A link says a session exists; only the host knows if it works.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: async () => snapshotOf([issueRow()]) })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const link = { sessionId: 'session-1', executionServerId: null }
    const noTab = () => undefined

    expect(store.isAttemptRunning(link, 'local', noTab)).toBe(false)

    world.connections.emit('local', 'session.statusChanged', {
      sessionId: 'session-1', agentSessionId: null, status: 'running', at: 1,
    })
    expect(store.isAttemptRunning(link, 'local', noTab)).toBe(true)
    // The same session id on another host is another session.
    expect(store.isAttemptRunning(link, 'other-host', noTab)).toBe(false)

    world.connections.emit('local', 'session.statusChanged', {
      sessionId: 'session-1', agentSessionId: null, status: 'awaiting_input', at: 2,
    })
    expect(store.isAttemptRunning(link, 'local', noTab)).toBe(false)

    // A turn that ends while the client is away never reaches it, so a
    // dropped host must not leave its sessions running forever.
    world.connections.emit('local', 'session.statusChanged', {
      sessionId: 'session-1', agentSessionId: null, status: 'running', at: 3,
    })
    world.connections.emitReadiness('local', 'reconnecting')
    expect(store.isAttemptRunning(link, 'local', noTab)).toBe(false)

    // An open tab knows its own status, even for a turn that began before
    // this client connected and so was never announced to it.
    expect(store.isAttemptRunning(link, 'local', () => ({ status: 'running' }))).toBe(true)
  })

  test('refreshes visible task details without fanning out through the hidden cache', async () => {
    // WHY: Hidden tabs stay mounted. A task invalidation must not turn every task
    // detail ever opened in those tabs into a simultaneous RPC.
    jest.useFakeTimers()
    const world = await createTasksWorld()
    const detailReads: string[] = []
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow('github:I_visible'), issueRow('github:I_hidden')]),
      tasksGet: async (taskId: string) => {
        detailReads.push(taskId)
        return detailsOf(issueRecord(taskId))
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    await store.get('github:I_visible').loadDetails()
    await store.get('github:I_hidden').loadDetails()
    detailReads.splice(0)

    const stopWatching = store.get('github:I_visible').watchDetails()
    world.connections.emit('local', 'tasks.invalidated', {})
    jest.advanceTimersByTime(101)
    await settle()

    expect(detailReads).toEqual(['github:I_visible'])
    stopWatching()
  })

  test('a named task change re-reads that task alone and merges it in place', async () => {
    // WHY: the whole sidebar list is over a megabyte at a thousand tasks, and
    // agents change titles and branches every few seconds. Re-reading the whole
    // list for each of those sent ~15 MB a minute to every connected client.
    jest.useFakeTimers()
    const world = await createTasksWorld()
    const sidebarReads: Array<string[] | undefined> = []
    let rows = [
      issueRow('github:I_renamed', { title: 'Old title' }),
      issueRow('github:I_gone'),
      issueRow('github:I_untouched'),
    ]
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async (filter?: TaskSidebarFilter) => {
        sidebarReads.push(filter?.taskIds)
        const tasks = filter?.taskIds ? rows.filter((row) => filter.taskIds?.includes(row.id)) : rows
        return snapshotOf(tasks, Object.fromEntries(tasks.map((row) => [row.id, [sessionLink(`${row.id}-session`)]])))
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const untouched = store.get('github:I_untouched')
    sidebarReads.splice(0)

    rows = [{ ...rows[0], title: 'New title' }, rows[2]]
    world.connections.emit('local', 'tasks.invalidated', { taskId: 'github:I_renamed' })
    world.connections.emit('local', 'tasks.invalidated', { taskId: 'github:I_gone' })
    jest.advanceTimersByTime(101)
    await settle()

    expect(sidebarReads).toEqual([['github:I_renamed', 'github:I_gone']])
    expect(store.get('github:I_renamed').title).toBe('New title')
    expect(store.tasks.map((row) => row.id)).toEqual(['github:I_renamed', 'github:I_untouched'])
    expect(store.taskForSession('github:I_gone-session')).toBeNull()
    expect(store.taskForSession('github:I_renamed-session')?.id).toBe('github:I_renamed')
    expect(store.tasks[1]).toBe(untouched)

    // A host that cannot name the change (a source refresh) still gets the whole list.
    world.connections.emit('local', 'tasks.invalidated', {})
    jest.advanceTimersByTime(101)
    await settle()
    expect(sidebarReads).toEqual([['github:I_renamed', 'github:I_gone'], undefined])
  })

  test('coalesces detail reads for the same task', async () => {
    // WHY: the visible task page and its project rail can ask for the same detail
    // on one frame. They must share the RPC rather than racing duplicate reads.
    const world = await createTasksWorld()
    let detailReads = 0
    const details = Promise.withResolvers<TaskDetails>()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()]),
      tasksGet: () => {
        detailReads++
        return details.promise
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const first = store.get(TASK).loadDetails()
    const second = store.get(TASK).loadDetails()

    expect(first).toBe(second)
    details.resolve(detailsOf(issueRecord()))
    await first
    expect(detailReads).toBe(1)
  })

  test('a task opened by its key is read from a host that runs projects, when no list has it', async () => {
    // WHY: a deep link or an agent tool can name a task that no snapshot
    // lists (a truncated source, a task that only a session link names). Only
    // a host with task sources and a provider connection can read it; the
    // organization's Solus API holds attachments and must not be asked.
    const world = await createTasksWorld()
    const asked: string[] = []
    world.attachmentOnlyHosts.add('cloud')
    world.connections.registerPrimary('cloud', {
      tasksSidebarSnapshot: async () => snapshotOf([]),
      tasksGet: async () => {
        asked.push('cloud')
        throw new Error('The Solus API does not read tasks.')
      },
    })
    world.connections.registerHost('workshop', {
      tasksSidebarSnapshot: async () => snapshotOf([]),
      tasksGet: async (id: string) => {
        asked.push('workshop')
        return detailsOf(issueRecord(id, { title: 'Direct issue' }))
      },
    })
    const store = new world.TasksStore()

    const details = await store.get('github:I_87').loadDetails()

    expect(details.task.title).toBe('Direct issue')
    expect(store.get('github:I_87').serverId).toBe('workshop')
    expect(asked).not.toContain('cloud')
  })

  test('the detail read fails with a reason when no connected host has the task', async () => {
    // WHY: the task page shows "no such task" from this error. A read that
    // stayed pending would show a loading state that never ends.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([]),
      tasksGet: async () => { throw new Error('Not Found') },
    })
    const store = new world.TasksStore()

    await expect(store.get('github:I_404').loadDetails()).rejects.toThrow('No connected host has this task.')
  })
})

describe('reading tasks from more than one host', () => {
  test('reloads after a host is restored during the cold snapshot', async () => {
    // WHY: restored tabs can create their host connection while the first task
    // read is in flight. The completed lifecycle on that host must reach the
    // first stable sidebar instead of waiting for later typing or task activity.
    const world = await createTasksWorld()
    const localSnapshot = Promise.withResolvers<TaskSidebarSnapshot>()
    const remoteSnapshot = Promise.withResolvers<TaskSidebarSnapshot>()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: () => localSnapshot.promise })
    const store = new world.TasksStore()
    const firstLoad = store.ensureLoaded()
    await settle()

    world.connectHost('remote', { tasksSidebarSnapshot: () => remoteSnapshot.promise })
    localSnapshot.resolve(snapshotOf([]))
    await settle()

    expect(store.loaded).toBe(true)
    expect(store.tasks).toEqual([])

    remoteSnapshot.resolve(snapshotOf(
      [issueRow('github:I_remote', { category: 'done', state: { name: 'Closed', category: 'done' } })],
      { 'github:I_remote': [sessionLink('restored-session')] },
    ))
    await firstLoad

    expect(store.taskForSession('restored-session')?.category).toBe('done')
    expect(store.get('github:I_remote').serverId).toBe('remote')
  })

  test('shows a healthy host before a slow connected host answers', async () => {
    // WHY: one slow machine must not hold every other machine's tasks back.
    const world = await createTasksWorld()
    const slow = Promise.withResolvers<TaskSidebarSnapshot>()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()], { [TASK]: [sessionLink('healthy-session')] }),
    })
    world.connections.registerHost('slow', { tasksSidebarSnapshot: () => slow.promise })
    const store = new world.TasksStore()
    const load = store.load()
    await settle()
    expect(store.loaded).toBe(true)
    expect(store.loading).toBe(true)
    expect(store.taskForSession('healthy-session')?.id).toBe(TASK)
    slow.resolve(snapshotOf([issueRow('github:I_slow')]))
    await load
    expect(store.tasks.map((row) => row.id)).toEqual([TASK, 'github:I_slow'])
    expect(store.loading).toBe(false)
  })

  test('does not let an offline host block healthy sidebar sessions', async () => {
    // WHY: saved hosts are supervised before their first successful socket.
    // An unreachable host's RPC queue must not keep the local task snapshot in
    // the loading state, or every session row disappears from the sidebar.
    const world = await createTasksWorld()
    let localReads = 0
    let remoteReads = 0
    const remoteSnapshot = Promise.withResolvers<TaskSidebarSnapshot>()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => {
        localReads++
        return snapshotOf([issueRow('github:I_local')], { 'github:I_local': [sessionLink('local-session')] })
      },
    })
    world.connections.registerHost('remote', {
      tasksSidebarSnapshot: () => {
        remoteReads++
        return remoteSnapshot.promise
      },
    })
    world.connections.emitReadiness('remote', 'unreachable')
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.loaded).toBe(true)
    expect(store.taskForSession('local-session')?.id).toBe('github:I_local')
    expect(remoteReads).toBe(0)

    world.connections.emitReadiness('remote', 'ready')
    remoteSnapshot.resolve(snapshotOf([issueRow('github:I_remote')], { 'github:I_remote': [sessionLink('remote-session', { linkedAt: 2 })] }))
    await settle()

    expect(store.taskForSession('remote-session')?.id).toBe('github:I_remote')
    expect(store.taskForSession('local-session')?.id).toBe('github:I_local')
    expect(remoteReads).toBe(1)
    expect(localReads).toBe(1)
  })

  test('a host whose snapshot rejects as unreachable does not keep the sidebar loading', async () => {
    // WHY: a call to an unreachable host rejects with HostUnreachableError.
    // A pass in which every read failed must still end the loading state, even
    // when another host joins and the read runs once more; otherwise the
    // sidebar keeps its skeleton for as long as the first host is down.
    const { HostUnreachableError } = await import('@solus/client-core/rpc-error')
    const world = await createTasksWorld()
    const local = Promise.withResolvers<TaskSidebarSnapshot>()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: () => local.promise })
    world.connections.registerHost('remote', { tasksSidebarSnapshot: () => new Promise<TaskSidebarSnapshot>(() => {}) })
    world.connections.emitReadiness('remote', 'checking')
    const store = new world.TasksStore()
    void store.load()
    // The remote host is accepted while the first pass waits, so the read runs one more pass.
    world.connections.emitReadiness('remote', 'ready')
    local.reject(new HostUnreachableError('local'))
    await settle()

    expect(store.loaded).toBe(true)
    // The next pass still waits on the remote host; the sidebar shows what it has.
    expect(store.loading).toBe(true)
  })

  test('a host that fails its read is reported and does not empty the other hosts', async () => {
    // WHY: losing one machine must not read as "the sidebar lost my tasks".
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: async () => snapshotOf([issueRow()]) })
    world.connections.registerHost('broken', { tasksSidebarSnapshot: async () => { throw new Error('database is locked') } })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.tasks.map((row) => row.id)).toEqual([TASK])
    expect(store.error).toBe("Couldn't read tasks from 1 host.")
  })

  test('a reconnecting host re-reads its own list, not every host\'s', async () => {
    // WHY: a granted socket re-dials each time its grant expires (ten
    // minutes). Reading every host on that edge re-read each other host's
    // full list — over a megabyte at a thousand tasks. The host that was away
    // still needs a full read: it missed its invalidations, so a task that
    // left its sources meanwhile must leave the list.
    const world = await createTasksWorld()
    let localReads = 0
    let remoteReads = 0
    let remoteTasks = [issueRow('github:I_kept'), issueRow('github:I_gone')]
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => {
        localReads++
        return snapshotOf([issueRow('github:I_local')])
      },
    })
    world.connections.registerHost('remote', {
      tasksSidebarSnapshot: async () => {
        remoteReads++
        return snapshotOf(remoteTasks)
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    expect(store.tasks.map((row) => row.id).sort()).toEqual(['github:I_gone', 'github:I_kept', 'github:I_local'])

    remoteTasks = [issueRow('github:I_kept'), issueRow('github:I_new')]
    reconnect(world, 'remote')
    await settle()

    expect(localReads).toBe(1)
    expect(remoteReads).toBe(2)
    expect(store.tasks.map((row) => row.id).sort()).toEqual(['github:I_kept', 'github:I_local', 'github:I_new'])
  })

  test('a reconnect resumes from the revision on screen instead of reading the whole list', async () => {
    // WHY: web and mobile clients connect again often, and most times nothing
    // changed. The host names what changed after the revision this client
    // holds; a task it names and leaves out has gone, and a task it does not
    // name keeps its row. A host that gives no revision is read whole, as before.
    const world = await createTasksWorld()
    const reads: Array<TaskSidebarFilter | undefined> = []
    let answer: TaskSidebarSnapshot = {
      ...snapshotOf([issueRow('github:I_kept'), issueRow('github:I_edited'), issueRow('github:I_gone')]),
      revision: 'boot.1.reader',
    }
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async (filter?: TaskSidebarFilter) => {
        reads.push(filter)
        return answer
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const keptRow = store.get('github:I_kept')

    answer = { tasks: [], sessionsByTask: {}, revision: 'boot.1.reader', changedTaskIds: [] }
    reconnect(world, 'local')
    await settle()
    expect(reads.at(-1)).toEqual({ since: 'boot.1.reader' })
    expect(store.tasks.map((row) => row.id)).toEqual(['github:I_kept', 'github:I_edited', 'github:I_gone'])

    answer = {
      tasks: [issueRow('github:I_edited', { title: 'Edited while away' })],
      sessionsByTask: {},
      revision: 'boot.3.reader',
      changedTaskIds: ['github:I_edited', 'github:I_gone'],
    }
    reconnect(world, 'local')
    await settle()
    expect(store.tasks.map((row) => row.id)).toEqual(['github:I_kept', 'github:I_edited'])
    expect(store.get('github:I_edited').title).toBe('Edited while away')
    expect(store.get('github:I_kept')).toBe(keptRow)

    // A restarted or older host answers whole, without a revision: the next
    // reconnect cannot resume and reads the whole list again.
    answer = snapshotOf([issueRow('github:I_kept')])
    reconnect(world, 'local')
    await settle()
    expect(reads.at(-1)).toEqual({ since: 'boot.3.reader' })
    expect(store.tasks.map((row) => row.id)).toEqual(['github:I_kept'])
    reconnect(world, 'local')
    await settle()
    expect(reads.at(-1)).toBeUndefined()
    expect(reads).toHaveLength(5)
  })

  test('two hosts that list the same task give one task, read by the first host in catalog order', async () => {
    // WHY: two machines can list the same board, and a task is one task key.
    // The sidebar keys its rows by that key, so a second copy breaks the keyed
    // block. One host must read and write the task, or a write would go to
    // whichever host answered last.
    const world = await createTasksWorld()
    const updatedOn: string[] = []
    const shared = issueRow('github:I_shared')
    world.connections.registerPrimary('first', {
      tasksSidebarSnapshot: async () => snapshotOf([{ ...shared, title: 'As the first host read it' }], { 'github:I_shared': [sessionLink('first-session', { linkedAt: 1 })] }),
      tasksUpdate: async () => {
        updatedOn.push('first')
        return issueRecord('github:I_shared')
      },
    })
    world.connections.registerHost('second', {
      tasksSidebarSnapshot: async () => snapshotOf([{ ...shared, title: 'As the second host read it' }], { 'github:I_shared': [sessionLink('second-session', { linkedAt: 2 })] }),
      tasksUpdate: async () => {
        updatedOn.push('second')
        return issueRecord('github:I_shared')
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.tasks.map((entry) => entry.id)).toEqual(['github:I_shared'])
    expect(store.get('github:I_shared').serverId).toBe('first')
    expect(store.get('github:I_shared').title).toBe('As the first host read it')
    // Each host's session links are attachments of the one task key.
    expect(store.get('github:I_shared').sessions.map((link) => link.sessionId)).toEqual(['second-session', 'first-session'])

    await store.get('github:I_shared').update({ title: 'Renamed' })
    expect(updatedOn).toEqual(['first'])
  })

  test('the first host in catalog order reads a shared task also when it answers last', async () => {
    // WHY: which host reads a task must not depend on which answered first, or
    // the reader would change from one load to the next.
    const world = await createTasksWorld()
    const preferred = Promise.withResolvers<TaskSidebarSnapshot>()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: () => preferred.promise })
    world.connections.registerHost('mirror', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()], { [TASK]: [sessionLink('mirror-session', { linkedAt: 1 })] }),
    })
    const store = new world.TasksStore()
    const load = store.load()
    await settle()
    expect(store.get(TASK).serverId).toBe('mirror')
    preferred.resolve(snapshotOf([issueRow()], { [TASK]: [sessionLink('primary-session', { linkedAt: 2 })] }))
    await load
    expect(store.tasks.map((row) => row.id)).toEqual([TASK])
    expect(store.get(TASK).serverId).toBe('local')
    // The link that the other host holds is still a link of the task.
    expect(store.taskForSession('mirror-session')?.id).toBe(TASK)
    expect(store.taskForSession('primary-session')?.id).toBe(TASK)
  })

  test('a task leaves the list only when no host lists it', async () => {
    // WHY: one source can be in the projects of two machines. When one machine
    // drops the source, the task is still a task of the other machine's project.
    const world = await createTasksWorld()
    let firstRows = [issueRow()]
    let secondRows = [issueRow()]
    world.connections.registerPrimary('first', { tasksSidebarSnapshot: async () => snapshotOf(firstRows) })
    world.connections.registerHost('second', { tasksSidebarSnapshot: async () => snapshotOf(secondRows) })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    expect(store.get(TASK).serverId).toBe('first')

    firstRows = []
    reconnect(world, 'first')
    await settle()
    expect(store.tasks.map((row) => row.id)).toEqual([TASK])
    // The host that still lists the task reads and writes it now.
    expect(store.get(TASK).serverId).toBe('second')

    secondRows = []
    reconnect(world, 'second')
    await settle()
    expect(store.tasks).toHaveLength(0)
  })

  test('shows task rows and session ownership as one sidebar snapshot', async () => {
    // WHY: restored sessions must never render between independently timed task
    // and link reads. The host response is the renderer's atomic boundary.
    const world = await createTasksWorld()
    const snapshot = Promise.withResolvers<TaskSidebarSnapshot>()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: () => snapshot.promise })
    const store = new world.TasksStore()
    const hydration = store.ensureLoaded()
    await settle()

    expect(store.tasks).toEqual([])
    expect(store.loaded).toBe(false)
    expect(store.taskForSession('resumed-session')).toBeNull()

    snapshot.resolve(snapshotOf(
      [issueRow('github:I_parent'), issueRow('github:I_child')],
      {
        'github:I_parent': [sessionLink('resumed-session', { role: 'referenced', linkedAt: 0 })],
        'github:I_child': [sessionLink('resumed-session')],
      },
    ))
    await hydration

    expect(store.loaded).toBe(true)
    expect(store.taskForSession('resumed-session')?.id).toBe('github:I_child')
    expect(store.tasks.map(({ id }) => id).sort()).toEqual(['github:I_child', 'github:I_parent'])
    expect(store.get('github:I_parent').sessions.map(({ sessionId }) => sessionId)).toEqual(['resumed-session'])
    expect(store.get('github:I_child').sessions.map(({ sessionId }) => sessionId)).toEqual(['resumed-session'])
  })

  test('keeps a refresh snapshot hidden until its task-session links settle', async () => {
    // WHY: a session start invalidates an already-loaded store. If the new
    // task row showed before its link, the sidebar would show both the task
    // and the loose session until the link request completes.
    const world = await createTasksWorld()
    let snapshotRequest = 0
    const refreshSnapshot = Promise.withResolvers<TaskSidebarSnapshot>()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: () => snapshotRequest++ === 0 ? Promise.resolve(snapshotOf([])) : refreshSnapshot.promise,
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const refresh = store.load()
    await settle()

    expect(store.tasks).toHaveLength(0)
    expect(store.taskForSession('session-1')).toBeNull()

    refreshSnapshot.resolve(snapshotOf([issueRow()], { [TASK]: [sessionLink('session-1')] }))
    await refresh

    expect(store.tasks).toHaveLength(1)
    expect(store.taskForSession('session-1')?.id).toBe(TASK)
  })
})

describe('attachments from a host that does not read the task', () => {
  // The organization's Solus API stores attachments by task key and no tasks
  // (docs/plans/provider-owned-tasks.md §4.3, §7). `workshop` has the project.
  async function twoHosts(cloudFirst = false) {
    const world = await createTasksWorld()
    const answers = {
      workshop: snapshotOf([issueRow()], { [TASK]: [sessionLink('workshop-run', { linkedAt: 1 })] }) as TaskSidebarSnapshot,
      cloud: snapshotOf([], { [TASK]: [sessionLink('cloud-run', { linkedAt: 2 })] }) as TaskSidebarSnapshot,
    }
    const reads = { workshop: 0, cloud: 0 }
    const unlinkedOn: string[] = []
    const api = (name: 'workshop' | 'cloud') => ({
      tasksSidebarSnapshot: async () => {
        reads[name]++
        return answers[name]
      },
      tasksUnlinkSession: async (_taskId: string, sessionId: string) => { unlinkedOn.push(`${name}:${sessionId}`) },
    })
    world.attachmentOnlyHosts.add('cloud')
    if (cloudFirst) {
      world.connections.registerPrimary('cloud', api('cloud'))
      world.connections.registerHost('workshop', api('workshop'))
    } else {
      world.connections.registerPrimary('workshop', api('workshop'))
      world.connections.registerHost('cloud', api('cloud'))
    }
    return { world, answers, reads, unlinkedOn }
  }

  test('its session links join the task that the project host lists', async () => {
    // WHY: a cloud session of an organization files its link with the Solus
    // API, which has no task rows. Without the merge by task key, the task
    // page on the project host would not show the work that runs in the cloud.
    const { world } = await twoHosts()
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const task = store.get(TASK)
    expect(store.tasks.map((row) => row.id)).toEqual([TASK])
    expect(task.serverId).toBe('workshop')
    expect(task.sessions.map((link) => link.sessionId)).toEqual(['cloud-run', 'workshop-run'])
    expect(store.taskForSession('cloud-run')).toBe(task)
  })

  test('its links survive a later snapshot of the project host', async () => {
    // WHY: the project host answers only its own links. If its answer replaced
    // the whole list, each refresh of the project host would drop the cloud
    // sessions until the Solus API was read again.
    const { world, reads } = await twoHosts()
    const store = new world.TasksStore()
    await store.ensureLoaded()

    reconnect(world, 'workshop')
    await settle()

    expect(reads).toEqual({ workshop: 2, cloud: 1 })
    expect(store.get(TASK).sessions.map((link) => link.sessionId)).toEqual(['cloud-run', 'workshop-run'])
    expect(store.taskForSession('cloud-run')?.id).toBe(TASK)
  })

  test('a link goes when the host that held it answers without it', async () => {
    // WHY: each host is the truth for its own links. A link that the Solus API
    // removed must not stay because another host still lists the task.
    const { world, answers } = await twoHosts()
    const store = new world.TasksStore()
    await store.ensureLoaded()

    answers.cloud = snapshotOf([])
    reconnect(world, 'cloud')
    await settle()

    expect(store.get(TASK).sessions.map((link) => link.sessionId)).toEqual(['workshop-run'])
    expect(store.taskForSession('cloud-run')).toBeNull()
    expect(store.taskForSession('workshop-run')?.id).toBe(TASK)
    // The task is still a task of the project host.
    expect(store.tasks.map((row) => row.id)).toEqual([TASK])
  })

  test('a host that holds only attachments never becomes the reader of the task', async () => {
    // WHY: every task read and write goes to `serverId`. The Solus API cannot
    // reach GitHub or Jira, so a write sent there would fail.
    const { world } = await twoHosts(true)
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.get(TASK).serverId).toBe('workshop')
    expect(store.get(TASK).sessions.map((link) => link.sessionId)).toEqual(['cloud-run', 'workshop-run'])
  })

  test('links of a task key that no host listed yet wait for the task', async () => {
    // WHY: the Solus API can answer before the project host connects. Its
    // links must not be lost, and the key alone must not draw an empty row.
    const { world, answers } = await twoHosts()
    world.connections.emitReadiness('workshop', 'unreachable')
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.tasks).toHaveLength(0)
    expect(store.peek(TASK)).toBeNull()
    expect(store.taskForSession('cloud-run')).toBeNull()

    answers.workshop = snapshotOf([issueRow()])
    world.connections.emitReadiness('workshop', 'ready')
    await settle()

    expect(store.tasks.map((row) => row.id)).toEqual([TASK])
    expect(store.get(TASK).sessions.map((link) => link.sessionId)).toEqual(['cloud-run'])
    expect(store.taskForSession('cloud-run')?.id).toBe(TASK)
  })

  test('an unlink of a session goes to the host that holds the link', async () => {
    // WHY: the project host does not know a link that the Solus API holds. An
    // unlink sent to the reader of the task would change nothing, and the next
    // snapshot would bring the link back.
    const { world, unlinkedOn } = await twoHosts()
    const store = new world.TasksStore()
    await store.ensureLoaded()

    await store.get(TASK).unlinkSession('cloud-run')

    expect(unlinkedOn).toEqual(['cloud:cloud-run'])
    expect(store.taskForSession('cloud-run')).toBeNull()
    expect(store.taskForSession('workshop-run')?.id).toBe(TASK)
  })

  test('an unlinked session leaves the list of the task on the same frame', async () => {
    // WHY: every mounted surface must drop the link now. Until the next
    // snapshot the task page would still offer a session that is not linked.
    const { world } = await twoHosts()
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const task = store.get(TASK)
    expect(task.sessions.map((link) => link.sessionId)).toEqual(['cloud-run', 'workshop-run'])

    await task.unlinkSession('cloud-run')

    expect(task.sessions.map((link) => link.sessionId)).toEqual(['workshop-run'])
  })

  test('the detail read adds the links of the other host, and an unlink goes back to it', async () => {
    // WHY: a cloud session's document is linked on the Solus API. The task
    // page must list it beside the links of the project host, and removing it
    // must reach the host that stores it.
    const { world } = await twoHosts()
    const link = (targetKey: string): TaskLink => ({
      taskId: TASK, kind: 'work', targetScope: '', targetKey, title: targetKey, createdBy: { kind: 'system' }, linkedAt: 1,
    })
    const unlinkedOn: string[] = []
    Object.assign(world.connections.apiFor('workshop'), {
      tasksGet: async () => detailsOf(issueRecord(), { links: [link('work-workshop')] }),
      tasksUnlink: async () => {
        unlinkedOn.push('workshop')
        return { links: [], activity: [] }
      },
    })
    Object.assign(world.connections.apiFor('cloud'), {
      tasksAttachments: async () => ({ links: [link('work-cloud')], activity: [] }),
      tasksUnlink: async () => {
        unlinkedOn.push('cloud')
        return { links: [], activity: [] }
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const task = store.get(TASK)

    await task.loadDetails()
    expect(task.details?.links.map((held) => held.targetKey)).toEqual(['work-workshop', 'work-cloud'])

    await task.unlink('work', 'work-cloud')
    expect(unlinkedOn).toEqual(['cloud'])
    expect(task.details?.links.map((held) => held.targetKey)).toEqual(['work-workshop'])
  })

  test('the task page still opens when the other host does not answer its attachments', async () => {
    // WHY: the task comes from the project host. An offline Solus API must
    // cost its links only, not the page.
    const { world } = await twoHosts()
    Object.assign(world.connections.apiFor('workshop'), { tasksGet: async () => detailsOf(issueRecord(TASK, { title: 'Still here' })) })
    Object.assign(world.connections.apiFor('cloud'), { tasksAttachments: async () => { throw new Error('offline') } })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const details = await store.get(TASK).loadDetails()
    expect(details.task.title).toBe('Still here')
  })
})

describe('writes go to the provider first', () => {
  async function oneTask(api: object, row: TaskSummary = issueRow()) {
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: async () => snapshotOf([row]), ...api })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    return { world, store, task: store.get(row.id) }
  }

  test('a move to a status category shows on the same frame and stays when the provider takes it', async () => {
    // WHY: the list is membership, not a second copy. The category written
    // through the task is the category the sidebar row reads, so a finished
    // task does not draw as open while the provider answers.
    const moved = Promise.withResolvers<TaskRecord>()
    const targets: unknown[] = []
    const { store, task } = await oneTask({
      tasksMove: (_id: string, target: unknown) => {
        targets.push(target)
        return moved.promise
      },
    })

    const moving = task.move({ category: 'done' })
    expect(store.tasks[0].category).toBe('done')
    expect(store.upNext).toHaveLength(0)

    moved.resolve(issueRecord(TASK, { category: 'done', state: { name: 'Closed', category: 'done' }, placements: [{ sourceKey: REPO_SOURCE_KEY, columnId: 'closed' }] }))
    await moving

    expect(targets).toEqual([{ category: 'done' }])
    expect(task.category).toBe('done')
    expect(task.state.name).toBe('Closed')
    expect(task.placements).toEqual([{ sourceKey: REPO_SOURCE_KEY, columnId: 'closed' }])
    expect(store.tasks).toHaveLength(1)
  })

  test('a move that the provider refuses puts the old category back and rethrows', async () => {
    // WHY: there is no queue of changes. A card that stayed in Done after
    // GitHub refused would show a state that exists nowhere, and a caller
    // that got no error could not tell the person.
    const refused = Promise.withResolvers<TaskRecord>()
    const { store, task } = await oneTask({ tasksMove: () => refused.promise })

    const moving = task.move({ category: 'done' })
    expect(task.category).toBe('done')
    refused.reject(new Error('GitHub refused the change'))

    await expect(moving).rejects.toThrow('GitHub refused the change')
    expect(task.category).toBe('open')
    expect(store.upNext.map((row) => row.id)).toEqual([TASK])
  })

  test('a move to a column of one source moves the card in that source only, and goes back when refused', async () => {
    // WHY: a task can be on two boards. A drag on one board states the column
    // of that board; the column on the other board is the provider's to decide.
    const refused = Promise.withResolvers<TaskRecord>()
    const row = issueRow(TASK, {
      placements: [
        { sourceKey: REPO_SOURCE_KEY, columnId: 'open' },
        { sourceKey: BOARD_SOURCE_KEY, columnId: 'opt-todo' },
      ],
    })
    const { task } = await oneTask({ tasksMove: () => refused.promise }, row)

    const moving = task.move({ sourceKey: BOARD_SOURCE_KEY, columnId: 'opt-doing' })
    expect(task.placements).toEqual([
      { sourceKey: REPO_SOURCE_KEY, columnId: 'open' },
      { sourceKey: BOARD_SOURCE_KEY, columnId: 'opt-doing' },
    ])
    refused.reject(new Error('Jira refused the transition'))

    await expect(moving).rejects.toThrow('Jira refused the transition')
    expect(task.placements).toEqual(row.placements)
    expect(task.category).toBe('open')
  })

  test('a refused move puts a board item with no column back to no column', async () => {
    // WHY: null is a real place: a board item that has no column yet. The
    // undo of a refused move must not leave the card in the column it never reached.
    const row = draftRow('github:DI_1', { placements: [{ sourceKey: BOARD_SOURCE_KEY, columnId: null }] })
    const { task } = await oneTask({ tasksMove: async () => { throw new Error('refused') } }, row)

    await expect(task.move({ sourceKey: BOARD_SOURCE_KEY, columnId: 'opt-doing' })).rejects.toThrow('refused')
    expect(task.placements).toEqual([{ sourceKey: BOARD_SOURCE_KEY, columnId: null }])
  })

  test('an update keeps the old value when the provider refuses it', async () => {
    // WHY: an edit is not shown before the provider takes it, so a refused
    // edit must leave the title that GitHub or Jira still holds.
    const patches: unknown[] = []
    let refuse = true
    const { task } = await oneTask({
      tasksUpdate: async (_id: string, patch: { title?: string }) => {
        patches.push(patch)
        if (refuse) throw new Error('A field outside the writable fields.')
        return issueRecord(TASK, { title: patch.title })
      },
    })

    await expect(task.update({ title: 'New title' })).rejects.toThrow('writable fields')
    expect(task.title).toBe('Hydrated task')

    refuse = false
    await task.update({ title: 'New title' })
    expect(task.title).toBe('New title')
    expect(patches).toEqual([{ title: 'New title' }, { title: 'New title' }])
  })

  test('a comment that the provider did not take shows as unsent, and can be sent again or discarded', async () => {
    // WHY: each comment is a provider comment. One that did not arrive must
    // say so with its error, so the person does not think the team read it.
    const unsent = { id: 'c1', taskId: TASK, body: 'Posted from Solus', createdAt: 1, unsent: true, sendError: 'GitHub did not answer' }
    const calls: string[] = []
    const { task } = await oneTask({
      tasksComment: async (_id: string, body: string) => {
        calls.push(`comment:${body}`)
        return detailsOf(issueRecord(), { comments: [unsent] })
      },
      tasksRetryComment: async (_id: string, commentId: string) => {
        calls.push(`retry:${commentId}`)
        return detailsOf(issueRecord(), { comments: [{ id: 'c1', taskId: TASK, body: 'Posted from Solus', createdAt: 1 }] })
      },
      tasksDeleteComment: async (_id: string, commentId: string) => {
        calls.push(`discard:${commentId}`)
        return detailsOf(issueRecord())
      },
    })

    await task.comment('Posted from Solus')
    expect(task.details?.comments).toEqual([unsent])

    await task.retryComment('c1')
    expect(task.details?.comments[0].unsent).toBeUndefined()

    await task.discardComment('c1')
    expect(task.details?.comments).toEqual([])
    expect(calls).toEqual(['comment:Posted from Solus', 'retry:c1', 'discard:c1'])
  })

  test('a snooze goes to the host that reads the task and does not change the task', async () => {
    // WHY: a snooze is the reader's own attachment. It hides the task from
    // their lists; the provider's state and the agents do not change.
    const { world, task } = await oneTask({})

    await task.snooze(5_000, 'after the release')

    expect(world.snoozeCalls).toEqual([{ serverId: 'local', taskId: TASK, until: 5_000, note: 'after the release' }])
    expect(task.category).toBe('open')
    world.snoozes.set(TASK, { taskId: TASK, snoozedUntil: 5_000, snoozeNote: 'after the release' })
    expect(task.snoozedUntil).toBe(5_000)
    expect(task.snoozeNote).toBe('after the release')
  })
})

describe('pull request links', () => {
  test('keeps task and PR link identity when a link write changes nothing', async () => {
    // WHY: sidebar PR discovery re-runs whenever the task state it reads
    // changes. If an unchanged link reply still handed the store new objects,
    // every write would invalidate the inputs of the effect that sent it, and
    // discovery would run again on its own answer.
    const world = await createTasksWorld()
    const links: TaskLink[] = [{
      taskId: TASK,
      kind: 'pr',
      targetScope: 'github.com/acme/app',
      targetKey: '65',
      title: '#65 Keep identity',
      url: 'https://github.com/acme/app/pull/65',
      createdBy: { kind: 'system' },
      originSessionId: 'session-65',
      linkedAt: 1,
    }]
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()]),
      tasksGet: async () => detailsOf(issueRecord()),
      tasksLink: async () => ({ links: links.map((link) => ({ ...link })), activity: [] }),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    await store.get(TASK).loadDetails()

    const input = { kind: 'pr' as const, targetScope: 'github.com/acme/app', targetKey: '65', automatic: true }
    await store.get(TASK).link(input)
    const storedTask = store.tasks[0]
    const storedLinks = store.get(TASK).prLinks
    expect(storedLinks.map((link) => link.number)).toEqual([65])

    await store.get(TASK).link(input)

    expect(store.tasks[0]).toBe(storedTask)
    expect(store.get(TASK).prLinks).toBe(storedLinks)
  })

  test('restores a durable PR link from the cold-start sidebar snapshot', async () => {
    // WHY: the PR list is renderer memory and starts empty after refresh. A
    // linked PR must still render before branch discovery runs again.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => ({
        ...snapshotOf([issueRow()]),
        prLinkListsByTask: {
          [TASK]: [
            { number: 43, url: 'https://github.com/acme/app/pull/43', createdBy: { kind: 'system' as const }, originSessionId: 'session-43' },
            { number: 44, url: 'https://github.com/acme/app/pull/44' },
          ],
        },
      }),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.get(TASK).prLink).toEqual({
      number: 43,
      url: 'https://github.com/acme/app/pull/43',
      createdBy: { kind: 'system' },
      originSessionId: 'session-43',
    })
    expect(store.get(TASK).prLinks).toHaveLength(2)
  })

  test('the pull request captured on the task answers when no host lists a link', async () => {
    // WHY: a row must show its pull request from the list read alone, before
    // any host answered the link lists.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow(TASK, { pr: { number: 12, url: 'https://github.com/acme/app/pull/12' } })]),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.get(TASK).prLinks).toEqual([{ number: 12, url: 'https://github.com/acme/app/pull/12' }])
  })
})

describe('session bindings', () => {
  test('a session the host reports as taskless does not cost a full snapshot', async () => {
    // WHY: most restored tabs belong to no task, and every one of them asks for
    // its binding on boot. The host's `tasksForSession` answer is authoritative,
    // so "no task" must be accepted as-is: reloading the whole sidebar per
    // taskless tab was one snapshot RPC per tab, serially, on every boot.
    const world = await createTasksWorld()
    let calls = 0
    world.connections.registerPrimary('local', {
      tasksForSession: async () => null,
      tasksSidebarSnapshot: async () => {
        calls++
        return snapshotOf([])
      },
    })
    const store = new world.TasksStore()
    const bound = await store.ensureSessionBinding('loose-session')

    expect(bound).toBeNull()
    expect(calls).toBe(1)
  })

  test('refreshes the authoritative snapshot only when the focused session read fails', async () => {
    // WHY: the focused read is the cheap path, but a host that cannot answer it
    // must not leave a restored session projected as loose when the snapshot
    // still knows its task. The full reload is the fallback for a failed read,
    // not for a "no task" answer.
    const world = await createTasksWorld()
    let calls = 0
    world.connections.registerPrimary('local', {
      tasksForSession: async () => { throw new Error('host unavailable') },
      tasksSidebarSnapshot: async () => calls++ === 0
        ? snapshotOf([])
        : snapshotOf([issueRow('github:I_parent'), issueRow('github:I_child')], { 'github:I_child': [sessionLink('resumed-session')] }),
    })
    const store = new world.TasksStore()
    await store.ensureSessionBinding('resumed-session')

    expect(store.taskForSession('resumed-session')?.id).toBe('github:I_child')
    expect(calls).toBe(2)
  })

  test('a session write refreshes its binding with the focused read, not a second snapshot', async () => {
    // WHY: every session start and branch change writes to the task host, and
    // the host broadcasts `tasks.invalidated` for that write. A full reload
    // here on top of that broadcast doubled the snapshot traffic per session.
    const world = await createTasksWorld()
    let snapshots = 0
    world.connections.registerPrimary('local', {
      tasksForSession: async () => ({ task: issueRecord('github:I_owner'), attempts: [] }),
      tasksSidebarSnapshot: async () => {
        snapshots++
        return snapshotOf([])
      },
    })
    const store = new world.TasksStore()
    const bound = await store.refreshSessionBinding('started-session')

    expect(bound?.id).toBe('github:I_owner')
    expect(store.taskForSession('started-session')?.id).toBe('github:I_owner')
    expect(snapshots).toBe(1)
  })

  test('the focused session read binds every attempt of the task it names', async () => {
    // WHY: opening from the session picker must not stop at the selected
    // session. The task's other attempts must resolve to the task before any
    // of their transcripts is opened.
    const world = await createTasksWorld()
    let taskReads = 0
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()], { [TASK]: [sessionLink('selected-session')] }),
      tasksForSession: async () => {
        taskReads++
        return {
          task: issueRecord(),
          attempts: [
            sessionLink('selected-session', { sessionTitle: 'Selected session', linkedAt: 1 }),
            sessionLink('other-session', { sessionTitle: 'Another attempt', linkedAt: 2 }),
          ],
        }
      },
    })
    const store = new world.TasksStore()
    await store.ensureSessionBinding('selected-session')

    expect(taskReads).toBe(1)
    expect(store.taskForSession('other-session')?.id).toBe(TASK)
  })

  test('the focused session read shows every named attempt of a task the snapshot already listed', async () => {
    // WHY: the names of a task's attempts are cheap metadata and must appear
    // on the task as soon as the focused read lands, not after the next snapshot.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()], { [TASK]: [sessionLink('selected-session')] }),
      tasksForSession: async () => ({
        task: issueRecord(),
        attempts: [
          sessionLink('selected-session', { sessionTitle: 'Selected session', linkedAt: 1 }),
          sessionLink('other-session', { sessionTitle: 'Another attempt', linkedAt: 2 }),
        ],
      }),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    expect(store.get(TASK).sessions.map((link) => link.sessionId)).toEqual(['selected-session'])

    await store.ensureSessionBinding('selected-session')

    expect(store.get(TASK).sessions).toEqual([
      expect.objectContaining({ sessionId: 'other-session', sessionTitle: 'Another attempt' }),
      expect.objectContaining({ sessionId: 'selected-session', sessionTitle: 'Selected session' }),
    ])
  })

  test('a host that holds only attachments does not become the reader through a session read', async () => {
    // WHY: the Solus API answers `tasksForSession` with the task snapshot that
    // rode the prompt. It still cannot read or write the task on its provider.
    const world = await createTasksWorld()
    world.attachmentOnlyHosts.add('cloud')
    world.connections.registerPrimary('cloud', {
      tasksSidebarSnapshot: async () => snapshotOf([]),
      tasksForSession: async () => ({ task: issueRecord(), attempts: [sessionLink('cloud-run')] }),
    })
    const store = new world.TasksStore()

    const bound = await store.ensureSessionBinding('cloud-run', 'cloud')

    expect(bound?.id).toBe(TASK)
    expect(bound?.serverId).toBeNull()
    expect(bound?.sessions.map((link) => link.sessionId)).toEqual(['cloud-run'])
  })

  test('shows a started session before durable link hydration settles', async () => {
    // WHY: Tasks-page rows derive their running state from the task's
    // sessions. A session that just initialized must appear there on the same
    // frame rather than leaving the row idle until a follow-up RPC completes.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', { tasksSidebarSnapshot: async () => snapshotOf([issueRow()]) })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    store.get(TASK).trackSessionStart('session-1')
    store.get(TASK).trackSessionStart('session-1')

    expect(store.get(TASK).sessions).toEqual([
      expect.objectContaining({ taskId: TASK, sessionId: 'session-1' }),
    ])
    expect(store.taskForSession('session-1')?.id).toBe(TASK)
  })

  test('shows a second started session on the same frame as the first', async () => {
    // WHY: a task with one attempt gets a second one. The row must show the
    // new session now, as it does for the first session of a task.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()], { [TASK]: [sessionLink('earlier-session', { linkedAt: 1 })] }),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    expect(store.get(TASK).sessions).toHaveLength(1)

    store.get(TASK).trackSessionStart('session-2')

    expect(store.get(TASK).sessions.map((link) => link.sessionId)).toContain('session-2')
  })

  test('a session link is filed on the host the caller names', async () => {
    // WHY: a link needs only the task key, so the host that files it can be
    // another one than the host that reads the task: a cloud session files on
    // the Solus API.
    const world = await createTasksWorld()
    const filedOn: string[] = []
    const api = (name: string) => ({
      tasksSidebarSnapshot: async () => snapshotOf(name === 'workshop' ? [issueRow()] : []),
      tasksLinkSession: async () => { filedOn.push(name) },
    })
    world.attachmentOnlyHosts.add('cloud')
    world.connections.registerPrimary('workshop', api('workshop'))
    world.connections.registerHost('cloud', api('cloud'))
    const store = new world.TasksStore()
    await store.ensureLoaded()

    await store.get(TASK).linkSession('session-1', null)
    await store.get(TASK).linkSession('session-2', null, 'cloud')

    expect(filedOn).toEqual(['workshop', 'cloud'])
  })
})

describe('deleting draft items', () => {
  test('keeps a draft hidden when a refresh lands during its undo window', async () => {
    // WHY: deletion is deferred so the user can undo it. Until that window
    // closes, the draft still exists on the provider and an unrelated
    // invalidation can refresh it from the host. That refresh must not put the
    // draft back.
    const world = await createTasksWorld()
    const draft = 'github:DI_1'
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([draftRow(draft)]),
      tasksGet: async () => detailsOf({ ...draftRow(draft), body: '' }),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const pending = store.softRemove([draft])
    expect(pending).toHaveLength(1)
    await store.load()
    await store.get(draft).loadDetails()

    expect(store.tasks).toEqual([])

    store.restorePending(pending)
    expect(store.tasks.map(({ id }) => id)).toEqual([draft])
  })

  test('bounds concurrent RPCs when a large deletion commits', async () => {
    // WHY: one RPC per selected task can exceed the transport's in-flight
    // request limit. A large selection must drain through a small worker pool.
    const world = await createTasksWorld()
    const drafts = Array.from({ length: 105 }, (_, index) => draftRow(`github:DI_${index + 1}`))
    let activeDeletes = 0
    let maximumActiveDeletes = 0
    const deletedIds: string[] = []
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf(drafts),
      tasksDelete: async (taskId: string) => {
        activeDeletes++
        maximumActiveDeletes = Math.max(maximumActiveDeletes, activeDeletes)
        await Promise.resolve()
        deletedIds.push(taskId)
        activeDeletes--
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const pending = store.softRemove(drafts.map(({ id }) => id))

    await store.commitPending(pending)

    expect(deletedIds).toHaveLength(105)
    expect(new Set(deletedIds).size).toBe(105)
    expect(maximumActiveDeletes).toBeLessThanOrEqual(8)
  })

  test('keeps a deleted draft off the list once its delete commits', async () => {
    // WHY: the host drops the row only after its invalidation reload. Listing
    // the draft again between the commit and that reload makes a deleted task
    // flash back on screen, and a snapshot read before the delete would keep it.
    const world = await createTasksWorld()
    const draft = 'github:DI_1'
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([draftRow(draft)]),
      tasksDelete: async () => {},
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const pending = store.softRemove([draft])

    await store.commitPending(pending)
    expect(store.tasks).toEqual([])

    // A stale snapshot that still lists the draft must not bring it back.
    await store.load()
    expect(store.tasks).toEqual([])
  })

  test('a delete that the host refuses puts the task back and reports the reason', async () => {
    // WHY: the host refuses to delete an issue, and a provider can fail. The
    // task still exists, so it must come back to the list with the error.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([draftRow('github:DI_1'), draftRow('github:DI_2')]),
      tasksDelete: async (taskId: string) => {
        if (taskId === 'github:DI_2') throw new Error('GitHub did not remove the item')
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    const pending = store.softRemove(['github:DI_1', 'github:DI_2'])

    await expect(store.commitPending(pending)).rejects.toThrow('GitHub did not remove the item')
    expect(store.tasks.map(({ id }) => id)).toEqual(['github:DI_2'])
  })
})

describe('provider search', () => {
  test('hydrates the matches of the provider without adding them to the list', async () => {
    // WHY: a truncated source did not list every task, so search is the only
    // way to reach the rest. A match is a task to act on, but the next
    // snapshot decides what the list holds: a match that joined the list would
    // stay there after the search box was cleared.
    const world = await createTasksWorld()
    const repo = sourceState(REPO_SOURCE_KEY).source
    world.setSources([repo])
    const searches: Array<[unknown, string]> = []
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow()]),
      tasksSources: async () => [sourceState(REPO_SOURCE_KEY)],
      tasksSearch: async (sources: unknown, query: string) => {
        searches.push([sources, query])
        return [issueRow(TASK, { title: 'Listed, with a newer title' }), issueRow('github:I_old', { title: 'An old payment bug' })]
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const found = await store.search('payment')

    // The search names the person's sources: no project names them.
    expect(searches).toEqual([[[repo], 'payment']])
    expect(found.map((task) => task.id)).toEqual([TASK, 'github:I_old'])
    // The match of a listed task is the listed task itself.
    expect(found[0]).toBe(store.get(TASK))
    expect(found[1].isKnown).toBe(true)
    expect(found[1].title).toBe('An old payment bug')
    expect(found[1].serverId).toBe('local')
    expect(store.peek('github:I_old')).toBe(found[1])
    expect(store.tasks.map((row) => row.id)).toEqual([TASK])
  })

  test('a match keeps the host that already reads the task', async () => {
    // WHY: the task host searches, and another host can read the same task.
    // The search answer must not move the task's writes to another machine.
    const world = await createTasksWorld()
    world.connections.registerPrimary('first', { tasksSidebarSnapshot: async () => snapshotOf([issueRow()]) })
    world.connections.registerHost('local', {
      tasksSidebarSnapshot: async () => snapshotOf([]),
      tasksSearch: async () => [issueRow()],
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    const [found] = await store.search('hydrated')
    expect(found.serverId).toBe('first')
  })
})

describe('conversation-card reverse links', () => {
  test('a stale read cannot restore a link after unlink completes', async () => {
    // WHY: task invalidation can start a reverse read just before the unlink
    // response updates the local cache. That older answer must not make the
    // "Linked to…" label flicker back into view.
    jest.useFakeTimers()
    const world = await createTasksWorld()
    const target = { kind: 'work' as const, targetScope: '', targetKey: 'work-1' }
    const linked = [{ ...target, taskId: TASK, title: 'Fix sync', category: 'active' as const, reference: 'acme/app#184' }]
    const stale = Promise.withResolvers<typeof linked>()
    let reads = 0
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([]),
      tasksLinkedTo: async () => {
        reads++
        return reads === 1 ? linked : stale.promise
      },
    })
    const store = new world.TasksStore()
    await store.ensureLinkedTasks([target], 'local')
    world.connections.emit('local', 'tasks.invalidated', {})
    jest.advanceTimersByTime(101)
    await settle()
    expect(reads).toBe(2)

    const beforeUnlink = store.linkedTasksFor(target)
    store.noteUnlinked(target, TASK)
    // SvelteMap observes its values through `set`; mutating the old array left
    // the card unchanged until the delayed invalidation read arrived.
    expect(store.linkedTasksFor(target)).not.toBe(beforeUnlink)
    expect(store.linkedTasksFor(target)).toEqual([])
    stale.resolve(linked)
    await settle()

    expect(store.linkedTasksFor(target)).toEqual([])
  })

  test('a link this client wrote names the task by its reference at once', async () => {
    // WHY: the card says "Linked to acme/app#1" without a wait for the host's
    // broadcast. The label is the provider's reference: a task has no Solus number.
    const world = await createTasksWorld()
    const target = { kind: 'work' as const, targetScope: '', targetKey: 'work-1' }
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([issueRow(TASK, { category: 'active' })]),
      tasksLinkedTo: async () => [],
      tasksLink: async () => ({ links: [], activity: [] }),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()
    await store.ensureLinkedTasks([target], 'local')

    await store.get(TASK).link({ kind: 'work', targetKey: 'work-1' })

    expect(store.linkedTasksFor(target)).toEqual([
      { ...target, taskId: TASK, title: 'Hydrated task', category: 'active', reference: 'acme/app#1' },
    ])
  })
})

describe('which tasks the store lists', () => {
  test('the label picker offers every label in use, each once, in name order', async () => {
    // WHY: a task belongs to no project, so no project narrows the labels. A
    // label that one task uses is a label the person can give another.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([
        issueRow('github:I_repo', { labels: ['bug'] }),
        issueRow('jira:cloud-1:10001', { providerId: 'jira', reference: 'SOL-1', labels: ['backend', 'bug'] }),
      ]),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.knownLabels).toEqual(['backend', 'bug'])
  })

  test('up next holds the tasks that are not done', async () => {
    // WHY: "done" is the status category, the one fact Solus derives from a
    // provider state. An active task and an open task are both still work.
    const world = await createTasksWorld()
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => snapshotOf([
        issueRow('github:I_open'),
        issueRow('github:I_active', { category: 'active' }),
        issueRow('github:I_done', { category: 'done', state: { name: 'Closed', category: 'done' } }),
      ]),
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    expect(store.upNext.map((task) => task.id)).toEqual(['github:I_open', 'github:I_active'])
  })
})
