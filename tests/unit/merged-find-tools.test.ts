import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * One name per question.
 *
 * `list_works`/`search_works` and `list_sessions`/`search_sessions` were two
 * tools each for one question — find the thing — and the model picks a tool by
 * name before it can read either description. `link_task_session` was `link_task`
 * with one more kind. These tests pin that the merged tools still answer both
 * ways, because a merge that quietly drops the listing half is the failure this
 * change could actually cause.
 */

let workTools: typeof import('@solus/server/folio/work-tools')
let taskTools: typeof import('@solus/server/tasks/task-tools')
let works: typeof import('@solus/server/folio/works')
let createTask: typeof import('@solus/server/tasks/task-store')['createTask']
let TaskModule: typeof import('@solus/server/tasks/task')
let closeDb: typeof import('@solus/server/db')['closeDb']

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

function toolContext(sessionId: string) {
  return {
    cwd: process.cwd(),
    sessionId: () => sessionId,
    solusSessionId: () => sessionId,
    emit: () => {},
  } as never
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-find-tools-'))
  process.env.SOLUS_DATA_DIR = dataDir
  workTools = await import('@solus/server/folio/work-tools')
  taskTools = await import('@solus/server/tasks/task-tools')
  works = await import('@solus/server/folio/works')
  ;({ createTask } = await import('@solus/server/tasks/task-store'))
  TaskModule = await import('@solus/server/tasks/task')
  ;({ closeDb } = await import('@solus/server/db'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('find_works answers with or without a query', () => {
  test('no query lists the open works; a query searches their content', async () => {
    await works.createWork(
      'Rate limit handling',
      'doc',
      'The queue drains after a dead transport.',
      '',
      undefined,
      'claude-code',
      process.cwd(),
    )

    const listed = await workTools.findWorksAgentTool.execute({}, toolContext('find-works'))
    expect(listed.ok).toBe(true)
    expect(listed.text).toContain('Rate limit handling')

    // The point of the query half: it matches body text no title carries.
    const searched = await workTools.findWorksAgentTool.execute(
      { query: 'dead transport' },
      toolContext('find-works'),
    )
    expect(searched.ok).toBe(true)
    expect(searched.text).toContain('Rate limit handling')

    const missed = await workTools.findWorksAgentTool.execute(
      { query: 'nothing writes this phrase' },
      toolContext('find-works'),
    )
    expect(missed.ok).toBe(true)
    expect(missed.text).toContain('No works match')
  })
})

describe('find_sessions answers with or without a query', () => {
  test('no query asks the controller for the roster; a query never does', async () => {
    // WHY: the two halves take disjoint parameters and only one of them needs a
    // wired controller. Dispatching on the wrong one turns a history search
    // into "no session controller is wired" — or, worse, silently lists.
    const sessionTools = await import('@solus/server/sessions/session-tools')
    let rosterRequests = 0
    sessionTools.setSessionController({
      listSessions: async () => {
        rosterRequests++
        return [{
          sessionId: 'peer-1',
          provider: 'claude-code',
          cwd: '/p',
          status: 'running',
          firstMessage: 'Draining the outbox',
          lastTimestamp: '2026-09-01T00:00:00Z',
        }]
      },
      liveStatus: () => 'running',
    } as never)

    const listed = await sessionTools.executeSessionTool('find_sessions', {}, {
      ctx: { agentProvider: 'claude-code', cwd: '/p', sessionId: 'me' },
    })
    expect(listed.ok).toBe(true)
    expect(listed.text).toContain('peer-1')
    expect(rosterRequests).toBe(1)

    const searched = await sessionTools.executeSessionTool('find_sessions', { query: 'outbox' }, {
      ctx: { agentProvider: 'claude-code', cwd: '/p', sessionId: 'me' },
    })
    expect(searched.ok).toBe(true)
    // The index is empty in this data dir; what matters is that searching went
    // to the index rather than to the roster.
    expect(rosterRequests).toBe(1)
  })
})

describe('link_task carries the session kind', () => {
  test('kind=session with no target links the calling session', async () => {
    const task = await createTask({ title: 'Bind me', projectKey: '/p', body: '' })

    const linked = await taskTools.linkTaskAgentTool.execute(
      { task_id: task.id, kind: 'session' },
      toolContext('calling-session-id'),
    )

    expect(linked.ok).toBe(true)
    expect(linked.text).toContain('calling-session-id')
  })

  test('a session is named by target_id — session_id belongs to plans', async () => {
    // WHY: session_id survives on this tool for kind=plan, where it names the
    // plan's owning session. Reading it for kind=session too would keep the old
    // link_task_session call shape alive as a second way to say the same thing.
    const task = await createTask({ title: 'One way to name it', projectKey: '/p', body: '' })

    const linked = await taskTools.linkTaskAgentTool.execute(
      { task_id: task.id, kind: 'session', session_id: 'not-the-target' },
      toolContext('calling-session-id'),
    )

    expect(linked.ok).toBe(true)
    expect(linked.text).toContain('calling-session-id')
    expect(linked.text).not.toContain('not-the-target')
  })

  test('every other kind still demands its target', async () => {
    // WHY: making target_id optional for the session default must not make it
    // optional for a work or a PR, where there is nothing to fall back to.
    const task = await createTask({ title: 'Needs a target', projectKey: '/p', body: '' })

    const linked = await taskTools.linkTaskAgentTool.execute(
      { task_id: task.id, kind: 'work' },
      toolContext('calling-session-id'),
    )

    expect(linked.ok).toBe(false)
    expect(linked.text).toContain('target_id')
    expect((await TaskModule.Task.byId(task.id)).links ?? []).toHaveLength(0)
  })
})
