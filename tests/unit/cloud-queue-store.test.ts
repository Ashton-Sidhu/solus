import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { CloudQueuedPrompt } from '@solus/contracts/types'
import {
  canCancelQueuedPrompt,
  isLocalQueuedPrompt,
  optimisticQueuedPrompt,
  queuedPromptStateLabel,
  reconcileQueuedPrompts,
  settleQueuedPrompt,
  withQueuedPromptState,
} from '@solus/workspace-ui/components/session/record/lib/cloud-queue'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// docs/plans/cloud-service-model.md, P2: a prompt sent to a cloud session whose
// runner is away lands on the cloud's durable queue. The reader sees the bubble
// at once, sees where it is, and can take back one the runner has not claimed.

const CLOUD = 'workspace:org-1'
const ME = { userId: 'user-me', displayName: 'Me' }
const OTHER = { userId: 'user-other', displayName: 'Ada' }

function hostRow(queueId: string, overrides: Partial<CloudQueuedPrompt> = {}): CloudQueuedPrompt {
  return {
    queueId,
    sessionId: 's1',
    text: `prompt ${queueId}`,
    author: ME,
    state: 'waiting',
    createdAt: 1_000,
    claimedByHostId: null,
    settledAt: null,
    error: null,
    ...overrides,
  }
}

describe('the state label', () => {
  test('names each stop on the way to the agent', () => {
    // WHY: a bubble with no caption reads as sent; the runner may be away for hours.
    expect(queuedPromptStateLabel({ state: 'waiting', error: null })).toBe('Waiting for the runner')
    expect(queuedPromptStateLabel({ state: 'claimed', error: null })).toBe('Picked up by the runner')
    expect(queuedPromptStateLabel({ state: 'dispatched', error: null })).toBe('Sent to the agent')
    expect(queuedPromptStateLabel({ state: 'cancelled', error: null })).toBe('Cancelled')
  })

  test('a failure carries the host\'s reason, and stands alone without one', () => {
    expect(queuedPromptStateLabel({ state: 'failed', error: 'runner refused' })).toBe('Failed: runner refused')
    expect(queuedPromptStateLabel({ state: 'failed', error: null })).toBe('Failed')
  })
})

describe('the optimistic bubble', () => {
  test('is drawn as waiting under a local id until the host answers', () => {
    const local = optimisticQueuedPrompt({ sessionId: 's1', text: 'hi', clientPromptId: 'c1', author: ME, now: 5 })
    expect(local.state).toBe('waiting')
    expect(local.createdAt).toBe(5)
    expect(isLocalQueuedPrompt(local)).toBe(true)
    expect(isLocalQueuedPrompt(hostRow('q1'))).toBe(false)
  })

  test('the host\'s answer takes its place, keeping the queue order', () => {
    const local = optimisticQueuedPrompt({ sessionId: 's1', text: 'hi', clientPromptId: 'c1', author: ME, now: 5 })
    const answer = hostRow('q9', { text: 'hi' })
    expect(settleQueuedPrompt([hostRow('q1'), local], 'c1', answer)).toEqual([hostRow('q1'), answer])
  })

  test('a reload that raced the answer already lists the row, so the local bubble goes rather than doubling', () => {
    // WHY: the queue-changed event fires before the enqueue call returns; the
    // reader must not see the same prompt twice.
    const local = optimisticQueuedPrompt({ sessionId: 's1', text: 'hi', clientPromptId: 'c1', author: ME, now: 5 })
    const answer = hostRow('q9', { text: 'hi' })
    expect(settleQueuedPrompt([answer, local], 'c1', answer)).toEqual([answer])
  })

  test('cannot be cancelled: the host has nothing to cancel yet', () => {
    const local = optimisticQueuedPrompt({ sessionId: 's1', text: 'hi', clientPromptId: 'c1', author: ME, now: 5 })
    expect(canCancelQueuedPrompt(local, ME.userId)).toBe(false)
  })
})

