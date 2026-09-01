import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '../../src/client-core/host-event-subscriber'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let AgentConversationStatusStore: typeof import('../../src/renderer/components/conversation/agent-conversation/agent-conversation-status.store.svelte')['AgentConversationStatusStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ AgentConversationStatusStore } = await import('../../src/renderer/components/conversation/agent-conversation/agent-conversation-status.store.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('agent conversation status retention', () => {
  test('releases metadata and ignores a hydration that resolves after unmount', async () => {
    let resolveInfo!: (value: unknown) => void
    const info = new Promise((resolve) => { resolveInfo = resolve })
    const api = {
      getSessionInfo: async () => info,
    } as never
    const store = new AgentConversationStatusStore(() => new HostEventSubscriber())

    const release = store.retain('agent-1', api, 'studio')
    expect(store.trackedCount()).toBe(1)
    release()
    resolveInfo({ sessionId: 'agent-1', status: 'idle', provider: 'codex' })
    await info
    await Promise.resolve()

    expect(store.trackedCount()).toBe(0)
    expect(store.metaFor('agent-1')).toBeUndefined()
    expect(store.statusFor('agent-1')).toBeNull()
  })

  test('keeps shared metadata until the final mounted card releases', async () => {
    const api = {
      getSessionInfo: async () => null,
    } as never
    const store = new AgentConversationStatusStore(() => new HostEventSubscriber())
    const releaseFirst = store.retain('agent-1', api, 'studio')
    const releaseSecond = store.retain('agent-1', api, 'studio')
    releaseFirst()
    expect(store.trackedCount()).toBe(1)
    releaseSecond()
    expect(store.trackedCount()).toBe(0)
  })
})
