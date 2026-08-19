import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter } from 'node:events'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

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
}

class FakeCodexClient extends EventEmitter {
  requests: Array<{ method: string; params: FakeCodexRequestParams }> = []
  readError: Error | null = null

  async request(method: string, params: FakeCodexRequestParams) {
    this.requests.push({ method, params })
    if (method === 'thread/read' && this.readError) throw this.readError
    return {
      thread: {
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: [
              {
                id: 'message-1',
                type: 'userMessage',
                content: [{ type: 'text', text: 'Persisted prompt' }],
              },
            ],
          },
        ],
      },
    }
  }

  shutdown() {}
}

const client = new FakeCodexClient()

mock.module('@solus/server/agents/codex/codex-agent', () => ({
  CodexRpcError: FakeCodexRpcError,
  getCodexAppServerClient: () => client,
}))

let CodexBackend: typeof import('@solus/server/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/agents/codex/codex-backend'))
})

beforeEach(() => {
  client.requests = []
  client.readError = null
})

describe('Codex history loading', () => {
  test('resumes a dormant persisted thread when preview loading cannot read it', async () => {
    // WHY: history rows include threads that app-server has not loaded into
    // memory. Selecting one must load its persisted turns instead of showing an
    // empty preview after `thread/read` returns "thread not loaded".
    client.readError = new FakeCodexRpcError('thread not loaded: thread-1', -32602)
    const backend = new CodexBackend()

    const messages = await backend.loadSession('thread-1')

    expect(client.requests).toEqual([
      {
        method: 'thread/read',
        params: { threadId: 'thread-1', includeTurns: true },
      },
      {
        method: 'thread/resume',
        params: { threadId: 'thread-1' },
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
