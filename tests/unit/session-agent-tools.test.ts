import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from './helpers/test-db'
import type { SessionQueueSnapshot } from '@solus/contracts/session-queue'
import { encodePathAsFolder } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: parity with T3 Code's thread tools (t3_queue, t3_thread_list, rename).
// An agent must see why a queued message waits and change it by the revision it
// read, so it never overwrites a person's newer edit; it must list sessions with
// no query; and a rename must reach the host's one rename path, for the person.

let queueTool: typeof import('@solus/server/execution/agents/tools/session-queue-tool')
let listTool: typeof import('@solus/server/execution/agents/tools/session-list-tool')
let organizeTool: typeof import('@solus/server/execution/agents/tools/session-organize-tool')
let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')
let records: typeof import('@solus/server/data/sessions/session-records')
let withWorkspaceToolAuthority: typeof import('@solus/server/admission/workspace-tool-authority')['withWorkspaceToolAuthority']
let closeDb: typeof import('@solus/server/db')['closeDb']
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''
// Recent: the person's list shows a session that was active lately.
const NOW = Date.now() - 60_000
const OWNER = { kind: 'owner' as const, via: 'local' as const, expiresAt: null, deviceId: null, deviceLabel: 'Mac' }
const RESET_SECONDS = Date.parse('2026-11-26T21:00:00Z') / 1000

let queue: SessionQueueSnapshot = { held: false, entries: [] }
const changes: unknown[][] = []
const renames: unknown[][] = []

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-agent-tools-'))
  process.env.SOLUS_DATA_DIR = dataDir
  queueTool = await import('@solus/server/execution/agents/tools/session-queue-tool')
  listTool = await import('@solus/server/execution/agents/tools/session-list-tool')
  organizeTool = await import('@solus/server/execution/agents/tools/session-organize-tool')
  sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
  records = await import('@solus/server/data/sessions/session-records')
  ;({ withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority'))
  ;({ closeDb } = await import('@solus/server/db'))
  const { createWorkspaceOperations } = await import('@solus/server/data/workspace/service')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { installWorkspaceToolOperations } = await import('@solus/server/data/workspace/tool-context')
  installWorkspaceToolOperations(createWorkspaceOperations(new ShareManager({ db: getDatabase() })), 'this-mac')
  sessionTools.setSessionController({
    getSessionInfo: async (sessionId: string) => ['caller', 'child'].includes(sessionId) ? { sessionId, provider: 'codex', projectPath: '/repo' } : null,
    liveStatus: (sessionId: string) => sessionId === 'sibling' ? 'rate_limited' : null,
    sessionQueue: () => queue,
    changeSessionQueue: async (...args: unknown[]) => { changes.push(args); return queue },
    renameSession: async (...args: unknown[]) => { renames.push(args) },
  } as never)
})

/** Sessions as the indexer starts them: each has its record and its owner. */
const SEEDED = [
  { id: 'caller', cwd: '/repo', first: 'Coordinate stage 13' },
  { id: 'sibling', cwd: '/repo', first: 'Fix the settings flicker' },
  { id: 'child', cwd: '/repo', first: 'Build stage 13' },
  { id: 'elsewhere', cwd: '/other', first: 'Other project work' },
]

