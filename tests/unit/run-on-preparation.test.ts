import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { CloneCheckout, Session, SessionCtx } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { TransportDisconnectedError } from '@solus/client-core/rpc-error'
import { sendOutbox } from '@solus/client-core/send-outbox'

// A Run on send to a host with no checkout lets that host copy the repository
// when the prompt arrives (docs/run-on.md). Each reply the send waits for is a
// round trip before the host starts any work, so the client waits only for the
// connection, and the prompt carries the repository.

mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({ notificationsStore: {} }))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: {
    hostFor: () => ({ label: 'Studio', local: false }),
    readinessFor: () => ({ readiness: 'ready' }),
  },
}))
mock.module('@solus/workspace-ui/lib/analytics', () => ({ track: () => {} }))
mock.module('@solus/workspace-ui/lib/inputFocus', () => ({
  FOCUS_INPUT_EVENT: 'solus:focus-input',
  requestInputFocus: () => {},
  blurActiveTextInputOnMobile: () => {},
}))
mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))
// The stores this module reaches are plain objects here: no test reads their reactivity.
const runes = globalThis as unknown as { $state?: unknown; $derived?: unknown; $effect?: unknown; window?: unknown }
const previous = { $state: runes.$state, $derived: runes.$derived, $effect: runes.$effect, window: runes.window }
runes.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
runes.$derived = Object.assign(<T>(value: T) => value, { by: <T>(fn: () => T) => fn() })
runes.$effect = Object.assign(() => {}, { root: () => () => {}, pre: () => {}, tracking: () => false })
// The client shell reads its platform from `window.solus`.
runes.window = { solus: { getPlatform: () => 'darwin' }, dispatchEvent: () => true }
afterAll(() => Object.assign(runes, previous))

const { PromptDispatch } = await import('@solus/workspace-ui/contexts/workspace/prompt-dispatch')
const { IpcContextBuilder } = await import('@solus/workspace-ui/contexts/workspace/ipc-context')
const { cloneUrlForRepoKey, delegatedGithubCredential, dispatchRepository } = await import('@solus/workspace-ui/components/servers/run-on')
const { dispatchTo, chooseStart, folderLocation, pendingClone } = await import('@solus/workspace-ui/contexts/workspace/run-location')

type Connections = {
  localServerId: () => string | null
  ensure: (serverId: string) => unknown
  capabilitiesFor: (serverId: string) => Promise<unknown>
  cachedCapabilitiesFor: (serverId: string) => unknown
  apiFor: (serverId: string) => unknown
}
// SAFETY: the test replaces only the members of the connection singleton that the send reads.
const connections = serverConnections as unknown as Connections
const originalConnections = { ...connections }
afterAll(() => Object.assign(connections, originalConnections))

const HOME = { serverId: LOCAL_SERVER_ID, path: '/Users/me/solus' }
const REPO_KEY = 'github.com/solus-sh/solus'
const CALLER = { accessToken: 'caller-token', login: 'caller' }

function cloneOf(start: Parameters<typeof chooseStart>[1] | null): CloneCheckout {
  const home = folderLocation(HOME, { git: { repoRoot: HOME.path, branch: 'main', targetBranch: 'main' } })
  const location = dispatchTo(home, 'studio', REPO_KEY)
  const clone = pendingClone({ location: start ? chooseStart(location, start) : location })
  if (!clone) throw new Error('not a clone')
  return clone
}

