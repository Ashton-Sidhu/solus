import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { IpcContext } from '@solus/contracts/types'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let dataDir: string
let closeDb: () => void
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-response-fork-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
})
afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

function response(pointId: string, timestamp: number): SessionLoadMessage {
  return { role: 'assistant', content: pointId, forkPointId: pointId, timestamp }
}

test('a response fork saves a new session and loads only history through its checkpoint before the first prompt', async () => {
  const { upsertOwnSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const { SolusServer, INTERNAL_HANDLER_CTX } = await import('@solus/server/transport/server')
  const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
  const { registerHistoryHandlers } = await import('@solus/server/transport/handlers/history-handlers')
  const sourceId = randomUUID()
  const targetSessionId = randomUUID()
  const sourceThreadId = sourceId
  await upsertOwnSessionRecord({
    sessionId: sourceId, provider: 'codex', projectPath: '/test', cwd: '/test', title: 'Source', lastActivityAt: 10,
  })
  const loadSessionPage = mock(async (_id: string, _cwd: string, _limit: number, before?: string) => {
    if (before === 'oldest') return { messages: [response('first', 1)], before: null }
    if (before === 'middle') return { messages: [response('picked', 2), response('after-cutoff', 3)], before: 'oldest' }
    return { messages: [response('latest', 4)], before: 'middle' }
  })
  const submitPrompt = mock(async (_ctx: IpcContext, _options: { prompt: string }, _origin: { forkPointId?: string }) => ({ disposition: 'started' as const }))
  const runtime = {
    backendFor: () => ({ loadSessionPage }),
    history: { getSessionInfo: async () => null },
    dispatch: { submitPrompt, admitTurn: async () => {} },
    watchers: { watches: new Map(), watchSession: () => {} },
  }
  const server = new SolusServer()
  const announced = mock((_sessionId: string) => {})
  registerSessionHandlers(server, { sessionRuntime: runtime as never, orchestrator: { mayAnswer: () => false }, agentIdFromContext: () => 'codex', onResponseForkCreated: announced })
  registerHistoryHandlers(server, { sessionRuntime: runtime as never, events: {} as never, agentIdFromContext: () => 'codex', exchangeProgress: () => undefined })

  const request = { sessionId: sourceId, sourceThreadId, targetSessionId, pointId: 'picked' }
  const fork = await server.handle('forkSessionFromResponse', [request], INTERNAL_HANDLER_CTX)
  expect(fork).toMatchObject({
    sessionId: targetSessionId,
    title: 'Source fork',
    status: 'idle',
    startedBy: { kind: 'person', fork: { sourceSessionId: sourceId, sourceThreadId, pointId: 'picked' } },
  })
  expect(await server.handle('forkSessionFromResponse', [request], INTERNAL_HANDLER_CTX)).toMatchObject({ sessionId: targetSessionId })
  expect(announced.mock.calls).toEqual([[targetSessionId]])
  const historyRequest = { sessionId: targetSessionId, provider: 'codex' as const, turnLimit: 1 }
  const newest = await server.handle('loadSessionPage', [historyRequest], INTERNAL_HANDLER_CTX)
  expect(newest.messages.map((message) => message.activity?.kind ?? message.content)).toEqual(['picked', 'forked'])
  const older = await server.handle('loadSessionPage', [{ ...historyRequest, before: newest.before! }], INTERNAL_HANDLER_CTX)
  expect(older.messages.map((message) => message.content)).toEqual(['first'])
  expect(older.before).toBeNull()

  await expect(server.handle('forkSessionFromResponse', [{
    sessionId: targetSessionId, sourceThreadId, targetSessionId: randomUUID(), pointId: 'after-cutoff',
  }], INTERNAL_HANDLER_CTX)).rejects.toThrow('no longer available')
  const nested = await server.handle('forkSessionFromResponse', [{
    sessionId: targetSessionId, sourceThreadId, targetSessionId: randomUUID(), pointId: 'first',
  }], INTERNAL_HANDLER_CTX)
  expect(nested.startedBy).toMatchObject({
    kind: 'person',
    fork: { sourceSessionId: targetSessionId, historySessionId: sourceId, pointId: 'first' },
  })

  const context = {
    session: {
      sessionId: targetSessionId, provider: 'codex', agentSessionId: targetSessionId,
      workingDirectory: '/test', projectPath: '/test', permissionMode: 'supervised',
    },
    settings: { activeAgent: 'codex' },
  } as IpcContext
  await server.handle('prompt', [context, { prompt: 'Continue here' }], INTERNAL_HANDLER_CTX)
  expect(submitPrompt.mock.calls[0]?.[0].session).toMatchObject({
    sessionId: targetSessionId, agentSessionId: sourceThreadId, forked: true,
  })
  expect(submitPrompt.mock.calls[0]?.[2].forkPointId).toBe('picked')
})

test('only the last Claude reply in a completed turn gets a checkpoint', async () => {
  const { claudeForkResponses, claudeHistoryRows } = await import('@solus/server/execution/agents/claude/claude-session-helpers')
  const reply = (uuid: string, text: string) => claudeHistoryRows(JSON.stringify({
    type: 'assistant', uuid, message: { content: [{ type: 'text', text }] },
  }))[0]!
  const rows = [
    reply('thinking-out-loud', 'I will check.'),
    reply('answer', 'The result is ready.'),
    { role: 'user', content: 'Next', timestamp: 3 },
    reply('ongoing', 'I am checking.'),
  ]
  expect(claudeForkResponses(rows, true).map((row) => row.forkPointId)).toEqual([undefined, 'answer', undefined, undefined])
})