beforeEach(async () => {
  queue = { held: false, entries: [] }
  changes.length = 0
  renames.length = 0
  const indexer = await import('@solus/server/db/session-indexer')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  const { hostUserKey } = await import('@solus/server/host/host-user')
  for (const [index, session] of SEEDED.entries()) {
    indexer.persistIndexedSessionStart(session.id, 'codex', session.cwd, encodePathAsFolder(session.cwd), 'gpt-test', 'high', session.first)
    for (let attempt = 0; attempt < 50 && !(await records.getSessionRecord(ANY_ORGANIZATION, session.id)); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    await records.upsertSessionRecord('local', {
      sessionId: session.id, provider: 'codex', projectPath: encodePathAsFolder(session.cwd), lastActivityAt: NOW + index, startedAt: NOW + index,
      startedBy: { kind: 'person', personKey: hostUserKey() },
      ...(session.id === 'child' ? { parentSessionId: 'caller' } : {}),
    })
  }
})

afterEach(async () => {
  await resetTestDatabase()
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('queue_session', () => {
  test('list says which message a rate limit holds, and until when', async () => {
    queue = { held: false, entries: [{ queueId: 'q1', revision: 2, text: 'continue stage 13', enqueuedAt: NOW, reason: 'rate_limit', releaseAt: RESET_SECONDS }] }
    const result = await queueTool.manageSessionQueue({ action: 'list', session_id: 'child' }, 'caller')
    expect(result.ok).toBe(true)
    expect(result.text).toContain('queue_id=q1 · revision=2 · held by a rate limit until 2026-11-26T21:00:00.000Z')
    expect(result.text).toContain('continue stage 13')
  })

  test('a change carries the revision the agent read, so a newer edit by a person is not overwritten', async () => {
    await queueTool.manageSessionQueue({ action: 'edit', session_id: 'child', queue_id: 'q1', revision: 2, text: 'continue, then report' }, 'caller')
    expect(changes).toEqual([['caller', 'child', { kind: 'edit', queueId: 'q1', revision: 2, text: 'continue, then report' }]])
    const refused = await queueTool.manageSessionQueue({ action: 'cancel', session_id: 'child', queue_id: 'q1' }, 'caller')
    expect(refused).toEqual({ ok: false, text: 'cancel needs queue_id and revision from list.' })
    expect(changes).toHaveLength(1)
  })

  test('cancel, move, and steer map to the queue changes a person makes', async () => {
    await queueTool.manageSessionQueue({ action: 'cancel', queue_id: 'q1', revision: 0 }, 'caller')
    await queueTool.manageSessionQueue({ action: 'move', queue_id: 'q1', revision: 1 }, 'caller')
    await queueTool.manageSessionQueue({ action: 'steer', queue_id: 'q1', revision: 2 }, 'caller')
    expect(changes.map(([, sessionId, mutation]) => [sessionId, mutation])).toEqual([
      // No session_id: the caller's own queue.
      ['caller', { kind: 'remove', queueId: 'q1', revision: 0 }],
      ['caller', { kind: 'move', queueId: 'q1', revision: 1, beforeQueueId: null }],
      ['caller', { kind: 'steer', queueId: 'q1', revision: 2 }],
    ])
  })

  test('a refused change comes back as text the agent can act on', async () => {
    sessionTools.getSessionController()!.changeSessionQueue = async () => { throw new Error('This queue entry changed or started. Refresh the queue before editing it.') }
    const result = await queueTool.manageSessionQueue({ action: 'cancel', queue_id: 'q1', revision: 0 }, 'caller')
    expect(result).toEqual({ ok: false, text: 'This queue entry changed or started. Refresh the queue before editing it.' })
  })
})

describe('list_sessions', () => {
  const list = (input: Parameters<typeof listTool.listSessions>[0]) =>
    withWorkspaceToolAuthority(OWNER, () => listTool.listSessions(input, 'caller', '/repo'))

  const ids = (text: string) => [...text.matchAll(/session id (\S+)/g)].map((match) => match[1])

  test("lists the caller's top-level sessions in its project, newest first, with the live status", async () => {
    const result = await list({ all_projects: false })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('in /repo')
    expect(ids(result.text)).toEqual(['sibling', 'caller'])
    // A record says idle; the host knows the sibling is held by a rate limit.
    expect(result.text).toMatch(/· rate_limited · codex · gpt-test · session id sibling/)
    expect(result.text).toContain('(this session)')
  })

  test('lists every project, or the sessions one session started', async () => {
    expect(ids((await list({ all_projects: true })).text)).toEqual(['elsewhere', 'sibling', 'caller'])
    expect(ids((await list({ all_projects: false, parent_session_id: 'caller' })).text)).toEqual(['child'])
  })
})

describe('organize_session rename', () => {
  test('renames through the host for the caller, and a blank title clears the name', async () => {
    const named = await organizeTool.organizeSession({ action: 'rename', session_id: 'child', title: 'Stage 13: codebases' }, 'caller')
    expect(named).toEqual({ ok: true, text: 'Session child is named "Stage 13: codebases".' })
    await organizeTool.organizeSession({ action: 'rename', title: '' }, 'caller')
    expect(renames).toEqual([['caller', 'child', 'Stage 13: codebases'], ['caller', 'caller', '']])
    expect(await organizeTool.organizeSession({ action: 'rename' }, 'caller')).toEqual({ ok: false, text: 'rename needs title.' })
  })
})