describe('the repository a clone run asks its host to copy', () => {
  test('names the start the person chose', () => {
    // WHY: the host makes the checkout ready for exactly that start. A worktree
    // path belongs to the target host; a new worktree is made there.
    expect(dispatchRepository(cloneOf(null))).toEqual({ cloneUrl: 'https://github.com/solus-sh/solus.git', baseBranch: 'main' })
    expect(dispatchRepository(cloneOf({ kind: 'new-worktree' }))).toEqual({ cloneUrl: 'https://github.com/solus-sh/solus.git', newWorktree: true })
    // An origin branch is worked on, as before the host made the copy itself.
    expect(dispatchRepository(cloneOf({ kind: 'new-worktree', baseBranch: 'release' }))).toEqual({ cloneUrl: 'https://github.com/solus-sh/solus.git', baseBranch: 'release' })
    expect(dispatchRepository(cloneOf({ kind: 'worktree', path: '/srv/solus/.git/solus/worktrees/release', branch: 'release' })))
      .toEqual({ cloneUrl: 'https://github.com/solus-sh/solus.git', worktreePath: '/srv/solus/.git/solus/worktrees/release' })
  })

  test('is absent for an identity that cannot name a clone remote', () => {
    expect(cloneUrlForRepoKey('local-only')).toBeNull()
    expect(dispatchRepository({ ...cloneOf(null), repoKey: 'local-only' })).toBeNull()
  })

  test('lends the caller’s credential only to another host', async () => {
    // WHY: private-repository access follows the person who sent the work, not
    // whichever account owns the target. A send to this machine clones as itself.
    connections.localServerId = () => LOCAL_SERVER_ID
    const local = { githubExportCredential: async () => CALLER }
    expect(await delegatedGithubCredential('studio', local)).toEqual(CALLER)
    expect(await delegatedGithubCredential(LOCAL_SERVER_ID, local)).toBeUndefined()
    // A web client has no machine of its own: the target uses its own token.
    connections.localServerId = () => null
    expect(await delegatedGithubCredential('studio', local)).toBeUndefined()
    // A failed export is not a failed send.
    connections.localServerId = () => LOCAL_SERVER_ID
    expect(await delegatedGithubCredential('studio', { githubExportCredential: async () => { throw new Error('locked') } })).toBeUndefined()
  })
})

/** A browser-shaped store, so a test can read what the outbox wrote. */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  }
}

/** Let every queued step of the send run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** One clone run to the `studio` host. `sendFails` makes the target's prompt
 *  replies fail until the test clears it. */
function cloneRunHarness() {
  const targetCalls: string[] = []
  const prompts: SessionCtx[] = []
  const retries: SessionCtx[] = []
  const state = { sendFails: null as Error | null }
  const target = {
    watchSession: async () => { targetCalls.push('watchSession') },
    prompt: async (ctx: { session: SessionCtx }) => {
      targetCalls.push('prompt')
      prompts.push(structuredClone(ctx.session))
      if (state.sendFails) throw state.sendFails
      return { disposition: 'started' }
    },
    retry: async (ctx: { session: SessionCtx }) => {
      retries.push(structuredClone(ctx.session))
    },
  }
  connections.localServerId = () => LOCAL_SERVER_ID
  connections.ensure = () => ({ target: { label: 'Studio' }, api: target })
  connections.capabilitiesFor = async () => { targetCalls.push('capabilities'); return {} }
  connections.cachedCapabilitiesFor = () => ({})
  connections.apiFor = (serverId) => serverId === LOCAL_SERVER_ID ? { githubExportCredential: async () => CALLER } : target

  const home = folderLocation(HOME, { git: { repoRoot: HOME.path, branch: 'main', targetBranch: 'main' }, newWorktree: { baseBranch: 'main' } })
  const session = {
    id: 'session-1',
    status: 'idle',
    statusCard: null,
    agentSessionId: null,
    messages: [],
    outboundPrompts: [],
    additionalDirs: [],
    permissionQueue: [],
    questionQueue: [],
    prompt: { text: '', attachments: [], planRefs: [], workRefs: [], sessionRefs: [] },
    task: { kind: 'none' },
    readOnlyReason: null,
    run: {
      location: dispatchTo(home, 'studio', REPO_KEY),
      provider: 'claude-code',
      permissionMode: 'supervised',
      modelConfig: { modelId: null, reasoningEffort: 'medium', contextWindow: null, fastMode: false },
    },
  } as unknown as Session
  const contexts = new IpcContextBuilder({
    sessionFor: () => session,
    runFor: () => session.run,
    hasDraft: () => false,
    defaultRunConfig: () => session.run,
    settings: { ctx: {} } as never,
    statusBar: { ctx: {}, ctxFor: () => ({}), ctxForRun: () => ({}) } as never,
  })
  const workspace = {
    tabs: { 'tab-1': { id: 'tab-1', sessionId: session.id } },
    tabOrder: ['tab-1'],
    activeTabId: 'tab-1',
    focusedSourceId: null,
    drafts: { sessionDrafts: new Map() },
    settings: { activeAgent: 'claude-code' },
    promptComposer: {
      compose: (prompt: string) => prompt,
      composeImages: () => [],
      composeImagePayload: () => ({ inline: undefined, refs: undefined }),
    },
    config: { pendingSessionStartTarget: () => null },
    tasksStore: { taskForSession: () => null },
    eventReducer: { closeAgentConversationTurn: () => {}, handleError: () => {} },
    apiFor: () => target,
    sessionFor: () => session,
    ctxFor: () => contexts.forTab('tab-1'),
    tabIdForSession: (sessionId: string) => sessionId === session.id ? 'tab-1' : null,
  }
  const dispatch = new PromptDispatch(workspace as never)
  return { dispatch, session, targetCalls, prompts, retries, state }
}

