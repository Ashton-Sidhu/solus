import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/agents/codex/codex-backend'))
})

describe('Codex fast mode', () => {
  test('sets the fast service tier on both the thread and the turn', async () => {
    // WHY: setting only the initial thread does not update resumed sessions,
    // while setting only the turn leaves new-thread defaults inconsistent.
    const backend = new CodexBackend()
    const requests: Array<{ method: string; params: { serviceTier?: string | null } }> = []
    let markTurnStarted!: () => void
    const turnStarted = new Promise<void>((resolve) => { markTurnStarted = resolve })
    const client = {
      request: async (method: string, params: { serviceTier?: string | null }) => {
        requests.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' }
        }
        if (method === 'turn/start') {
          markTurnStarted()
          return { turn: { id: 'turn-1' } }
        }
        throw new Error(`Unexpected method: ${method}`)
      },
    }
    Reflect.set(backend, 'client', client)

    backend.startRun({
      provider: 'codex',
      prompt: 'Build it',
      cwd: '/tmp/project',
      tools: [],
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      fastMode: true,
      permissionMode: 'auto',
      persistence: 'ephemeral',
      service: 'sessions',
    })
    await turnStarted

    expect(requests.find((request) => request.method === 'thread/start')?.params.serviceTier).toBe('fast')
    expect(requests.find((request) => request.method === 'turn/start')?.params.serviceTier).toBe('fast')
  })
})
