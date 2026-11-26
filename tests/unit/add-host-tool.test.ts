import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMachineOutcomeAnswers } from '@solus/contracts/add-machine'
import type { AgentId, NormalizedEvent } from '@solus/contracts/types'
import type { Actor } from '@solus/server/admission/actor'
import type { AgentBackend } from '@solus/server/execution/agents/agent-backend'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { ListedRemoteHost } from '@solus/server/execution/orchestration/remote-hosts'
import { loadHostIdentity } from '@solus/server/host/host-identity'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: docs/plans/add-machine-card.md. A person once typed their Windows password
// into a generic secret card, and `pair_host` sent it to the remote host. `add_host`
// shows the Add machine card instead: the client adds the machine with the host's own
// RPCs, and the card's answer names only the host that was added. The tool must not
// show a card for a machine this host already reaches, must return only a host that
// this host holds a credential for (a client's answer is not proof), and must close
// the card on a decline or a stopped run.

type Runtime = import('@solus/server/execution/session-runtime').SessionRuntime
type Question = Extract<NormalizedEvent, { type: 'question_request' }>

let root: string
let runtimeModule: typeof import('@solus/server/execution/session-runtime')
let tools: typeof import('@solus/server/execution/agents/tools/host-pairing-tools')
let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')
let withWorkspaceToolAuthority: typeof import('@solus/server/admission/workspace-tool-authority')['withWorkspaceToolAuthority']
let HostPairings: typeof import('@solus/server/host/host-pairings')['HostPairings']
let closeDb: typeof import('@solus/server/db')['closeDb']
let HOST_ACTOR: Actor
const previousDataDir = process.env.SOLUS_DATA_DIR

const OWNER = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' } as const
const WINDOWS_URL = 'http://10.10.1.10:3000'
/** What the client sends to `hostsPair` before it answers the card. */
const CODE = '482913'
const TOKEN = 'private-host-token'

/** What `list_hosts` lists now; a test changes it as the machines change. */
let listed: ListedRemoteHost[] = []
const windows = (status: ListedRemoteHost['status'], source: ListedRemoteHost['source'] = 'paired'): ListedRemoteHost => ({
  id: 'win', installationId: 'win', name: 'Windows', source, status, routes: [{ kind: 'lan', url: WINDOWS_URL }],
})

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-add-host-')))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  runtimeModule = await import('@solus/server/execution/session-runtime')
  tools = await import('@solus/server/execution/agents/tools/host-pairing-tools')
  sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
  ;({ withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority'))
  ;({ HostPairings } = await import('@solus/server/host/host-pairings'))
  ;({ closeDb } = await import('@solus/server/db'))
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  // SAFETY: add_host reads only `summaries`, the list that list_hosts shows.
  sessionTools.setRemoteHosts({ summaries: async () => listed } as never)
  tools.setHostPairingTools(new HostPairings(() => 'self', () => 'Mac'))
})

