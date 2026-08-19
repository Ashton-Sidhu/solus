import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/agents/codex/codex-backend'))
})

describe('Codex usage', () => {
  test('reports API billing without asking for subscription quota windows', async () => {
    // WHY: API-key sessions pay by token and do not have ChatGPT subscription
    // windows. Treating the absent windows as a failed read tells the user the
    // wrong thing.
    const backend = new CodexBackend()
    const methods: string[] = []
    const client = {
      request: async (method: string) => {
        methods.push(method)
        return { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
      },
    }
    Reflect.set(backend, 'client', client)

    const limits = await backend.readUsageLimits()

    expect(methods).toEqual(['account/read'])
    expect(limits).toMatchObject({
      provider: 'codex',
      fiveHour: null,
      weekly: null,
      usageMode: 'api',
      stale: false,
    })
  })
})
