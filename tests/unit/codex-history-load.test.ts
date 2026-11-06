import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { EventEmitter } from 'node:events'

mock.module('node:sqlite', () => ({ DatabaseSync }))

class FakeCodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: { activeTurnNotSteerable: boolean },
  ) {
    super(message)
  }
}

interface FakeCodexRequestParams {
  threadId: string
  includeTurns?: boolean
  turnId?: string
  cursor?: string
  limit?: number
  sortDirection?: string
}

class FakeCodexClient extends EventEmitter {
  requests: Array<{ method: string; params: FakeCodexRequestParams }> = []
  readError: Error | null = null
  summaryOnly = false
  paginated = false
  repeatCursor = false

  async request(method: string, params: FakeCodexRequestParams) {
    this.requests.push({ method, params })
    if (method === 'thread/resume') { this.readError = null; return { thread: {} } }
    if (method === 'thread/turns/list' && this.readError) throw this.readError
    if (method === 'thread/items/list') {
      return {
        data: [
          { turnId: 'turn-1', item: { id: 'tool-2', type: 'dynamicToolCall', tool: 'read_task', arguments: { task_id: 'task-1' }, success: true } },
          { turnId: 'turn-1', item: { id: 'tool-1', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/fixture', status: 'completed' } },
          { turnId: 'turn-1', item: { id: 'message-1', type: 'userMessage', content: [{ type: 'text', text: 'Persisted prompt' }] } },
        ],
        nextCursor: null,
      }
    }
    if (params.cursor && !this.repeatCursor) return { data: [{ id: 'turn-2', itemsView: 'summary', items: [{ id: 'message-2', type: 'agentMessage', text: 'Later answer' }] }], nextCursor: null }
    return {
      data: [
          {
            id: 'turn-1',
            status: 'completed',
            itemsView: this.summaryOnly ? 'summary' : 'full',
            items: [
              {
                id: 'message-1',
                type: 'userMessage',
                content: [{ type: 'text', text: 'Persisted prompt' }],
              },
            ],
          },
        ],
      nextCursor: this.paginated ? 'next-turn' : null,
    }
  }

  shutdown() {}
}

const client = new FakeCodexClient()

mock.module('@solus/server/execution/agents/codex/codex-agent', () => ({
  CodexRpcError: FakeCodexRpcError,
  // The backend constructs one app-server per member seat; no seat runs here, so the class is never instantiated.
  CodexAppServerClient: FakeCodexClient,
  getCodexAppServerClient: () => client,
}))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']

const previousDataDir = process.env.SOLUS_DATA_DIR
const dataDir = mkdtempSync(join(tmpdir(), 'solus-codex-history-'))
beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
})

afterAll(async () => {
  const { closeDb } = await import('@solus/server/db')
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  client.requests = []
  client.readError = null
  client.summaryOnly = false
  client.paginated = false
  client.repeatCursor = false
})

describe('Codex history loading', () => {
  test('picker previews do not fetch hidden tool history', async () => {
    client.summaryOnly = true
    const preview = await new CodexBackend().loadSessionPreview('thread-1')
    expect(preview.head[0].content).toBe('Persisted prompt')
    expect(client.requests.map((request) => request.method)).toEqual(['thread/turns/list'])
  })

  test('reads every turn page in order without full-history hydration', async () => {
    client.paginated = true
    const preview = await new CodexBackend().loadSessionPreview('thread-1')
    expect(preview.head.map((message) => message.content)).toEqual(['Persisted prompt', 'Later answer'])
    expect(client.requests.map((request) => request.params)).toEqual([
      { threadId: 'thread-1', cursor: undefined, limit: 200, sortDirection: 'asc', itemsView: 'summary' },
      { threadId: 'thread-1', cursor: 'next-turn', limit: 200, sortDirection: 'asc', itemsView: 'summary' },
    ])
    expect(client.requests.every((request) => request.method === 'thread/turns/list')).toBe(true)
  })

  test('rejects a repeated turn cursor instead of looping forever', async () => {
    client.paginated = true
    client.repeatCursor = true
    await expect(new CodexBackend().loadSessionPreview('thread-1')).rejects.toThrow('repeated a turn cursor')
    expect(client.requests).toHaveLength(2)
  })

  test('hydrates tool calls omitted by a saved turn summary', async () => {
    client.summaryOnly = true
    const messages = await new CodexBackend().loadSession('thread-1', undefined, 200)
    expect(messages.map((message) => message.toolName).filter(Boolean)).toEqual(['exec_command', 'read_task'])
    expect(client.requests[1]).toMatchObject({
      method: 'thread/items/list',
      params: { threadId: 'thread-1', turnId: 'turn-1', sortDirection: 'desc', limit: 200 },
    })
  })

  test('resumes a dormant persisted thread when preview loading cannot read it', async () => {
    // WHY: history rows include threads that app-server has not loaded into
    // memory. Selecting one must load its persisted turns instead of showing an
    // empty preview after `thread/turns/list` returns "thread not loaded".
    client.readError = new FakeCodexRpcError('thread not loaded: thread-1', -32602)
    const backend = new CodexBackend()

    const messages = await backend.loadSession('thread-1')

    expect(client.requests).toEqual([
      {
        method: 'thread/turns/list',
        params: { threadId: 'thread-1', cursor: undefined, limit: 200, sortDirection: 'asc', itemsView: 'summary' },
      },
      {
        method: 'thread/resume',
        params: { threadId: 'thread-1' },
      },
      {
        method: 'thread/turns/list',
        params: { threadId: 'thread-1', cursor: undefined, limit: 200, sortDirection: 'asc', itemsView: 'summary' },
      },
    ])
    expect(messages.map((message) => message.content)).toEqual(['Persisted prompt'])
  })

  test('does not hide other history read failures behind a resume', async () => {
    client.readError = new FakeCodexRpcError('permission denied', -32000)
    const backend = new CodexBackend()

    await expect(backend.loadSession('thread-1')).rejects.toThrow('permission denied')
    expect(client.requests).toHaveLength(1)
  })
})

interface HistoryProfileLog {
  msg: string
  sessionId?: string
  succeeded?: boolean
  failedStage?: string
  itemRequests?: number
  stages?: Array<{ stage: string; durationMs: number }>
}

test('history profiling preserves reads and reports the failing stage', async () => {
  const { flushLogs } = await import('@solus/server/logger')
  client.summaryOnly = true
  const backend = new CodexBackend()
  const page = await backend.loadSessionPage('profile-success', undefined, 10)
  expect(page.messages.some((message) => message.content === 'Persisted prompt')).toBe(true)
  expect(client.requests.map((request) => request.method)).toEqual(['thread/turns/list', 'thread/items/list'])
  client.readError = new FakeCodexRpcError('permission denied', -32000)
  await expect(backend.loadSessionPage('profile-failure', undefined, 10)).rejects.toThrow('permission denied')
  flushLogs()
  const logs: HistoryProfileLog[] = readFileSync(process.env.SOLUS_DEV_LOG!, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const success = logs.findLast((entry) => entry.msg === 'codex_history_page_profile' && entry.sessionId === 'profile-success')
  expect(success).toMatchObject({ succeeded: true, itemRequests: 1 })
  expect(success?.stages?.map((entry) => entry.stage)).toEqual(['reader', 'turns', 'items', 'children', 'answers'])
  expect(logs.findLast((entry) => entry.msg === 'codex_history_page_profile' && entry.sessionId === 'profile-failure'))
    .toMatchObject({ succeeded: false, failedStage: 'turns', itemRequests: 0 })
})
