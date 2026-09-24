import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * One name per question.
 *
 * `list_works`/`search_works` were two tools for one question — find the
 * thing — and the model picks a tool by name before it can read either
 * description. `link_task_session` was `link_task`
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
    await works.createWork('local', 
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

describe('search_sessions only searches', () => {
  test('a query goes to the index; without one the call is refused, never turned into a listing', async () => {
    // WHY: listing the sessions at work moved to the task view. A search tool
    // that quietly lists when its query is empty hands the model a roster it
    // did not ask for and cannot tell from a result.
    const sessionTools = await import('@solus/server/sessions/session-tools')
    const deps = { ctx: { agentProvider: 'claude-code' as const, cwd: '/p', sessionId: 'me' } }
    const searched = await sessionTools.executeSessionTool('search_sessions', { query: 'outbox' }, deps)
    expect(searched.ok).toBe(true)
    // The index is empty in this data dir; the search ran against it.
    expect(searched.text).toContain('No matching sessions.')
    expect(await sessionTools.executeSessionTool('search_sessions', { query: '  ' }, deps)).toEqual({ ok: false, text: 'search_sessions requires a non-empty query.' })
    expect(await sessionTools.executeSessionTool('search_sessions', {}, deps)).toEqual({ ok: false, text: 'search_sessions requires a non-empty query.' })
  })
})

describe('link_task carries the session kind', () => {
  test('kind=session with no target links the calling session', async () => {
    const task = await createTask('local', { title: 'Bind me', projectKey: '/p', body: '' })

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
    const task = await createTask('local', { title: 'One way to name it', projectKey: '/p', body: '' })

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
    const task = await createTask('local', { title: 'Needs a target', projectKey: '/p', body: '' })

    const linked = await taskTools.linkTaskAgentTool.execute(
      { task_id: task.id, kind: 'work' },
      toolContext('calling-session-id'),
    )

    expect(linked.ok).toBe(false)
    expect(linked.text).toContain('target_id')
    expect((await TaskModule.Task.byId('local', task.id)).links ?? []).toHaveLength(0)
  })
})
