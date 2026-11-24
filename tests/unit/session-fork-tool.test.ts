import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHistoryPageRequest, WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { SessionMeta } from '@solus/contracts/types'
import { DatabaseSync } from './helpers/bun-sqlite'

/**
 * `fork_session` gives an agent the fork and the merge back that a person has in
 * a client: a fork copies a session through a completed response and runs no
 * turn; a merge back brings the fork's findings to its source.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

let dataDir: string
let closeDb: () => void
const previous = process.env.SOLUS_DATA_DIR
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-fork-tool-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
})
afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
})

function response(pointId: string, timestamp: number): WireSessionLoadMessage {
  return { role: 'assistant', content: pointId, forkPointId: pointId, timestamp }
}

const sourceId = randomUUID()
const sendCalls: Array<{ sender: string; target: string; prompt: string }> = []
/** The sessions the tool checked the person may prompt. */
const drives: string[] = []
const promptSession = mock(async () => ({ disposition: 'started' as const }))
/** The fork's own transcript, set once the fork exists. */
let forkPage: WireSessionLoadMessage[] = []

async function setUp() {
  const { upsertOwnSessionRecord, getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  const { setSessionForkHost } = await import('@solus/server/execution/agents/tools/session-fork-tool')
  const { setSessionOrchestration } = await import('@solus/server/execution/agents/tools/session-tools')
  await upsertOwnSessionRecord({
    sessionId: sourceId, provider: 'codex', projectPath: '/test', cwd: '/test', title: 'Source', lastActivityAt: 10,
  })
  // The source's history as the provider keeps it: the latest turn is still running.
  const sourcePage = [response('older', 1), response('latest', 2), { role: 'assistant', content: 'Still working', timestamp: 3 }]
  const runtime = {
    backendFor: () => ({ loadSessionPage: async () => ({ messages: sourcePage, before: null }) }),
    dispatch: { promptSession },
  }
  setSessionForkHost({
    runtime: runtime as never,
    readsFor: () => ({
      sessionInfo: async (sessionId: string) => {
        const record = await getSessionRecord(ANY_ORGANIZATION, sessionId)
        return record ? { sessionId, provider: record.provider, projectPath: record.projectPath, cwd: record.cwd, slug: null } as SessionMeta : null
      },
      loadPage: async (request: SessionHistoryPageRequest) => ({
        messages: request.sessionId === sourceId ? sourcePage : forkPage, before: null,
      }),
    }),
    assertMayDrive: async (_principal, sessionId) => { drives.push(sessionId) },
    announce: () => {},
  })
  setSessionOrchestration({
    spawn: async () => { throw new Error('Unexpected spawn') },
    send: async (sender, target, message) => {
      sendCalls.push({ sender, target, prompt: message.prompt })
      return { exchangeId: 'exchange', disposition: 'queued' }
    },
    releaseRateLimit: () => false,
    stop: () => false,
  })
}

let forkId = ''

/** The tool, run as the host's local owner, as an admitted turn runs it. */
async function runAsOwner(input: Parameters<typeof import('@solus/server/execution/agents/tools/session-fork-tool')['runSessionFork']>[0], callerSessionId: string) {
  const { runSessionFork } = await import('@solus/server/execution/agents/tools/session-fork-tool')
  const { withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority')
  const owner = { kind: 'owner', via: 'local', deviceId: null, deviceLabel: 'Test', expiresAt: null } as const
  return withWorkspaceToolAuthority(owner, () => runSessionFork(input, { provider: 'codex', callerSessionId }))
}

test('a fork copies the session through its latest completed response and starts no turn', async () => {
  await setUp()
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
  const result = await runAsOwner({ action: 'fork' }, sourceId)
  expect(result.ok).toBe(true)
  forkId = /session id ([0-9a-f-]{36})/.exec(result.text)?.[1] ?? ''
  expect(result.text).toContain('send_session')
  expect(result.text).toContain(`sessionId=${forkId}`)
  const fork = await getSessionRecord(ANY_ORGANIZATION, forkId)
  expect(fork).toMatchObject({
    title: 'Source fork',
    status: 'idle',
    startedBy: { kind: 'person', fork: { sourceSessionId: sourceId, pointId: 'latest' } },
  })
  expect(drives).toEqual([sourceId])
  expect(promptSession).not.toHaveBeenCalled()
  expect(sendCalls).toEqual([])
})

test('a session with no fork source cannot merge back', async () => {
  const result = await runAsOwner({ action: 'merge_back' }, sourceId)
  expect(result).toEqual({ ok: false, text: 'This session has no recorded fork source.' })
})

test('a merge back into the calling session returns the findings; into another session it sends them', async () => {
  const { writeSessionDigest } = await import('@solus/server/data/sessions/session-digests')
  const after = Date.now() + 1_000
  forkPage = [
    { role: 'user', content: 'Inspect the cache', timestamp: after + 1 },
    { role: 'assistant', content: 'The cache key misses the host id', timestamp: after + 2 },
  ]
  await writeSessionDigest({
    sessionId: forkId,
    turns: [{ id: 'turn', startedAt: after, endedAt: after + 3, settled: true, outcome: 'completed', prompt: 'Inspect the cache', toolCalls: [], changes: { filesChanged: 0, additions: 0, deletions: 0 } }],
    changes: { files: [], filesChanged: 0, additions: 0, deletions: 0 },
    subagents: [],
    lastReply: 'The cache key misses the host id',
    updatedAt: after + 3,
  })

  const intoCaller = await runAsOwner({ action: 'merge_back', session_id: forkId }, sourceId)
  expect(intoCaller.ok).toBe(true)
  expect(intoCaller.text).toContain('The cache key misses the host id')
  expect(sendCalls).toEqual([])

  const fromFork = await runAsOwner({ action: 'merge_back' }, forkId)
  expect(fromFork.ok).toBe(true)
  expect(fromFork.text).not.toContain('The cache key misses the host id')
  expect(sendCalls).toHaveLength(1)
  expect(sendCalls[0]).toMatchObject({ sender: forkId, target: sourceId })
  expect(sendCalls[0]!.prompt).toContain('The cache key misses the host id')
  expect(drives.at(-1)).toBe(sourceId)
})

test('a turn whose person may not start a session cannot fork', async () => {
  const { runSessionFork } = await import('@solus/server/execution/agents/tools/session-fork-tool')
  const { withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority')
  const guest = {
    kind: 'guest', guestId: 'guest', displayName: 'Guest', deviceId: 'guest',
    share: { resource: { kind: 'session', id: sourceId }, role: 'viewer', sharedByUserId: 'owner', linkSecretHash: 'hash' },
  } as const
  const result = await withWorkspaceToolAuthority(guest as never, () => runSessionFork({ action: 'fork' }, { provider: 'codex', callerSessionId: sourceId }))
  expect(result).toEqual({ ok: false, text: 'The person this session works for may not start a session on this host.' })
  expect(promptSession).not.toHaveBeenCalled()
})
