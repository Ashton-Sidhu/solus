import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A task shows what its sessions made, and those links follow the session
 * (docs/plans/session-outputs.md).
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const PERSON = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
const SESSION = 'session-1'

let dataDir: string
let db: typeof import('@solus/server/db')
let taskStore: typeof import('@solus/server/data/tasks/task-store')
let tasks: typeof import('@solus/server/data/tasks/task')
let works: typeof import('@solus/server/data/works/works')
let automations: typeof import('@solus/server/data/automations/automations-store')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-outputs-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/data/tasks/task-store')
  tasks = await import('@solus/server/data/tasks/task')
  works = await import('@solus/server/data/works/works')
  automations = await import('@solus/server/data/automations/automations-store')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function newTask(title: string) {
  return tasks.Task.byId('local', (await taskStore.createTask('local', { title })).id)
}

async function linkKeys(task: Awaited<ReturnType<typeof newTask>>) {
  return (await task.links()).map((link) => `${link.kind}:${link.targetKey}`).sort()
}

const madeBy = (sessionId: string, title: string, type: 'doc' | 'artifact' = 'doc') =>
  works.createWork('local', title, type, '', '', sessionId, 'claude-code')

describe('a session that joins a task', () => {
  test('brings the works, plans and automations it made, and not its artifacts', async () => {
    // WHY: a session has a task only when it joins one, so most of what a
    // session makes is made before it has a task. A link made only at creation
    // time loses all of it. An artifact is read once and stays off the task.
    const doc = await madeBy(SESSION, 'Design notes')
    await madeBy(SESSION, 'A chart', 'artifact')
    await madeBy('another-session', 'Not ours')
    const automation = await automations.createAutomation(
      'Nightly check', { agentProvider: 'codex', prompt: 'Check it.', modelId: null, reasoningEffort: 'medium', cwd: '/repo' }, { kind: 'agent', sessionId: SESSION },
    )
    const { indexLivePlan } = await import('@solus/server/plans/plan-index')
    await indexLivePlan({
      provider: 'claude-code', sessionId: SESSION, threadId: SESSION, planToolUseId: 'plan-1', projectPath: '/repo', cwd: '/repo',
      timestamp: 1, content: '# The plan\n\nDo it.',
    })
    const task = await newTask('Ship billing')

    await task.linkSession(SESSION)

    expect(await linkKeys(task)).toEqual([`automation:${automation.id}`, 'plan:plan-1', `work:${doc.id}`].sort())
    expect((await task.links()).every((link) => link.ownerSessionId === SESSION)).toBe(true)
  })

  test('a session that the task only references brings nothing', async () => {
    await madeBy(SESSION, 'Design notes')
    const task = await newTask('Ship billing')

    await task.linkSession(SESSION, 'referenced')

    expect(await linkKeys(task)).toEqual([])
  })
})

describe('a session that leaves a task', () => {
  test('takes what it made, and leaves what a person linked', async () => {
    // WHY: the task shows the work of its sessions. A link that stayed behind
    // would show the work of a session that is no longer part of the task.
    const made = await madeBy(SESSION, 'Made by the session')
    const kept = await madeBy('another-session', 'Linked by a person')
    const task = await newTask('Ship billing')
    await task.linkSession(SESSION)
    await task.linkWork(kept.id, PERSON)

    await task.unlinkSession(SESSION, PERSON)

    expect(await linkKeys(task)).toEqual([`work:${kept.id}`])
    expect(made.id).not.toBe(kept.id)
  })

  test('leaves an output that a person linked deliberately', async () => {
    // WHY: a person who links the item says that it belongs to the task, which
    // is more than "a session of the task made it".
    const made = await madeBy(SESSION, 'Design notes')
    const task = await newTask('Ship billing')
    await task.linkSession(SESSION)

    await task.linkWork(made.id, PERSON)
    await task.unlinkSession(SESSION, PERSON)

    expect(await linkKeys(task)).toEqual([`work:${made.id}`])
  })

  test('moves its outputs to the task it joins next', async () => {
    const made = await madeBy(SESSION, 'Design notes')
    const first = await newTask('First')
    const second = await newTask('Second')
    await first.linkSession(SESSION)

    // A working link elsewhere transfers the session.
    await second.linkSession(SESSION)

    expect(await linkKeys(first)).toEqual([])
    expect(await linkKeys(second)).toEqual([`work:${made.id}`])
  })
})

describe('an output made while the session works on a task', () => {
  test('shows on the task at once and follows the session', async () => {
    const task = await newTask('Ship billing')
    await task.linkSession(SESSION)
    const made = await madeBy(SESSION, 'Design notes')

    await tasks.Task.linkSessionOutput('local', SESSION, { kind: 'work', targetKey: made.id, title: made.title })
    expect((await task.links()).map((link) => link.ownerSessionId)).toEqual([SESSION])

    await task.unlinkSession(SESSION, PERSON)
    expect(await linkKeys(task)).toEqual([])
  })

  test('an output that a person removed stays removed when the session is linked again', async () => {
    // WHY: the task page is a curated list. A second write of the same link,
    // which every first dispatch and every client makes, must not bring back
    // what a person took off.
    const made = await madeBy(SESSION, 'A draft')
    const task = await newTask('Ship billing')
    await task.linkSession(SESSION)

    await task.unlink('work', made.id, '', PERSON)
    await task.linkSession(SESSION)

    expect(await linkKeys(task)).toEqual([])
  })
})