describe('a Run on send that copies the repository', () => {
  test('waits for the connection only, then sends one prompt that carries the repository', async () => {
    const { dispatch, session, targetCalls, prompts } = cloneRunHarness()
    expect(dispatch.sendMessage('hello', undefined, 'tab-1')).toBe(true)
    await settle()

    // WHY: the host makes the checkout when the prompt arrives. The send must not
    // ask the target to prepare it first, nor read Git there before sending.
    expect(targetCalls.filter((call) => call !== 'watchSession')).toEqual(['capabilities', 'prompt'])
    expect(prompts).toHaveLength(1)
    expect(prompts[0].repository).toEqual({ cloneUrl: 'https://github.com/solus-sh/solus.git', newWorktree: true, credential: CALLER })
    // The repository names the start; the host names the new worktree's base.
    expect(prompts[0].worktreeBaseBranch).toBeNull()
    // The client card shows its connection done and the host's repository step next.
    expect(session.statusCard?.steps.slice(0, 2).map((step) => [step.id, step.status])).toEqual([['connection', 'done'], ['repository', 'active']])
    // The run stays a clone until the host names the folder it made.
    expect(pendingClone(session.run)).not.toBeNull()
  })
})

describe('every send of a Run on prompt', () => {
  // WHY: the clone on the run host works as the person who sent it. The
  // credential is never stored, so each send reads it again from this device's
  // own host; a resend without it falls back to the run host's token and can
  // fail with Connect GitHub.

  test('a retry carries the credential again', async () => {
    const { dispatch, session, retries } = cloneRunHarness()
    expect(dispatch.sendMessage('hello', undefined, 'tab-1')).toBe(true)
    await settle()
    session.status = 'failed'
    dispatch.retryLastMessage('tab-1')
    await settle()
    expect(retries).toHaveLength(1)
    expect(retries[0].repository?.credential).toEqual(CALLER)
    // The credential stays on the context of that one send.
    expect(JSON.stringify(session)).not.toContain(CALLER.accessToken)
  })

  test('an outbox redelivery carries the credential, and the outbox never holds it', async () => {
    const globals = globalThis as unknown as { localStorage?: Storage }
    const previousStorage = globals.localStorage
    const storage = memoryStorage()
    globals.localStorage = storage
    try {
      const { dispatch, prompts, state } = cloneRunHarness()
      // The transport dies under the first send: its entry stays for the drain.
      state.sendFails = new TransportDisconnectedError()
      expect(dispatch.sendMessage('hello', undefined, 'tab-1')).toBe(true)
      await settle()
      expect(prompts[0].repository?.credential).toEqual(CALLER)
      const queued = sendOutbox.entriesFor('studio')
      expect(queued).toHaveLength(1)
      for (let i = 0; i < storage.length; i++) {
        expect(storage.getItem(storage.key(i) ?? '')).not.toContain(CALLER.accessToken)
      }
      expect(JSON.stringify(queued)).not.toContain(CALLER.accessToken)

      state.sendFails = null
      await sendOutbox.drain('studio', (record) => dispatch.redeliverOutboxPrompt('studio', record))
      expect(prompts).toHaveLength(2)
      expect(prompts[1].repository?.credential).toEqual(CALLER)
      expect(sendOutbox.entriesFor('studio')).toHaveLength(0)
    } finally {
      globals.localStorage = previousStorage
    }
  })

  test('a failed credential read sends without it', async () => {
    const { dispatch, session, retries } = cloneRunHarness()
    const targetFor = connections.apiFor
    connections.apiFor = (serverId) => serverId === LOCAL_SERVER_ID
      ? { githubExportCredential: async () => { throw new Error('locked') } }
      : targetFor(serverId)
    expect(dispatch.sendMessage('hello', undefined, 'tab-1')).toBe(true)
    await settle()
    session.status = 'failed'
    dispatch.retryLastMessage('tab-1')
    await settle()
    expect(retries).toHaveLength(1)
    expect(retries[0].repository).toEqual({ cloneUrl: 'https://github.com/solus-sh/solus.git', newWorktree: true })
  })
})
