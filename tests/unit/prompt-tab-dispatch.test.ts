import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({ notificationsStore: {} }))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({ serversStore: {} }))
mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))
// The stores this module reaches are plain objects here: no test reads their reactivity.
const runes = globalThis as unknown as { $state?: unknown; $derived?: unknown; $effect?: unknown }
const previousRunes = { $state: runes.$state, $derived: runes.$derived, $effect: runes.$effect }
runes.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
runes.$derived = Object.assign(<T>(value: T) => value, { by: <T>(fn: () => T) => fn() })
runes.$effect = Object.assign(() => {}, { root: () => () => {}, pre: () => {}, tracking: () => false })
afterAll(() => Object.assign(runes, previousRunes))
const { PromptDispatch } = await import('@solus/workspace-ui/contexts/workspace/prompt-dispatch')

// The first send of a new session goes to a host that may be far away. Each
// reply the send waits for is a round trip before the host starts any work, so
// the send waits only for what the prompt itself carries.

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(opts: { worktreeBaseBranch: string | null; startTarget: Promise<void> | null }) {
  const calls: string[] = []
  const watchReply = deferred()
  const session = {
    id: 'session-1',
    agentSessionId: null,
    outboundPrompts: [],
    prompt: { text: '' },
    run: {
      location: folderLocation(
        { serverId: 'remote-host', path: '/repo' },
        { newWorktree: opts.worktreeBaseBranch === null ? null : { baseBranch: opts.worktreeBaseBranch } },
      ),
      provider: 'claude-code',
    },
  } as unknown as Session
  const api = {
    watchSession: () => {
      calls.push('watchSession')
      return watchReply.promise
    },
    prompt: async () => {
      calls.push('prompt')
      return { disposition: 'started' }
    },
  }
  const workspace = {
    apiFor: () => api,
    sessionFor: () => session,
    ctxFor: () => ({ session: { sessionId: session.id } }),
    config: { pendingSessionStartTarget: () => opts.startTarget },
    tasksStore: {},
    eventReducer: { handleError: () => {} },
  }
  const dispatch = new PromptDispatch(workspace as never)
  return { calls, watchReply, dispatch }
}

/** Let every queued step of the send run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('promptTab', () => {
  test('sends the prompt without waiting for the watch reply', async () => {
    const { calls, dispatch } = harness({ worktreeBaseBranch: null, startTarget: null })
    dispatch.promptTab('tab-1', { prompt: 'hello', displayPrompt: 'hello' })
    await settle()
    // The watch goes on the wire first; the prompt follows before its reply.
    expect(calls).toEqual(['watchSession', 'prompt'])
  })

  test('a new worktree with its base branch known does not wait for a Git refresh in flight', async () => {
    const refresh = deferred()
    const { calls, dispatch } = harness({ worktreeBaseBranch: 'main', startTarget: refresh.promise })
    dispatch.promptTab('tab-1', { prompt: 'hello', displayPrompt: 'hello' })
    await settle()
    expect(calls).toEqual(['watchSession', 'prompt'])
  })

  test('a run whose checkout Git has not answered waits for the refresh, because the prompt carries its answer', async () => {
    const refresh = deferred()
    const { calls, dispatch } = harness({ worktreeBaseBranch: null, startTarget: refresh.promise })
    dispatch.promptTab('tab-1', { prompt: 'hello', displayPrompt: 'hello' })
    await settle()
    expect(calls).toEqual(['watchSession'])
    refresh.resolve()
    await settle()
    expect(calls).toEqual(['watchSession', 'prompt'])
  })
})
