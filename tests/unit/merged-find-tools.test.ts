import { installTestWorkspaceTools } from './helpers/workspace-tools'
import { beforeEach, afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/** Work discovery composes with reads; links belong to the calling session.
 * Task reads name prior sessions without introducing a second session reader. */

let workTools: typeof import('@solus/server/execution/agents/tools/work-tools')
let taskTools: typeof import('@solus/server/execution/agents/tools/task-tools')
let linkTools: typeof import('@solus/server/execution/agents/tools/session-link-tools')
let works: typeof import('@solus/server/data/works/works')
let createTask: typeof import('@solus/server/data/tasks/task-store')['createTask']
let TaskModule: typeof import('@solus/server/data/tasks/task')
let closeDb: typeof import('@solus/server/db')['closeDb']

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

function toolContext(sessionId: string) {
  return {
    cwd: process.cwd(),
    sessionId: () => sessionId,
    emit: () => {},
  } as never
}

beforeEach(async () => { await installTestWorkspaceTools() })

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-find-tools-'))
  process.env.SOLUS_DATA_DIR = dataDir
  workTools = await import('@solus/server/execution/agents/tools/work-tools')
  taskTools = await import('@solus/server/execution/agents/tools/task-tools')
  linkTools = await import('@solus/server/execution/agents/tools/session-link-tools')
  works = await import('@solus/server/data/works/works')
  ;({ createTask } = await import('@solus/server/data/tasks/task-store'))
  TaskModule = await import('@solus/server/data/tasks/task')
  ;({ closeDb } = await import('@solus/server/db'))
  const { getDatabase } = await import('@solus/server/db/database')
  for (const sessionId of ['calling-session-id', 'other-session-id', 'unlinked-session-id', 'unlinking-session-id', 'keeping-session-id', 'never-linked-session-id']) {
    await getDatabase().run(sql`INSERT INTO session(session_id, organization_id, created_by, provider, project_path, status, created_at, last_activity_at, started_at) VALUES (${sessionId}, 'local', 'owner', 'codex', ${process.cwd()}, 'idle', 1, 2, 1)`)
  }
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
    const sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
    const deps = { ctx: { agentProvider: 'claude-code' as const, cwd: '/p', sessionId: 'me' } }
    const searched = await sessionTools.executeSessionTool('search_sessions', { query: 'outbox' }, deps)
    expect(searched.ok).toBe(true)
    // The index is empty in this data dir; the search ran against it.
    expect(searched.text).toContain('No matching sessions.')
    expect(await sessionTools.executeSessionTool('search_sessions', { query: '  ' }, deps)).toEqual({ ok: false, text: 'search_sessions requires a non-empty query.' })
    expect(await sessionTools.executeSessionTool('search_sessions', {}, deps)).toEqual({ ok: false, text: 'search_sessions requires a non-empty query.' })
  })
})

describe('session-only links', () => {
  test('rejects task destinations and task session membership', async () => {
    const task = await createTask('local', { title: 'No implicit task links', projectKey: '/p', body: '' })
    for (const args of [
      { task_id: task.id, kind: 'work', target_id: 'work-1' },
      { task_id: task.id, kind: 'session' },
      { kind: 'plan', target_id: 'plan-1' },
    ]) {
      const { executeAgentTool } = await import('@solus/server/execution/agents/tools/agent-tool')
      const result = await executeAgentTool(linkTools.linkAgentTool, args, toolContext('calling-session-id'))
      expect(result.ok).toBe(false)
      expect(result.text).toContain('Invalid arguments for link')
    }
  })

  test('read_task lists session IDs for read_session', async () => {
    const task = await createTask('local', { title: 'Read prior attempts', projectKey: '/p', body: '' })
    await (await TaskModule.Task.byId('local', task.id)).linkSession('prior-attempt')
    const read = await taskTools.readTaskAgentTool.execute({ task_id: task.id }, toolContext('calling-session-id'))
    expect(read.ok).toBe(true)
    expect(read.text).toContain('prior-attempt [working]')
    expect(read.text).toContain('read_session with session_id')
  })
})

describe('link with no task', () => {
  test('links a pull request to the calling session', async () => {
    // WHY: most sessions have no task. One tool links a pull request for all
    // of them; a second tool for the session case would be a second name for
    // the same question.
    const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')

    const linked = await linkTools.linkAgentTool.execute(
      { kind: 'pr', target_id: 'https://github.com/acme/solus/pull/7' },
      toolContext('calling-session-id'),
    )

    expect(linked.ok).toBe(true)
    const links = Object.values(await sessionPrs.readSessionPullRequests('local')).flat()
    expect(links).toEqual([expect.objectContaining({ number: 7, repository: 'github.com/acme/solus', source: 'agent' })])
  })


})

describe('list_links', () => {
  // WHY: gh opens a pull request without telling Solus. The agent checks this
  // list before it finishes, so it must show exactly this session's links —
  // another session's pull request here would hide the one that is missing.
  test('lists the calling session\'s links and no other session\'s', async () => {
    await linkTools.linkAgentTool.execute(
      { kind: 'pr', target_id: 'https://github.com/acme/solus/pull/7' },
      toolContext('calling-session-id'),
    )
    await linkTools.linkAgentTool.execute(
      { kind: 'pr', target_id: 'https://github.com/acme/solus/pull/8' },
      toolContext('other-session-id'),
    )

    const listed = await linkTools.listLinksAgentTool.execute({}, toolContext('calling-session-id'))

    expect(listed.ok).toBe(true)
    expect(listed.text).toContain('#7 github.com/acme/solus [not yet synced]')
    expect(listed.text).toContain('(linked by agent)')
    expect(listed.text).not.toContain('#8')
  })

  test('says so when the session has no links', async () => {
    const listed = await linkTools.listLinksAgentTool.execute({}, toolContext('unlinked-session-id'))

    expect(listed).toEqual({ ok: true, text: 'No matching links for this session.' })
  })
})

describe('unlink', () => {
  // WHY: a person removes a wrong link in the list; an agent that sees a pull
  // request that is not its work must be able to do the same, and PR sync must
  // not bring it back.
  test("removes the pull request from the calling session's links only", async () => {
    const url = 'https://github.com/acme/solus/pull/9'
    await linkTools.linkAgentTool.execute({ kind: 'pr', target_id: url }, toolContext('unlinking-session-id'))
    await linkTools.linkAgentTool.execute({ kind: 'pr', target_id: url }, toolContext('keeping-session-id'))

    const removed = await linkTools.unlinkAgentTool.execute({ kind: 'pr', target_id: url }, toolContext('unlinking-session-id'))

    expect(removed).toEqual({ ok: true, text: 'Removed pull request #9 (github.com/acme/solus) from this session.' })
    const listed = await linkTools.listLinksAgentTool.execute({}, toolContext('unlinking-session-id'))
    expect(listed.text).toBe('No matching links for this session.')
    const kept = await linkTools.listLinksAgentTool.execute({}, toolContext('keeping-session-id'))
    expect(kept.text).toContain('#9')
  })

  test('removing an absent pull request is safe', async () => {
    const removed = await linkTools.unlinkAgentTool.execute(
      { kind: 'pr', target_id: 'https://github.com/acme/solus/pull/10' },
      toolContext('never-linked-session-id'),
    )
    expect(removed).toEqual({ ok: true, text: 'Removed pull request #10 (github.com/acme/solus) from this session.' })
  })
})
