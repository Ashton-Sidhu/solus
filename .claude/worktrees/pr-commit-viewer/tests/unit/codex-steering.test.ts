import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('../../src/main/agents/codex/codex-backend')['CodexBackend']
let CodexRpcError: typeof import('../../src/main/agents/codex/codex-agent')['CodexRpcError']
beforeAll(async () => {
  ;({ CodexBackend } = await import('../../src/main/agents/codex/codex-backend'))
  ;({ CodexRpcError } = await import('../../src/main/agents/codex/codex-agent'))
})

describe('CodexBackend steering', () => {
  test('sends text and images to the active turn', async () => {
    const backend = new CodexBackend()
    const requests: Array<{ method: string; params: unknown }> = []
    const client = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params })
        return { turnId: 'turn-1' }
      },
    }
    ;(backend as unknown as { client: typeof client }).client = client
    ;(backend as unknown as { activeRuns: Map<string, unknown> }).activeRuns.set('thread-1', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      cwd: '/tmp/project',
    })

    const result = await backend.steerSession('thread-1', {
      prompt: 'Use this screenshot',
      imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }],
    })

    expect(result).toBeTruthy()
    expect(requests).toEqual([{
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [
          { type: 'text', text: 'Use this screenshot', text_elements: [] },
          { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' },
        ],
      },
    }])
  })

  test('returns not-active when the provider rejects a turn-boundary race', async () => {
    const backend = new CodexBackend()
    const client = {
      request: async () => {
        throw new CodexRpcError('expected turn is no longer active', -32600)
      },
    }
    ;(backend as unknown as { client: typeof client }).client = client
    ;(backend as unknown as { activeRuns: Map<string, unknown> }).activeRuns.set('thread-1', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      cwd: '/tmp/project',
    })

    await expect(backend.steerSession('thread-1', { prompt: 'Follow up' })).resolves.toBeNull()
  })

  test('does not turn provider failures into queued follow-ups', async () => {
    const backend = new CodexBackend()
    const failure = new Error('Codex app-server request timed out: turn/steer')
    const client = {
      request: async () => {
        throw failure
      },
    }
    ;(backend as unknown as { client: typeof client }).client = client
    ;(backend as unknown as { activeRuns: Map<string, unknown> }).activeRuns.set('thread-1', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      cwd: '/tmp/project',
    })

    await expect(backend.steerSession('thread-1', { prompt: 'Follow up' })).rejects.toBe(failure)
  })
})