describe('reconciling on a queue-changed event', () => {
  test('the host\'s list replaces what was cached and local bubbles still in flight stay at the end', () => {
    const local = optimisticQueuedPrompt({ sessionId: 's1', text: 'hi', clientPromptId: 'c1', author: ME, now: 5 })
    const stale = hostRow('q1')
    const loaded = [hostRow('q1', { state: 'claimed', claimedByHostId: 'mac' }), hostRow('q2')]
    expect(reconcileQueuedPrompts([stale, local], loaded)).toEqual([...loaded, local])
  })

  test('a cancel is drawn before the host confirms it', () => {
    expect(withQueuedPromptState([hostRow('q1'), hostRow('q2')], 'q2', 'cancelled')).toEqual([
      hostRow('q1'),
      hostRow('q2', { state: 'cancelled' }),
    ])
  })
})

describe('who may cancel', () => {
  test('only the author, and only while the runner has not claimed it', () => {
    // WHY: a claimed prompt is already on its way to the agent; and one reader
    // must not withdraw what another asked.
    expect(canCancelQueuedPrompt(hostRow('q1'), ME.userId)).toBe(true)
    expect(canCancelQueuedPrompt(hostRow('q1', { author: OTHER }), ME.userId)).toBe(false)
    expect(canCancelQueuedPrompt(hostRow('q1', { state: 'claimed' }), ME.userId)).toBe(false)
    expect(canCancelQueuedPrompt(hostRow('q1'), null)).toBe(false)
  })
})

// ─── The store over a mocked host ───

const mockedServerConnections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: mockedServerConnections,
}))

// The store's failure path posts a toast; the test process mounts no toast UI.
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: { error: () => {}, info: () => {}, success: () => {}, warning: () => {} },
}))

declare global { var $state: <T>(value: T) => T }
const previousState = globalThis.$state

afterEach(() => {
  mockedServerConnections.reset()
  if (previousState === undefined) delete (globalThis as { $state?: unknown }).$state
  else globalThis.$state = previousState
})

async function newStore(api: object) {
  globalThis.$state = <T>(value: T) => value
  mockedServerConnections.registerHost(CLOUD, api)
  const { CloudQueueStore } = await import('@solus/workspace-ui/contexts/sessions/cloud-queue.store.svelte')
  return new CloudQueueStore()
}

describe('the store', () => {
  test('a send shows at once, then carries the host\'s id; a queue-changed event re-reads the host', async () => {
    let listed: CloudQueuedPrompt[] = []
    let enqueued: { sessionId: string; text: string; clientPromptId?: string } | null = null
    const store = await newStore({
      sessionPromptQueueList: async () => listed,
      sessionPromptEnqueue: async (request: { sessionId: string; text: string; clientPromptId?: string }) => {
        enqueued = request
        return hostRow('q1', { text: request.text })
      },
    })
    await store.load(CLOUD, 's1')
    expect(store.queueFor(CLOUD, 's1')).toEqual([])

    const sent = store.enqueue(CLOUD, 's1', 'hello', ME)
    expect(store.queueFor(CLOUD, 's1').map((prompt) => [isLocalQueuedPrompt(prompt), prompt.state])).toEqual([[true, 'waiting']])
    expect(await sent).toBe(true)
    expect(store.queueFor(CLOUD, 's1').map((prompt) => prompt.queueId)).toEqual(['q1'])
    expect(enqueued).toMatchObject({ sessionId: 's1', text: 'hello' })

    listed = [hostRow('q1', { text: 'hello', state: 'dispatched', claimedByHostId: 'mac' })]
    mockedServerConnections.emit(CLOUD, 'session.promptQueueChanged', { sessionId: 's1' })
    await Bun.sleep(0)
    expect(store.queueFor(CLOUD, 's1')[0]?.state).toBe('dispatched')
  })

  test('a refused send takes the bubble back so the composer can keep the text', async () => {
    const store = await newStore({
      sessionPromptQueueList: async () => [],
      sessionPromptEnqueue: async () => { throw new Error('no seat') },
    })
    await store.load(CLOUD, 's1')
    expect(await store.enqueue(CLOUD, 's1', 'hello', ME)).toBe(false)
    expect(store.queueFor(CLOUD, 's1')).toEqual([])
  })

  test('a host that cannot list the queue leaves an error the page can show, not a lying empty list', async () => {
    const store = await newStore({
      sessionPromptQueueList: async () => { throw new Error('older host') },
    })
    await store.load(CLOUD, 's1')
    expect(store.errorFor(CLOUD, 's1')).toBe('older host')
  })
})
