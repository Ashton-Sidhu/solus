import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
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

  test('reports a signed-out login instead of a failed quota read', async () => {
    // WHY: with no Codex login there is no quota to read. A plain
    // "Unavailable" hides the fix; the meter needs to know to say "sign in".
    const backend = new CodexBackend()
    const methods: string[] = []
    const client = {
      request: async (method: string) => {
        methods.push(method)
        if (method === 'account/read') return { account: null, requiresOpenaiAuth: true }
        throw new Error('not logged in')
      },
    }
    Reflect.set(backend, 'client', client)

    const limits = await backend.readUsageLimits()

    expect(methods).toEqual(['account/read'])
    expect(limits).toMatchObject({ provider: 'codex', fiveHour: null, weekly: null, usageMode: 'signed_out', stale: false })
  })

  test('windows from a turn clear a signed-out state', async () => {
    // WHY: once the user signs in, the meter must stop telling them to.
    const { UsageLimitsStore } = await import('@solus/server/usage/usage-store')
    const store = new UsageLimitsStore()
    store.apply({ provider: 'codex', fiveHour: null, weekly: null, planType: null, usageMode: 'signed_out', fetchedAt: 1, stale: false })
    store.applyWindows('codex', [{ windowDurationMins: 300, usedPercent: 10, resetsAt: Date.now() + 3_600_000 }])

    expect(store.get('codex')?.usageMode).toBe('subscription')
  })
})