afterAll(() => {
  sessionTools.setRemoteHosts(null)
  tools.setHostPairingTools(null)
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

/** A provider that answers no question itself: only add_host takes the answer of its card. */
class QuietBackend extends EventEmitter {
  readonly id: AgentId = 'codex'
  readonly permissions = {
    getPendingInfo: () => undefined,
    respondToPermission: () => false,
    respondToQuestion: () => false,
    clearPendingForSession: () => {},
    setCurrentSessionId: () => {},
  }
  getSessionHandle(): undefined { return undefined }
  cancelSession(): boolean { return false }
  isSessionRunning(): boolean { return false }
  getPendingHandles(): never[] { return [] }
}

interface Live {
  runtime: Runtime
  sessionId: string
  /** Every event the session published, as its clients get them. */
  events: NormalizedEvent[]
  /** Resolves when the session showed its card number `count`. */
  shown(count?: number): Promise<Question>
  context: AgentToolContext
  stop: AbortController
  answer(card: Question, answers: Record<string, string>): Promise<boolean>
}

/** A session with a running turn; the tool's events go through the provider event path, as a real turn's do. */
function liveSession(sessionId: string): Live {
  const backend = new QuietBackend()
  // SAFETY: the test backend has each member that the event path of a question reads.
  const runtime = new runtimeModule.SessionRuntime(new Map([['codex', backend as unknown as AgentBackend]]))
  const thread = `thread-${sessionId}`
  runtime.agentSessionToSession.set(thread, sessionId)
  runtime.activeSessions.set(sessionId, {
    sessionId, agentSessionId: thread, backendId: 'codex', status: 'running', pendingInputEvents: [],
    lastActivityAt: Date.now(), promptCount: 1,
  })
  const events: NormalizedEvent[] = []
  const waiting: (() => void)[] = []
  runtime.on('event', (id: string, event: NormalizedEvent) => {
    if (id !== sessionId) return
    events.push(event)
    for (const wake of waiting.splice(0)) wake()
  })
  const cards = () => events.filter((event): event is Question => event.type === 'question_request')
  const shown = async (count = 1): Promise<Question> => {
    while (cards().length < count) await new Promise<void>((wake) => { waiting.push(wake) })
    return cards()[count - 1]!
  }
  const stop = new AbortController()
  const context: AgentToolContext = {
    provider: 'codex', cwd: root, sessionId: () => sessionId, abortSignal: stop.signal, parentToolUseId: () => undefined,
    emit: (event) => { backend.emit('normalized', thread, event) },
  }
  return {
    runtime, sessionId, events, shown, context, stop,
    answer: (card, answers) => runtime.inputRequests.respondToQuestion(sessionId, card.questionId, answers, HOST_ACTOR),
  }
}

const addHost = (live: Live, input: { hint?: string; url?: string; reason: string }) =>
  withWorkspaceToolAuthority(OWNER, () => tools.addHostAgentTool.execute(input, live.context))

describe('add_host', () => {
  test('a machine this host already reaches is returned with no card', async () => {
    listed = [windows('online')]
    const live = liveSession('already-reached')
    try {
      const byAddress = await addHost(live, { url: '10.10.1.10:3000', reason: 'Run the tests on Windows.' })
      expect(byAddress.ok).toBe(true)
      expect(JSON.parse(byAddress.text)).toMatchObject({ alreadyReached: true, host: { installationId: 'win', status: 'online' } })
      const byName = await addHost(live, { hint: 'windows', reason: 'Run the tests on Windows.' })
      expect(JSON.parse(byName.text)).toMatchObject({ alreadyReached: true, host: { installationId: 'win' } })
      expect(live.events.filter((event) => event.type === 'question_request')).toEqual([])
    } finally { live.runtime.shutdown() }
  })

  test('a listed machine that is offline still gets the card, which every client can show and replay', async () => {
    listed = [windows('unreachable')]
    const live = liveSession('card-shown')
    try {
      const pending = addHost(live, { hint: 'my windows machine', url: `${WINDOWS_URL}/pair#token=leaked`, reason: 'Run the tests on Windows.' })
      const card = await live.shown()
      expect(card.kind).toBe('host-link')
      // The address is an origin: a pasted pair link's token is not on the card.
      expect(card.hostLink).toEqual({ hint: 'my windows machine', url: WINDOWS_URL, reason: 'Run the tests on Windows.' })
      expect(JSON.stringify(card)).not.toContain('leaked')
      // An older client that does not know the kind still shows what the agent asks.
      expect(card.questions).toEqual([{ header: 'Add a machine', question: 'Run the tests on Windows.', options: [], multiSelect: false }])
      // The pending copy that a client joining later replays keeps the ask.
      expect(live.runtime.inputRequests.pendingInputEventsForSession(live.sessionId)).toContainEqual(expect.objectContaining({ questionId: card.questionId, hostLink: card.hostLink }))
      expect(await live.answer(card, addMachineOutcomeAnswers({ status: 'declined' }))).toBe(true)
      const result = await pending
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.text)).toMatchObject({ added: false, declined: true })
      expect(live.events).toContainEqual({ type: 'permission_resolved', questionId: card.questionId })
      expect(live.runtime.inputRequests.pendingInputEventsForSession(live.sessionId)).toEqual([])
    } finally { live.runtime.shutdown() }
  })

  test('the added machine is returned only when this host holds a credential for it, and no secret is in the output', async () => {
    listed = []
    const identity = loadHostIdentity(join(root, 'remote-identity'))
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/health') return Response.json({ ok: true, installationId: 'win', name: 'Windows' })
      if (url.pathname === '/pair') return Response.json({ sessionToken: TOKEN, installationId: 'win', os: 'windows', identityKey: identity.publicKey() })
      return new Response(null, { status: 404 })
    }
    const pairings = new HostPairings(() => 'self', () => 'Mac', fetchImpl)
    const live = liveSession('card-added')
    try {
      const pending = addHost(live, { url: WINDOWS_URL, reason: 'Run the tests on Windows.' })
      const card = await live.shown()
      // The client pairs with `hostsPair { url, code }`; the card's answer names only the host.
      const host = await pairings.pair({ url: WINDOWS_URL, code: CODE })
      listed = pairings.snapshot().hosts.map(({ listing }) => ({ id: listing.installationId, installationId: listing.installationId, name: listing.label, source: 'paired', status: 'online', routes: listing.routes }))
      expect(await live.answer(card, addMachineOutcomeAnswers({ status: 'added', installationId: host.installationId, way: 'code' }))).toBe(true)
      const result = await pending
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.text)).toMatchObject({ added: true, way: 'code', host: { installationId: 'win', name: 'Windows' } })
      for (const text of [result.text, JSON.stringify(live.events)]) {
        expect(text).not.toContain(CODE)
        expect(text).not.toContain(TOKEN)
      }
    } finally {
      pairings.forget('win')
      live.runtime.shutdown()
    }
  })

  test('a forged answer for a host this host does not hold is refused', async () => {
    listed = [windows('online', 'listed')]
    const live = liveSession('card-forged')
    try {
      const pending = addHost(live, { url: 'http://10.10.1.99:3000', reason: 'Add the build box.' })
      const card = await live.shown()
      expect(await live.answer(card, addMachineOutcomeAnswers({ status: 'added', installationId: 'win', way: 'ssh' }))).toBe(true)
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.text).toContain('holds no record')
      // An answer that is no outcome at all is refused too.
      const again = addHost(live, { url: 'http://10.10.1.99:3000', reason: 'Add the build box.' })
      const second = await live.shown(2)
      expect(await live.answer(second, { status: 'added', installationId: 'win', way: 'telepathy' })).toBe(true)
      expect((await again).ok).toBe(false)
    } finally { live.runtime.shutdown() }
  })

  test('a stopped run closes the card', async () => {
    listed = []
    const live = liveSession('card-stopped')
    try {
      const pending = addHost(live, { reason: 'Add a machine.' })
      const card = await live.shown()
      live.stop.abort()
      const result = await pending
      expect(result.ok).toBe(false)
      expect(live.events).toContainEqual({ type: 'permission_resolved', questionId: card.questionId })
      expect(await live.answer(card, addMachineOutcomeAnswers({ status: 'declined' }))).toBe(false)
    } finally { live.runtime.shutdown() }
  })

  test('only a locally authorized owner session can show the card', async () => {
    listed = []
    const live = liveSession('card-refused')
    try {
      const member = { kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'a', deviceLabel: 'Remote', expiresAt: 1 } as const
      expect((await withWorkspaceToolAuthority(member, () => tools.addHostAgentTool.execute({ reason: 'Add a machine.' }, live.context))).ok).toBe(false)
      expect((await tools.addHostAgentTool.execute({ reason: 'Add a machine.' }, live.context)).ok).toBe(false)
      expect(live.events).toEqual([])
    } finally { live.runtime.shutdown() }
  })
})
