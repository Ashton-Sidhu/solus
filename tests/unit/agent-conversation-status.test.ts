import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { SessionMeta } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let AgentConversationStatusStore: typeof import('@solus/workspace-ui/components/conversation/agent-conversation/agent-conversation-status.store.svelte')['AgentConversationStatusStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ AgentConversationStatusStore } = await import('@solus/workspace-ui/components/conversation/agent-conversation/agent-conversation-status.store.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function meta(sessionId: string): SessionMeta {
  return { sessionId, status: 'idle', provider: 'codex' } as SessionMeta
}

describe('agent conversation status retention', () => {
  test('releases metadata and ignores a hydration that resolves after unmount', async () => {
    let resolveInfo!: (value: Array<SessionMeta | null>) => void
    const info = new Promise<Array<SessionMeta | null>>((resolve) => { resolveInfo = resolve })
    const api = {
      getSessionInfos: async () => info,
    } as never
    const store = new AgentConversationStatusStore(() => new HostEventSubscriber())

    const release = store.retain('agent-1', api, 'studio')
    expect(store.trackedCount()).toBe(1)
    release()
    resolveInfo([meta('agent-1')])
    await info
    await Promise.resolve()

    expect(store.trackedCount()).toBe(0)
    expect(store.metaFor('agent-1')).toBeUndefined()
    expect(store.statusFor('agent-1')).toBeNull()
  })

  test('keeps shared metadata until the final mounted card releases', async () => {
    const api = {
      getSessionInfos: async (sessionIds: string[]) => sessionIds.map(() => null),
    } as never
    const store = new AgentConversationStatusStore(() => new HostEventSubscriber())
    const releaseFirst = store.retain('agent-1', api, 'studio')
    const releaseSecond = store.retain('agent-1', api, 'studio')
    releaseFirst()
    expect(store.trackedCount()).toBe(1)
    releaseSecond()
    expect(store.trackedCount()).toBe(0)
  })

  test('cards mounted in one frame hydrate through one batched read per host', async () => {
    // WHY: a transcript mounts every agent card at once. One request per card
    // made opening a long session cost dozens of round trips for metadata the
    // host can answer in a single call.
    const batches: string[][] = []
    const api = {
      getSessionInfos: async (sessionIds: string[]) => {
        batches.push(sessionIds)
        return sessionIds.map(meta)
      },
    } as never
    const store = new AgentConversationStatusStore(() => new HostEventSubscriber())

    const releases = ['agent-1', 'agent-2', 'agent-3'].map((agentSessionId) => store.retain(agentSessionId, api, 'studio'))
    // The reader flushes on a microtask and answers on the next; a macrotask
    // boundary lets every hydration land.
    await Bun.sleep(0)

    expect(batches).toEqual([['agent-1', 'agent-2', 'agent-3']])
    expect(store.metaFor('agent-2')?.sessionId).toBe('agent-2')
    expect(store.statusFor('agent-3')).toBe('idle')
    for (const release of releases) release()
  })
})
