import { afterEach, expect, mock, test } from 'bun:test'
import type { IpcContext, TurnSnapshot } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  mock.restore()
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

test('the views of one conversation that mount together share one turn snapshot read and one follow-up', async () => {
  // WHY: the conversation, its artifacts, and its diff each ask for a
  // session's checkpointed turns as they mount, in the same moment. Each sent
  // its own `listTurnSnapshots`; a turn that ends during the read still gets
  // the read after it.
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
  const { WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')
  let reads = 0
  let release!: () => void
  const gate = new Promise<void>((done) => { release = done })
  const store = new WorkspaceLifecycleStore({
    registry: { tabIdsBySession: new Map([['session-one', ['tab-one']]]) } as never,
    sessions: { byId: { 'session-one': { agentSessionId: 'thread-one' } } } as never,
    ctxFor: () => ({}) as IpcContext,
    apiFor: () => ({
      listTurnSnapshots: async (): Promise<TurnSnapshot[]> => {
        reads++
        if (reads === 1) await gate
        return []
      },
    }) as never,
  } as never)

  const first = store.refreshTurnSnapshots('session-one')
  const later = [store.refreshTurnSnapshots('session-one'), store.refreshTurnSnapshots('session-one')]
  release()
  await Promise.all([first, ...later])

  expect(reads).toBe(2)
  expect(store.turnSnapshots['session-one']).toEqual([])
})
