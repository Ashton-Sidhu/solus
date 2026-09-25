import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { NormalizedEvent, SessionStatus } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// WHY: the parent that coordinates a task must know everything that happened
// in it — including sessions a person started, not only its own children —
// and must still know after a restart, when the reports that were
// in flight are gone. The view reads durable records for that, and names what
// each session produced by id, never by content.

let taskView: typeof import('@solus/server/orchestration/task-view')
let taskStore: typeof import('@solus/server/tasks/task-store')
let TaskModule: typeof import('@solus/server/tasks/task')
let indexer: typeof import('@solus/server/db/session-indexer')
let works: typeof import('@solus/server/folio/works')
let plans: typeof import('@solus/server/plans/plan-index')
let closeDb: typeof import('@solus/server/db')['closeDb']
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-view-'))
  process.env.SOLUS_DATA_DIR = dataDir
  taskView = await import('@solus/server/orchestration/task-view')
  taskStore = await import('@solus/server/tasks/task-store')
  TaskModule = await import('@solus/server/tasks/task')
  indexer = await import('@solus/server/db/session-indexer')
  works = await import('@solus/server/folio/works')
  plans = await import('@solus/server/plans/plan-index')
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const cwd = '/repo'
const PLAN_TEXT = '# Split the store\n\n1. Move the queue\n2. Keep the index'

/** A task worked on by a parent, the child it started, and a session a person started. */
async function tree() {
  const task = await taskStore.createTask('local', { title: 'Ship the store', projectKey: cwd, body: '' })
  indexer.persistIndexedSessionStart('thread-parent', 'codex', cwd, cwd, 'gpt-test', 'medium', 'coordinate')
  indexer.persistIndexedSessionStart('thread-child', 'claude-code', cwd, cwd, 'opus', 'high', 'move the queue', 'feat/queue', {
    parentSessionId: 'thread-parent', messageId: 'm1', intent: 'delegate', createdAt: 1,
  })
  indexer.persistIndexedSessionStart('thread-grandchild', 'codex', cwd, cwd, 'gpt-test', 'medium', 'test the queue', null, {
    parentSessionId: 'thread-child', messageId: 'm2', intent: 'delegate', createdAt: 2,
  })
  indexer.persistIndexedSessionStart('thread-person', 'codex', cwd, cwd, 'gpt-test', 'medium', 'fix the docs')
  for (const thread of ['thread-parent', 'thread-child', 'thread-person']) {
    await (await TaskModule.Task.byId('local', task.id)).linkSession(thread, 'working')
  }
  const work = await works.createWork('local', 'Queue design', 'doc', 'the full design text', '', 'thread-child', 'claude-code', cwd)
  await plans.indexLivePlan('local', { provider: 'claude-code', sessionId: 'thread-child', planToolUseId: 'toolu_plan', projectPath: cwd, cwd, timestamp: 3, content: PLAN_TEXT })
  return { task, work }
}

function reads(live: Record<string, SessionStatus>, pending: Record<string, NormalizedEvent[]>) {
  const transcripts: Record<string, SessionLoadMessage[]> = {
    'thread-child': [
      { role: 'user', content: 'move the queue', timestamp: 1 },
      { role: 'assistant', content: 'Moved the queue. Waiting on which database to use.', timestamp: 2 },
    ],
  }
  return {
    liveStatus: (thread: string) => live[thread] ?? null,
    pendingInputEvents: (thread: string) => pending[thread] ?? [],
    loadSessionTail: async (_provider: string, thread: string) => transcripts[thread] ?? [],
    link: (meta: { sessionId: string }) => `[${meta.sessionId}](session://open?sessionId=${meta.sessionId})`,
  }
}

describe('the task view', () => {
  test('shows every session on the task, who started it, what it waits on and what it produced', async () => {
    const { task, work } = await tree()
    const question: NormalizedEvent = { type: 'question_request', questionId: 'q1', questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'SQLite' }], multiSelect: false }] }
    const view = (await taskView.formatTaskSessions(task.id, reads({ 'thread-child': 'awaiting_input' }, { 'thread-child': [question] })))!

    expect(view).toContain(`Task ${task.id}`)
    expect(view).toContain('Sessions (3)')
    // The one a person started is there too, and says so.
    expect(view).toMatch(/thread-person[\s\S]*started by a person/)
    expect(view).toMatch(/thread-child[\s\S]*claude-code\/opus · awaiting_input · started by session thread-parent/)
    expect(view).toContain('branch: feat/queue')
    expect(view).toContain('waits on the user: question "Which database?"')
    expect(view).toContain('last message: "Moved the queue. Waiting on which database to use."')
    expect(view).toContain(`- work "Queue design" work=${work.id} type=doc`)
    expect(view).toContain('- plan "Split the store" session=thread-child plan=toolu_plan')
    expect(view).toContain('- session "test the queue" session=thread-grandchild')
    // References, never content.
    expect(view).not.toContain('the full design text')
    expect(view).not.toContain('Move the queue\n2.')
  })

  test('after a restart, with nothing live, the durable facts are all still there', async () => {
    const { task, work } = await tree()
    const view = (await taskView.formatTaskSessions(task.id, reads({}, {})))!
    expect(view).toMatch(/thread-child[\s\S]*not running/)
    expect(view).toContain(`work=${work.id}`)
    expect(view).toContain('plan=toolu_plan')
    expect(view).not.toContain('waits on the user')
  })

  test('an unknown task is not found', async () => {
    expect(await taskView.formatTaskSessions('01NOTATASK00000000000000000', reads({}, {}))).toBeNull()
  })
})
