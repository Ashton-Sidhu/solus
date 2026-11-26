import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunRequest, AgentRunSessionState } from '@solus/server/execution/agents/agent-runner'
import type { AgentBackend, RunHandle } from '@solus/server/execution/agents/agent-backend'
import { storeAttachmentBytes } from '@solus/server/data/assets/attachment-store'
import type { IpcContext, NormalizedEvent, PromptOptions, QueuedPromptSnapshot } from '@solus/contracts/types'
import { installTestIdentities } from './helpers/acting-identities'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type SessionRuntimeModule = typeof import('@solus/server/execution/session-runtime')
type DbModule = typeof import('@solus/server/db')

// The control plane reads session lineage from the host database: point it at a
// disposable directory so the test never opens live Solus data.
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let sessionRuntimeModule: SessionRuntimeModule
let inputRequestsModule: typeof import('@solus/server/execution/sessions/input-requests')
let db: DbModule
let actors: typeof import('./helpers/actors')
let HOST_ACTOR: typeof import('@solus/server/admission/actor')['HOST_ACTOR']

// The launcher refuses a working directory that does not exist.
const projectDir = mkdtempSync(join(tmpdir(), 'solus-queue-author-project-'))

beforeAll(async () => {
  // A prompt reaches the host from a person's call, in that call's acting scope; here, the host's.
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  dataDir = mkdtempSync(join(tmpdir(), 'solus-control-plane-queue-author-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionRuntimeModule = await import('@solus/server/execution/session-runtime')
  inputRequestsModule = await import('@solus/server/execution/sessions/input-requests')
  db = await import('@solus/server/db')
  actors = await import('./helpers/actors')
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

// docs/plans/multiplayer-presence.md §5: a held prompt names its author on the
// queue event and on the snapshot a reconnecting client reads, the same way a
// sent prompt names it on the transcript echo. The host's own work carries no name.

/** A backend whose runs stay busy until the test lets them go, so a second prompt queues. */
function holdingBackend(provider: 'claude-code' | 'codex' = 'claude-code', prefix = provider === 'claude-code' ? 'thread' : 'codex-thread') {
  const handles = new Map<string, RunHandle>()
  const releases: Array<() => void> = []
  const requests: AgentRunRequest[] = []
  const starts: Array<(request: AgentRunRequest) => void> = []
  const backend = Object.assign(new EventEmitter(), {
    id: provider,
    metadata: { id: provider, label: provider, models: [], defaultModel: '' },
    loadSession: async () => [{ role: 'user' as const, content: 'Original task', timestamp: 1 }],
    permissions: { getPendingInfo: () => undefined, respondToPermission: () => false, respondToQuestion: () => false, clearPendingForSession: () => {}, setCurrentSessionId: () => {} },
    getEnrichedError: () => ({ message: '', stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 }),
    isSessionRunning: (threadId: string) => handles.has(threadId),
    getSessionHandle: (threadId: string) => handles.get(threadId),
    // A cancelled run exits the way a provider does after an interrupt.
    cancelSession: (threadId: string) => {
      if (!handles.has(threadId)) return false
      queueMicrotask(() => { handles.delete(threadId); backend.emit('exit', threadId, null, 'SIGINT') })
      return true
    },
    getPendingHandles: () => [],
    shutdown: () => {},
    startRun(request: AgentRunRequest): RunHandle {
      requests.push(request)
      starts.shift()?.(request)
      let resolve!: () => void
      const runPromise = new Promise<void>((res) => { resolve = res })
      const threadId = `${prefix}-${requests.length}`
      const handle: RunHandle = {
        agentSessionId: threadId,
        persistence: request.persistence,
        startedAt: Date.now(),
        toolCallCount: 0,
        sawPermissionRequest: false,
        permissionDenials: [],
        abortController: new AbortController(),
        runPromise,
        _resolveRun: resolve,
        _rejectRun: () => {},
      }
      handles.set(threadId, handle)
      releases.push(() => { handles.delete(threadId); resolve(); backend.emit('exit', threadId, 0, null) })
      // The provider names its thread, which binds the session to it so a later
      // prompt for the same session finds it busy.
      queueMicrotask(() => {
        backend.emit('normalized', threadId, { type: 'session_init', sessionId: threadId, model: 'test', skills: [] } satisfies NormalizedEvent)
      })
      return handle
    },
  })
  return { value: backend as unknown as AgentBackend, requests,
    nextStart: () => new Promise<AgentRunRequest>((resolve) => starts.push(resolve)),
    releaseOne: () => releases.shift()?.(), releaseAll: () => { for (const release of releases.splice(0)) release() } }
}

const cleanups: Array<() => void> = []
const recoveryRoots: string[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  db.closeDb()
  for (const root of recoveryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function ctx(sessionId: string, agentSessionId: string | null = null): IpcContext {
  return {
    session: { sessionId, provider: 'claude-code', agentSessionId, workingDirectory: projectDir, projectPath: projectDir, origin: 'user',
      gitContext: null, worktreeBaseBranch: null, contextWindow: 1_000_000,
      preferredModel: 'claude-sonnet-5', permissionMode: 'full-access' },
    window: {},
    statusBar: { activeAgent: 'claude-code', model: 'claude-sonnet-5', reasoningEffort: 'medium', permissionMode: 'full-access', fastMode: false },
  } as unknown as IpcContext
}

// Members act from homes of their own, as on a booted server (plans/019).
installTestIdentities()

describe('queue author', () => {
  test('a member\'s held prompt is stamped with their identity; the host\'s own is not', async () => {
    const backend = holdingBackend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const events: NormalizedEvent[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

    await plane.dispatch.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-bob', actor: actors.memberActor('bob', 'Bob') })
    await Promise.resolve()
    const second = await plane.dispatch.submitPrompt(ctx('s1', 'thread-1'), { prompt: 'then deploy', clientPromptId: 'p-cara', delivery: 'queue' }, {
      clientId: 'c-cara', actor: actors.memberActor('cara', 'Cara', { avatarUrl: 'https://x/cara.png' }),
    })
    expect(second.disposition).toBe('queued')
    await plane.dispatch.submitPrompt(ctx('s1', 'thread-1'), { prompt: 'and the host', delivery: 'queue' }, { clientId: 'c-owner', actor: HOST_ACTOR })

    const cara = actors.accountUser('cara', 'Cara', { avatarUrl: 'https://x/cara.png' })
    const queued = events.filter((event): event is Extract<NormalizedEvent, { type: 'prompt_queued' }> => event.type === 'prompt_queued')
    expect(queued.map((event) => event.author)).toEqual([cara, undefined])

    // A client that connects later reads the same names from the queue snapshot
    // (the one `watchSession` attaches; read directly, since attaching also
    // reconciles the run, which is not what is under test).
    const snapshot = plane.scheduler.queuedPromptsForSession('s1')
    expect(snapshot.map((prompt) => [prompt.clientPromptId, prompt.author])).toEqual([['p-cara', cara], [undefined, undefined]])
  })

  // The provider's transcript keeps only the text of a prompt. In a session that
  // two people drive, a reload names each prompt's author only from this record.
  test('the host keeps the person who wrote a sent prompt, and nobody for a message that no person wrote', async () => {
    const backend = holdingBackend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const { activityFor } = await import('@solus/server/data/activity/activity')
    const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
    const { promptHash } = await import('@solus/server/data/activity/prompt-senders')
    const keptFor = (sessionId: string) => activityFor(ANY_ORGANIZATION, { kind: 'session', id: sessionId }, { kind: 'prompt_sent' })
    /** The record is written beside the launch, so a read waits for it. */
    const settled = async (sessionId: string) => {
      for (let attempt = 0; attempt < 50 && (await keptFor(sessionId)).length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
      return keptFor(sessionId)
    }

    await plane.dispatch.submitPrompt(ctx('by-bob'), { prompt: '[Attached file: /tmp/a.log]\n\nRead this log', displayPrompt: 'Read this log' }, { clientId: 'c-bob', actor: actors.memberActor('bob', 'Bob') })
    const kept = await settled('by-bob')
    expect(kept.map((entry) => entry.by)).toEqual([{ kind: 'user', user: actors.accountUser('bob', 'Bob') }])
    // The key is what the person typed, which is what a client shows.
    expect(kept[0]).toMatchObject({ kind: 'prompt_sent', promptHash: promptHash('Read this log') })

    await plane.dispatch.submitPrompt(ctx('by-host'), { prompt: 'start' }, { clientId: 'c-owner', actor: HOST_ACTOR })
    await plane.dispatch.submitPrompt(ctx('by-solus'), { prompt: 'The command ended.', via: 'background-command' }, { clientId: 'c-bob', actor: actors.memberActor('bob', 'Bob') })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await keptFor('by-host')).toEqual([])
    expect(await keptFor('by-solus')).toEqual([])
  })
})

// WHY: a composer sends only the typed text for display. Without the paths,
// every client that did not send the prompt shows it with no file at all.
test('the echo of a prompt names its files for the clients that did not send it', async () => {
  const backend = holdingBackend()
  const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
  plane.on('error', () => {})
  cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
  const sent: NormalizedEvent[] = []
  plane.on('event', (_sessionId: string, event: NormalizedEvent) => sent.push(event))

  await plane.dispatch.submitPrompt(ctx('with-file'), {
    prompt: '[Attached file: /tmp/clip.mp4]\n\nIt still loads', displayPrompt: 'It still loads', clientPromptId: 'phone-1',
  }, { clientId: 'c-phone', actor: HOST_ACTOR })
  // send_session has no display text: its lines are in the text already.
  await plane.dispatch.submitPrompt(ctx('from-agent'), { prompt: '[Attached file: /tmp/a.log]\n\nRead this' }, { actor: HOST_ACTOR })

  const echoes = sent.filter((event) => event.type === 'user_message')
  expect(echoes).toMatchObject([
    { text: 'It still loads', attachedFilePaths: ['/tmp/clip.mp4'] },
    { text: '[Attached file: /tmp/a.log]\n\nRead this' },
  ])
  expect(echoes[1]).not.toHaveProperty('attachedFilePaths')
})

test('a prompt sent after Stop waits for the stopped provider run to exit', async () => {
  const backend = holdingBackend('codex', 'stopping-codex')
  const plane = new sessionRuntimeModule.SessionRuntime(new Map([['codex', backend.value]]))
  plane.on('error', () => {})
  cleanups.push(() => { plane.shutdown(); backend.releaseAll() })
  // Codex accepts the interrupt but reports the exit separately.
  spyOn(backend.value, 'cancelSession').mockReturnValue(true)
  const context = ctx('stopping', 'stopping-codex-1')
  context.session.provider = 'codex'
  await plane.dispatch.submitPrompt(context, { prompt: 'start' }, { actor: HOST_ACTOR })
  await Promise.resolve()
  expect(plane.stopSession('stopping', HOST_ACTOR)).toBe(true)
  expect(plane.activeSessions.get('stopping')?.status).toBe('interrupted')

  const next = await plane.dispatch.submitPrompt(context, { prompt: 'next turn' }, { actor: HOST_ACTOR })
  expect(next.disposition).toBe('queued')
  expect(plane.scheduler.processQueueForSession('stopping')).toBe(false)
  expect(backend.requests.map((request) => request.prompt)).toEqual(['start'])

  const nextRun = backend.nextStart()
  backend.releaseOne()
  expect((await nextRun).prompt).toBe('next turn')
})

// WHY: a session restored without its git context still points at its old
// worktree. Spawned there, Claude fails with a libc message and the sender
// cannot tell the worktree is gone. The provider must not start at all.
describe('a working directory that is gone', () => {
  test('stops the turn before the provider starts and says what is missing', async () => {
    const backend = holdingBackend('claude-code', 'gone-thread')
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { plane.shutdown(); backend.releaseAll() })
    const removed = join(projectDir, 'removed-worktree')
    const gone = ctx('gone')
    gone.session.workingDirectory = removed
    gone.session.projectPath = removed
    await expect(plane.dispatch.submitPrompt(gone, { prompt: 'Fix the width' }, { clientId: 'owner', actor: HOST_ACTOR }))
      .rejects.toThrow(`The working directory ${removed} no longer exists`)
    expect(backend.requests).toHaveLength(0)
  })
})

for (const provider of ['claude-code', 'codex'] as const) {
  test(`${provider} receives the inline review instructions through normal prompt dispatch`, async () => {
    const backend = holdingBackend(provider)
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([[provider, backend.value]]))
    runtime.on('error', () => {})
    cleanups.push(() => { runtime.shutdown(); backend.releaseAll() })
    const context = ctx('inline-review')
    context.session.provider = provider
    await runtime.dispatch.submitPrompt(context, { prompt: '/review-guide focus on tests' }, { actor: HOST_ACTOR })
    expect(backend.requests[0]?.prompt).toContain('no captured turn snapshots')
  })
}

describe('durable queue controls', () => {
  test('a prompt refused before delivery can retry with the same client receipt', async () => {
    const backend = holdingBackend('claude-code', 'retry-thread')
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { plane.shutdown(); backend.releaseAll() })
    const runTurn = plane.runTurn.bind(plane)
    let refuse = true
    plane.runTurn = async (...args) => {
      if (refuse) { refuse = false; throw new Error('Queue storage unavailable') }
      return runTurn(...args)
    }
    const options = { prompt: 'Fix the parser', clientPromptId: 'retry-receipt' }
    await expect(plane.dispatch.submitPrompt(ctx('retry'), options, { actor: HOST_ACTOR })).rejects.toThrow('Queue storage unavailable')
    expect((await plane.dispatch.submitPrompt(ctx('retry'), options, { actor: HOST_ACTOR })).disposition).not.toBe('duplicate')
    expect(backend.requests).toHaveLength(1)
    expect((await plane.dispatch.submitPrompt(ctx('retry'), options, { actor: HOST_ACTOR })).disposition).toBe('duplicate')
    expect(backend.requests).toHaveLength(1)
  })

  test('delegated children inherit Plan and cannot raise it; later unattended turns keep the limit', async () => {
    const backend = holdingBackend('claude-code', 'permission-thread')
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { plane.shutdown(); backend.releaseAll() })
    const parent = ctx('permission-parent')
    parent.session.permissionMode = 'plan'
    await plane.dispatch.submitPrompt(parent, { prompt: 'Plan the work' }, { clientId: 'owner', actor: HOST_ACTOR })
    await Promise.resolve()
    const order = { provider: 'claude-code' as const, prompt: 'Inspect the parser', modelId: 'claude-sonnet-5',
      reasoningEffort: 'medium' as const, contextWindow: 1_000_000, cwd: projectDir,
      delegation: { parentSessionId: 'permission-parent', messageId: 'delegate', intent: 'delegate' as const, createdAt: 1 } }
    await expect(plane.dispatch.createSession({ ...order, permissionMode: 'full-access' }, HOST_ACTOR)).rejects.toThrow('cannot change permissions')
    const child = await plane.dispatch.createSession(order, HOST_ACTOR)
    expect(backend.requests[1]?.permissionMode).toBe('plan')
    backend.releaseOne()
    backend.releaseOne()
    await Promise.resolve()
    await plane.dispatch.promptSession(child.sessionId, 'Inspect the next file', 'queue')
    expect(backend.requests[2]?.permissionMode).toBe('plan')
  })

  test('editing keeps references and files, rejects stale revisions, and never drains a busy turn', async () => {
    const backend = holdingBackend('claude-code', 'edit-thread')
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { plane.shutdown(); backend.releaseAll() })
    await plane.dispatch.submitPrompt(ctx('edit'), { prompt: 'start' }, { clientId: 'owner', actor: HOST_ACTOR })
    await Promise.resolve()
    await plane.dispatch.submitPrompt(ctx('edit', 'edit-thread-1'), {
      prompt: '[Attached file: /tmp/notes.md]\n\nReference context\n\nOld text', displayPrompt: 'Old text', delivery: 'queue',
      queueAttachmentContext: '[Attached file: /tmp/notes.md]',
      queueAttachments: [{ id: 'notes', type: 'file', name: 'notes.md', hostPath: '/tmp/notes.md' }],
    }, { clientId: 'owner', actor: HOST_ACTOR })
    const entry = plane.scheduler.sessionQueue(ctx('edit')).entries[0]!
    await plane.scheduler.sessionQueueChange(ctx('edit'), { kind: 'edit', queueId: entry.queueId, revision: entry.revision ?? 0, text: 'New text' }, HOST_ACTOR)
    await expect(plane.scheduler.sessionQueueChange(ctx('edit'), { kind: 'remove', queueId: entry.queueId, revision: entry.revision ?? 0 }, HOST_ACTOR)).rejects.toThrow('changed or started')
    const edited = plane.scheduler.sessionQueue(ctx('edit')).entries[0]!
    expect(edited.attachments?.[0]?.name).toBe('notes.md')
    expect(edited.modelConfig).toEqual(entry.modelConfig)
    expect(edited.provider).toBe(entry.provider)
    const screenshots = []
    for (let index = 0; index < 12; index++) {
      const name = `screenshot-${index}.png`
      const mimeType = 'image/png'
      const hostPath = await storeAttachmentBytes('edit', name, mimeType, Buffer.from(name))
      screenshots.push({ id: name, type: 'image' as const, name, mimeType, hostPath })
    }
    const attachments = [...(edited.attachments ?? []), ...screenshots]
    await plane.scheduler.sessionQueueChange(ctx('edit'), {
      kind: 'edit', queueId: edited.queueId, revision: edited.revision ?? 0, text: 'New text',
      attachments, attachmentContext: '[Attached file: /tmp/notes.md]',
      imageRefs: screenshots.map(({ mimeType, hostPath, name }) => ({ mimeType, hostPath, name })),
    }, HOST_ACTOR)
    expect(plane.scheduler.sessionQueue(ctx('edit')).entries[0]?.attachments).toEqual(attachments)
    await plane.scheduler.sessionQueueChange(ctx('edit'), { kind: 'resume' }, HOST_ACTOR)
    expect(backend.requests).toHaveLength(1)
    const started = backend.nextStart()
    backend.releaseOne()
    await started
    expect(backend.requests[1]?.prompt).toBe('[Attached file: /tmp/notes.md]\n\nReference context\n\nNew text')
    expect(backend.requests[1]?.imageAttachments).toEqual(screenshots.map(({ mimeType, name }) => ({
      mimeType, dataUrl: `data:${mimeType};base64,${Buffer.from(name).toString('base64')}`,
    })))
  })

  test('an edited prompt starts on its selected provider with its own options', async () => {
    const claude = holdingBackend('claude-code', 'edited-claude')
    const codex = holdingBackend('codex', 'edited-codex')
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', claude.value], ['codex', codex.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { plane.shutdown(); claude.releaseAll(); codex.releaseAll() })
    const sessionId = 'edited-model'
    await plane.dispatch.submitPrompt(ctx(sessionId), { prompt: 'first' }, { actor: HOST_ACTOR })
    const context = ctx(sessionId, 'edited-claude-1')
    for (const prompt of ['second', 'third']) {
      await plane.dispatch.submitPrompt(context, { prompt, delivery: 'queue' }, { actor: HOST_ACTOR })
    }
    const [entry, sibling] = plane.scheduler.sessionQueue(context).entries
    const selection = {
      provider: 'codex' as const,
      modelConfig: { modelId: 'gpt-6-astra', reasoningEffort: 'high' as const, contextWindow: 1_050_000, fastMode: true },
    }
    const edited = await plane.scheduler.sessionQueueChange(context, {
      kind: 'edit', queueId: entry!.queueId, revision: entry!.revision!, text: 'second', selection,
    }, HOST_ACTOR)
    expect(edited.entries[0]).toMatchObject(selection)
    expect(edited.entries[1]).toEqual(sibling)
    await expect(plane.scheduler.sessionQueueChange(context, {
      kind: 'edit', queueId: entry!.queueId, revision: entry!.revision!, text: 'stale', selection,
    }, HOST_ACTOR)).rejects.toThrow('changed or started')
    expect(codex.requests).toHaveLength(0)
    const started = codex.nextStart()
    claude.releaseOne()
    expect(await started).toMatchObject({ prompt: 'second', model: 'gpt-6-astra', reasoningEffort: 'high', fastMode: true })
  })

  test('provider switches and prompts run in delivery order without stopping the current work', async () => {
    const claude = holdingBackend('claude-code', 'switch-thread')
    const codex = holdingBackend('codex', 'switch-codex')
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', claude.value], ['codex', codex.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { plane.shutdown(); claude.releaseAll(); codex.releaseAll() })
    await plane.dispatch.submitPrompt(ctx('switch'), { prompt: 'first' }, { clientId: 'owner', actor: HOST_ACTOR })
    await Promise.resolve()
    await plane.scheduler.sessionQueueChange(ctx('switch', 'switch-thread-1'), { kind: 'switch', provider: 'codex', modelConfig: {
      modelId: 'gpt-6-astra', reasoningEffort: 'medium', contextWindow: 1_050_000, fastMode: false,
    } }, HOST_ACTOR)
    await plane.dispatch.submitPrompt(ctx('switch', 'switch-thread-1'), { prompt: 'second', delivery: 'queue' }, { clientId: 'owner', actor: HOST_ACTOR })
    await plane.scheduler.sessionQueueChange(ctx('switch', 'switch-thread-1'), { kind: 'switch', provider: 'claude-code', modelConfig: {
      modelId: 'claude-sonnet-5', reasoningEffort: 'medium', contextWindow: 1_000_000, fastMode: false,
    } }, HOST_ACTOR)
    await plane.dispatch.submitPrompt(ctx('switch', 'switch-thread-1'), { prompt: 'third', delivery: 'queue' }, { clientId: 'owner', actor: HOST_ACTOR })
    expect(plane.scheduler.sessionQueue(ctx('switch')).entries.map((item) => [item.kind, item.provider])).toEqual([
      ['provider_switch', 'codex'], ['prompt', 'codex'], ['provider_switch', 'claude-code'], ['prompt', 'claude-code'],
    ])
    expect(claude.requests).toHaveLength(1)
    expect(codex.requests).toHaveLength(0)
    const second = codex.nextStart()
    claude.releaseOne()
    await second
    expect(codex.requests[0]?.prompt).toBe('second')
    await Promise.resolve()
    const third = claude.nextStart()
    codex.releaseOne()
    await third
    expect(claude.requests[1]?.prompt).toBe('third')
  })
})

// plans/004-shared-host-collaboration.md D12: Stop ends the running turn and
// keeps every queued prompt, other people's included.
describe('stop keeps the queue', () => {
  test('Cara stopping Bob\'s turn names her and starts her queued prompt, on her seat', async () => {
    const backend = holdingBackend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    plane.useSeats({
      resolveForTurn: async (seat: { kind: string; userId?: { accountId: string } }) => ({ seat, provider: 'claude', home: `/seats/${seat.userId?.accountId ?? 'host'}` }),
    } as unknown as Parameters<typeof plane.useSeats>[0])
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const events: NormalizedEvent[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

    await plane.dispatch.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-bob', actor: actors.memberActor('bob', 'Bob') })
    await Promise.resolve()
    const queued = await plane.dispatch.submitPrompt(ctx('s1', 'thread-1'), { prompt: 'then deploy', delivery: 'queue' }, {
      clientId: 'c-cara', actor: actors.memberActor('cara', 'Cara'),
    })
    expect(queued.disposition).toBe('queued')

    // Cara stops Bob's turn (D2): the stop is her activity, inside the turn it
    // ended (plans/012 §5), so no reader is told they did it.
    const caraAuthor = actors.accountUser('cara', 'Cara')
    expect(plane.stopSession('s1', actors.memberActor('cara', 'Cara'))).toBe(true)
    const stoppedActivity = () => events.find((event): event is Extract<NormalizedEvent, { type: 'activity' }> => event.type === 'activity' && event.activity.kind === 'stopped')
    for (let i = 0; i < 20 && (backend.requests.length < 2 || !stoppedActivity()); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stoppedActivity()?.activity).toMatchObject({ kind: 'stopped', by: { kind: 'user', user: caraAuthor }, subject: { kind: 'session', id: 's1' } })
    expect(stoppedActivity()?.activity.turnId).toBeString()
    const interrupted = events.find((event) => event.type === 'status_change' && event.status === 'interrupted')
    expect(interrupted).not.toHaveProperty('by')

    expect(backend.requests.map((request) => request.prompt)).toEqual(['start', 'then deploy'])
    expect(backend.requests[1]?.seat?.seat).toEqual({ kind: 'user', userId: { kind: 'account', accountId: 'cara' }, name: 'Cara' })
    const dequeued = events.filter((event) => event.type === 'prompt_dequeued')
    expect(dequeued).toHaveLength(1)
  })
})

// plans/004-shared-host-collaboration.md F2, F4: a card says whose turn asks, and
// every client reads who decided a permission and how. A teammate learns who
// waits on a seat; the refused client has its own card.
describe('whose turn asks, and what was chosen', () => {
  test('a request raised in Bob\'s turn names Bob, and Cara\'s approval names her and the decision', async () => {
    const backend = holdingBackend()
    let answered: string | null = null
    backend.value.permissions.respondToPermission = (_questionId: string, optionId: string) => { answered = optionId; return true }
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const events: NormalizedEvent[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => { events.push(event) })

    await plane.dispatch.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-bob', actor: actors.memberActor('bob', 'Bob') })
    await Promise.resolve()
    const bob = actors.accountUser('bob', 'Bob')
    const options = [{ id: 'allow', label: 'Allow Once', kind: 'allow' }, { id: 'allow-session', label: 'Allow for Session', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }]
    backend.value.emit('normalized', 'thread-1', { type: 'permission_request', questionId: 'q1', toolName: 'Bash', options } satisfies NormalizedEvent)
    backend.value.emit('normalized', 'thread-1', { type: 'question_request', questionId: 'q2', questions: [] } satisfies NormalizedEvent)

    const asked = events.filter((event) => event.type === 'permission_request' || event.type === 'question_request')
    expect(asked.map((event) => 'turnAuthor' in event ? event.turnAuthor : undefined)).toEqual([bob, bob])

    const cara = actors.accountUser('cara', 'Cara')
    expect(plane.inputRequests.respondToPermission('s1', 'q1', 'allow-session', undefined, actors.memberActor('cara', 'Cara'))).toBe(true)
    expect(answered).toBe('allow-session')
    const resolved = events.find((event) => event.type === 'permission_resolved')
    expect(resolved).toEqual({ type: 'permission_resolved', questionId: 'q1', decision: 'approved_for_session' })
    // Who decided is one activity every client reads (plans/012 §5).
    const decided = () => events.find((event): event is Extract<NormalizedEvent, { type: 'activity' }> => event.type === 'activity')
    for (let i = 0; i < 20 && !decided(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(decided()?.activity).toMatchObject({ kind: 'permission_decided', questionId: 'q1', tool: 'Bash', decision: 'approved_for_session', by: { kind: 'user', user: cara } })
  })

  test('a link guest\'s request says it runs in Ask mode; the owner\'s does not', () => {
    // WHY: a guest's turn runs in Ask mode whatever the session's mode is
    // (host-sharing.md §4.1). Without the mark, an owner in full access sees an
    // approval and cannot tell why it asks.
    const guest = {
      principal: { kind: 'guest', guestId: 'g1', displayName: 'Gail', deviceId: 'g1' },
      user: { id: { kind: 'guest', guestId: 'g1' }, displayName: 'Gail' },
    }
    const runs = new Map([['s-guest', { actor: guest }], ['s-owner', { actor: actors.memberActor('bob', 'Bob') }]])
    // SAFETY: `stampTurnAuthor` reads only the running turn's actor.
    const requests = new inputRequestsModule.InputRequests({ activeRunRequests: runs } as never)
    const request = (): Extract<NormalizedEvent, { type: 'permission_request' }> => ({ type: 'permission_request', questionId: 'q', toolName: 'Bash', options: [] })
    const fromGuest = request()
    requests.stampTurnAuthor('s-guest', fromGuest)
    expect(fromGuest).toMatchObject({ guestTurn: true, turnAuthor: { displayName: 'Gail' } })
    const fromMember = request()
    requests.stampTurnAuthor('s-owner', fromMember)
    expect(fromMember.guestTurn).toBeUndefined()
  })

  test('the decision is read from the option\'s kind; an option the request did not offer names none', () => {
    const request = {
      type: 'permission_request' as const, questionId: 'q', toolName: 'Bash',
      options: [{ id: 'accept', label: 'Allow', kind: 'allow' }, { id: 'acceptForSession', label: 'Allow for session', kind: 'allow' }, { id: 'decline', label: 'Deny', kind: 'deny' }],
    }
    expect(inputRequestsModule.permissionDecisionFor(request, 'accept')).toBe('approved')
    expect(inputRequestsModule.permissionDecisionFor(request, 'acceptForSession')).toBe('approved_for_session')
    expect(inputRequestsModule.permissionDecisionFor(request, 'decline')).toBe('denied')
    expect(inputRequestsModule.permissionDecisionFor(request, 'nope')).toBeUndefined()
  })

  // WHY: the refused client shows the connect card; a row in the thread only
  // repeats it, and to the person refused it read as news about someone else.
  test('a refused seat records no activity in the thread', async () => {
    const { SeatRequiredError } = await import('@solus/server/execution/seats/seat-manager')
    const backend = holdingBackend()
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]))
    plane.on('error', () => {})
    plane.useSeats({
      resolveForTurn: async () => { throw new SeatRequiredError('claude-code', 'none') },
    } as unknown as Parameters<typeof plane.useSeats>[0])
    cleanups.push(() => { backend.releaseAll(); plane.shutdown() })
    const sent: NormalizedEvent[] = []
    plane.on('event', (_sessionId: string, event: NormalizedEvent) => { sent.push(event) })

    await expect(plane.dispatch.submitPrompt(ctx('s1'), { prompt: 'start' }, { clientId: 'c-dan', actor: actors.memberActor('dan', 'Dan') })).rejects.toBeInstanceOf(SeatRequiredError)
    expect(sent.filter((event) => event.type === 'activity')).toEqual([])
  })
})

describe('host restart continuation', () => {
  async function recoveryDirectory(): Promise<string> {
    const { resetMachineKindForTests } = await import('@solus/server/host/machine-kind')
    resetMachineKindForTests()
    const { setHostConfig } = await import('@solus/server/host/settings')
    setHostConfig({ continueSessionsAfterHostRestart: true })
    const root = mkdtempSync(join(tmpdir(), 'solus-restart-queue-'))
    recoveryRoots.push(root)
    return root
  }

  test('a direct run resumes its native thread and options; restored user prompts stay held', async () => {
    const queueDirectory = await recoveryDirectory()
    const original = holdingBackend('claude-code', 'restart-thread')
    const first = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', original.value]]), { queueDirectory })
    first.on('error', () => {})
    cleanups.push(() => { first.shutdown(); original.releaseAll() })
    const context = ctx('restart-source')
    context.session.permissionMode = 'plan'
    context.session.preferredModel = 'claude-sonnet-5'
    context.session.contextWindow = 1_000_000
    context.statusBar.fastMode = true
    await first.dispatch.submitPrompt(context, { prompt: 'Fix the parser' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    await first.dispatch.submitPrompt(ctx('restart-source', 'restart-thread-1'), { prompt: 'Later user work', delivery: 'queue' }, { actor: HOST_ACTOR })
    // New user work takes precedence over recovery; use another run to verify
    // direct continuation without changing that queued-work contract.
    const direct = ctx('restart-direct')
    direct.session.permissionMode = 'plan'
    direct.statusBar.fastMode = true
    await first.dispatch.submitPrompt(direct, { prompt: 'Inspect the serializer', clientPromptId: 'restart-original' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    first.shutdown()
    await Promise.resolve()
    const next = holdingBackend('claude-code', 'restart-new')
    const second = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', next.value]]), { queueDirectory })
    second.on('error', () => {})
    cleanups.push(() => { second.shutdown(); next.releaseAll() })
    const started = next.nextStart()
    await second.restarts.recoverSessionsAfterRestart()
    const request = await started
    expect(request.prompt).toContain('Continue where you left off')
    expect(request.prompt).not.toContain('Inspect the serializer')
    expect(next.requests).toHaveLength(1)
    expect(second.scheduler.sessionQueue(ctx('restart-source')).entries[0]?.held).toBe(true)
    expect(request.conversation).toEqual({ kind: 'resume', threadId: 'restart-thread-2' })
    expect(request.model).toBe('claude-sonnet-5')
    expect(request.permissionMode).toBe('plan')
    expect(request.fastMode).toBe(true)
    expect((await second.dispatch.submitPrompt(ctx('restart-direct'), {
      prompt: 'Inspect the serializer', clientPromptId: 'restart-original',
    }, { actor: HOST_ACTOR })).disposition).toBe('duplicate')
    expect(next.requests).toHaveLength(1)
    const store = new (await import('@solus/server/data/sessions/run-ledger')).RunLedger().activeRuns
    expect(store.get('restart-direct')?.input.agentSessionId).toBe('restart-new-1')
    next.releaseAll()
    await Promise.resolve()
  })

  test('explicit Stop leaves no continuation receipt', async () => {
    const queueDirectory = await recoveryDirectory()
    const backend = holdingBackend('claude-code', 'restart-stop')
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    runtime.on('error', () => {})
    cleanups.push(() => { runtime.shutdown(); backend.releaseAll() })
    await runtime.dispatch.submitPrompt(ctx('restart-stopped'), { prompt: 'Inspect the parser' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    expect(runtime.stopSession('restart-stopped', HOST_ACTOR)).toBe(true)
    const store = new (await import('@solus/server/data/sessions/run-ledger')).RunLedger().activeRuns
    expect(store.get('restart-stopped')).toBeUndefined()
    await runtime.restarts.recoverSessionsAfterRestart()
    expect(backend.requests).toHaveLength(1)
  })

  // A turn parked on a question waits for a person, not for the host. A
  // restart must not answer for them with "Continue where you left off".
  test('a run waiting for an answer is not continued; once answered it is', async () => {
    const queueDirectory = await recoveryDirectory()
    const { RunLedger } = await import('@solus/server/data/sessions/run-ledger')
    const backend = holdingBackend('claude-code', 'restart-question')
    const first = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    first.on('error', () => {})
    cleanups.push(() => { first.shutdown(); backend.releaseAll() })
    for (const sessionId of ['asks', 'answered']) {
      await first.dispatch.submitPrompt(ctx(sessionId), { prompt: 'Change the composer' }, { actor: HOST_ACTOR })
      await Promise.resolve()
    }
    for (const [threadId, questionId] of [['restart-question-1', 'q-asks'], ['restart-question-2', 'q-answered']]) {
      backend.value.emit('normalized', threadId, {
        type: 'question_request', questionId, questions: [{ question: 'Which composer?', header: 'Composer', multiSelect: false, options: [] }],
      } satisfies NormalizedEvent)
    }
    expect(new RunLedger().activeRuns.get('asks')?.state).toBe('awaiting_input')
    first.statuses.setStatus('answered', 'running')
    first.shutdown()
    await Promise.resolve()
    const nextBackend = holdingBackend('claude-code', 'restart-question-next')
    const next = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', nextBackend.value]]), { queueDirectory })
    next.on('error', () => {})
    cleanups.push(() => { next.shutdown(); nextBackend.releaseAll() })
    const started = nextBackend.nextStart()
    await next.restarts.recoverSessionsAfterRestart()
    expect((await started).conversation).toEqual({ kind: 'resume', threadId: 'restart-question-2' })
    expect(nextBackend.requests).toHaveLength(1)
    expect(new RunLedger().activeRuns.get('asks')).toBeUndefined()
    expect(next.scheduler.sessionQueue(ctx('asks')).entries).toHaveLength(0)
    nextBackend.releaseAll()
    await Promise.resolve()
  })

  test('an uncertain recovery delivery becomes held and is never sent automatically', async () => {
    const queueDirectory = await recoveryDirectory()
    const { RunLedger } = await import('@solus/server/data/sessions/run-ledger')
    const backend = holdingBackend('claude-code', 'restart-uncertain')
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    runtime.on('error', () => {})
    cleanups.push(() => { runtime.shutdown(); backend.releaseAll() })
    await runtime.dispatch.submitPrompt(ctx('uncertain'), { prompt: 'Change the parser' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    const store = new RunLedger().activeRuns
    const saved = store.get('uncertain')!
    runtime.shutdown()
    await Promise.resolve()
    store.save({ ...saved, state: 'delivering' })
    const next = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    next.on('error', () => {})
    cleanups.push(() => next.shutdown())
    await next.restarts.recoverSessionsAfterRestart()
    const entry = next.scheduler.sessionQueue(ctx('uncertain')).entries[0]!
    expect(entry.held).toBe(true)
    expect(entry.error).toContain('Check history')
    expect(backend.requests).toHaveLength(1)
    await next.restarts.recoverSessionsAfterRestart()
    expect(next.scheduler.sessionQueue(ctx('uncertain')).entries).toHaveLength(1)
  })

  /** A host that stops in the setup of a run, after its receipt and before its launch. */
  async function stopBeforeLaunch(queueDirectory: string, context: IpcContext, input: PromptOptions) {
    // The database is shared by this file; recovery reads every session's receipt.
    const { RunLedger } = await import('@solus/server/data/sessions/run-ledger')
    const store = new RunLedger().activeRuns
    for (const run of store.list()) store.remove(run.sessionId)
    const backend = holdingBackend('claude-code', 'restart-unstarted')
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    runtime.on('error', () => {})
    const saveRestartRun = runtime.restarts.saveRestartRun.bind(runtime.restarts)
    runtime.restarts.saveRestartRun = (...args) => {
      saveRestartRun(...args)
      runtime.shutdown()
    }
    await runtime.dispatch.submitPrompt(context, input, { actor: HOST_ACTOR }).catch(() => {})
    await Bun.sleep(0)
    expect(backend.requests).toHaveLength(0)
  }

  // WHY: nothing reached the provider, so "Continue where you left off" would
  // answer for a message it never read, and the message would be gone.
  test('a prompt that never reached its provider is sent after the restart, whole', async () => {
    const queueDirectory = await recoveryDirectory()
    const imageAttachments = [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }]
    await stopBeforeLaunch(queueDirectory, ctx('unstarted'), {
      prompt: 'Read notes.md and fix the parser', displayPrompt: 'Fix the parser', imageAttachments, clientPromptId: 'unstarted-prompt',
    })

    const next = holdingBackend('claude-code', 'restart-unstarted-next')
    const second = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', next.value]]), { queueDirectory })
    second.on('error', () => {})
    cleanups.push(() => { second.shutdown(); next.releaseAll() })
    const sent: NormalizedEvent[] = []
    second.on('event', (_sessionId: string, event: NormalizedEvent) => sent.push(event))
    const started = next.nextStart()
    await second.restarts.recoverSessionsAfterRestart()
    const request = await started
    expect(request.prompt).toBe('Read notes.md and fix the parser')
    expect(request.imageAttachments).toEqual(imageAttachments)
    expect(request.conversation).toEqual({ kind: 'start' })
    expect(next.requests).toHaveLength(1)
    expect(sent.find((event) => event.type === 'user_message')).toMatchObject({ text: 'Fix the parser', imageAttachments })
    // A client that sends the same prompt again does not send it twice.
    expect((await second.dispatch.submitPrompt(ctx('unstarted'), { prompt: 'Read notes.md and fix the parser', clientPromptId: 'unstarted-prompt' }, { actor: HOST_ACTOR })).disposition).toBe('duplicate')
    expect(next.requests).toHaveLength(1)
  })

  test('a host that stops again while delivering an unstarted prompt holds it, never sends it', async () => {
    const queueDirectory = await recoveryDirectory()
    await stopBeforeLaunch(queueDirectory, ctx('unstarted-delivering'), { prompt: 'Fix the parser' })
    const { RunLedger } = await import('@solus/server/data/sessions/run-ledger')
    const store = new RunLedger().activeRuns
    store.save({ ...store.get('unstarted-delivering')!, state: 'delivering' })

    const next = holdingBackend('claude-code', 'restart-unstarted-held')
    const second = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', next.value]]), { queueDirectory })
    second.on('error', () => {})
    cleanups.push(() => { second.shutdown(); next.releaseAll() })
    await second.restarts.recoverSessionsAfterRestart()
    expect(next.requests).toHaveLength(0)
    expect(second.scheduler.sessionQueue(ctx('unstarted-delivering')).entries[0]).toMatchObject({ text: 'Fix the parser', held: true })
  })

  // WHY: a steered provider has the prompt. Its receipt must not read like a run
  // that never launched, or recovery would send the prompt a second time.
  test('a steered prompt is never sent again after a restart', async () => {
    const queueDirectory = await recoveryDirectory()
    const backend = holdingBackend('claude-code', 'restart-steer')
    const value = backend.value as AgentBackend & { steerSession: AgentBackend['steerSession'] }
    value.steerSession = async (threadId) => value.getSessionHandle(threadId) ?? null
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', value]]), { queueDirectory })
    runtime.on('error', () => {})
    cleanups.push(() => { runtime.shutdown(); backend.releaseAll() })
    await runtime.dispatch.submitPrompt(ctx('steered'), { prompt: 'Fix the parser' }, { actor: HOST_ACTOR })
    const { input } = runtime.restarts.restartRuns!.get('steered')!
    await runtime.launcher.steerActiveTurn({
      sessionId: 'steered', runId: 'run-2', input, tools: [], actor: HOST_ACTOR, target: { kind: 'session', sessionId: 'steered' },
      options: { prompt: 'Also fix the lexer' },
    }, 'restart-steer-1', runtime.activeSessions.get('steered')!)
    const saved = runtime.restarts.restartRuns!.get('steered')!
    expect(saved.prompt).toBe('Also fix the lexer')
    expect(saved.state).toBe('running')
    expect(saved.options).toBeUndefined()
  })

  // WHY: its sender hears at restart that the run was interrupted, and can send again.
  test('a prompt another session waits on is not kept to send again', async () => {
    const queueDirectory = await recoveryDirectory()
    const backend = holdingBackend('claude-code', 'restart-exchange')
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    runtime.on('error', () => {})
    cleanups.push(() => { runtime.shutdown(); backend.releaseAll() })
    await runtime.dispatch.submitPrompt(ctx('exchange-run'), { prompt: 'Fix the parser' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    const { input } = runtime.restarts.restartRuns!.get('exchange-run')!
    runtime.restarts.saveRestartRun({
      sessionId: 'exchange-run', runId: 'run-2', input, tools: [], actor: HOST_ACTOR, target: { kind: 'session', sessionId: 'exchange-run' },
      options: { prompt: 'Report back' }, exchangeIds: ['exchange-1'],
    }, false)
    expect(runtime.restarts.restartRuns!.get('exchange-run')?.options).toBeUndefined()
  })

  test('a cloud machine discards recovery intent without launching a provider', async () => {
    const queueDirectory = await recoveryDirectory()
    const { RunLedger } = await import('@solus/server/data/sessions/run-ledger')
    const { adoptRegistration, resetMachineKindForTests } = await import('@solus/server/host/machine-kind')
    const backend = holdingBackend('claude-code', 'restart-cloud')
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    runtime.on('error', () => {})
    cleanups.push(() => { runtime.shutdown(); backend.releaseAll(); resetMachineKindForTests() })
    await runtime.dispatch.submitPrompt(ctx('cloud-disabled'), { prompt: 'Inspect the parser' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    runtime.shutdown()
    await Promise.resolve()
    adoptRegistration({ organizationId: 'organization' })
    const next = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    next.on('error', () => {})
    cleanups.push(() => next.shutdown())
    await next.restarts.recoverSessionsAfterRestart()
    expect(new RunLedger().activeRuns.get('cloud-disabled')).toBeUndefined()
    expect(backend.requests).toHaveLength(1)
    expect(next.scheduler.sessionQueue(ctx('cloud-disabled')).entries).toHaveLength(0)
  })

  test('background recovery tells the agent what stopped without copying tool inputs', async () => {
    const queueDirectory = await recoveryDirectory()
    const backend = holdingBackend('claude-code', 'restart-background')
    const first = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    first.on('error', () => {})
    cleanups.push(() => { first.shutdown(); backend.releaseAll() })
    await first.dispatch.submitPrompt(ctx('background-restart'), { prompt: 'Inspect the parser' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    backend.value.emit('normalized', 'restart-background-1', {
      type: 'tool_call', toolName: 'Task', toolId: 'child', index: 0, isSubagent: true, subagentType: 'Explore', toolInput: 'private runtime input',
    } satisfies NormalizedEvent)
    first.shutdown()
    await Promise.resolve()
    const nextBackend = holdingBackend('claude-code', 'restart-background-next')
    const next = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', nextBackend.value]]), { queueDirectory })
    next.on('error', () => {})
    cleanups.push(() => { next.shutdown(); nextBackend.releaseAll() })
    const started = nextBackend.nextStart()
    await next.restarts.recoverSessionsAfterRestart()
    const request = await started
    expect(request.prompt).toContain('Child agent (Explore)')
    expect(request.prompt).not.toContain('private runtime input')
    nextBackend.releaseAll()
    await Promise.resolve()
  })


  test('tool tracking writes only changed recovery state and ignores duplicate completion', async () => {
    const queueDirectory = await recoveryDirectory()
    const backend = holdingBackend('claude-code', 'restart-efficient')
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    runtime.on('error', () => {})
    cleanups.push(() => { runtime.shutdown(); backend.releaseAll() })
    const prepare = spyOn(db.getDb(), 'prepare')
    const restartStatements = () => prepare.mock.calls.filter(([sql]) => /\b(INTO|FROM|UPDATE) runs\b/.test(sql)).map(([sql]) => sql)
    try {
      await runtime.dispatch.submitPrompt(ctx('efficient-tools'), { prompt: 'Inspect the parser' }, { actor: HOST_ACTOR })
      await Promise.resolve()
      // Starting, resolved launch input, and the new native thread: init must
      // not write the native thread a second time after the handle names it.
      expect(restartStatements()).toHaveLength(3)
      prepare.mockClear()
      const call = { type: 'tool_call', toolName: 'Bash', toolId: 'command', index: 0 } satisfies NormalizedEvent
      backend.value.emit('normalized', 'restart-efficient-1', call)
      backend.value.emit('normalized', 'restart-efficient-1', call)
      expect(restartStatements()).toHaveLength(1)
      backend.value.emit('normalized', 'restart-efficient-1', { type: 'tool_result', toolUseId: 'command', content: 'Done' } satisfies NormalizedEvent)
      backend.value.emit('normalized', 'restart-efficient-1', { type: 'tool_call_complete', toolId: 'command', completedAtMs: 1 } satisfies NormalizedEvent)
      expect(restartStatements()).toHaveLength(2)
      expect(restartStatements().every((sql) => sql.startsWith('INSERT'))).toBe(true)
      prepare.mockClear()
      const settled = new Promise<void>((resolve) => {
        runtime.on('event', (_sessionId: string, event: NormalizedEvent) => {
          if (event.type === 'turn_settled') resolve()
        })
      })
      backend.releaseAll()
      await settled
      expect(restartStatements()).toHaveLength(1)
      expect(restartStatements()[0]).toStartWith('DELETE')
      const { RunLedger } = await import('@solus/server/data/sessions/run-ledger')
      expect(new RunLedger().activeRuns.get('efficient-tools')).toBeUndefined()
    } finally {
      prepare.mockRestore()
    }
  })

  test('disabled recovery adds no receipt SQL to prompt launch, tools or completion', async () => {
    const queueDirectory = await recoveryDirectory()
    const { setHostConfig } = await import('@solus/server/host/settings')
    setHostConfig({ continueSessionsAfterHostRestart: false })
    const backend = holdingBackend('claude-code', 'restart-disabled')
    const runtime = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    runtime.on('error', () => {})
    cleanups.push(() => { runtime.shutdown(); backend.releaseAll() })
    const prepare = spyOn(db.getDb(), 'prepare')
    try {
      await runtime.dispatch.submitPrompt(ctx('disabled-recovery'), { prompt: 'Inspect the parser' }, { actor: HOST_ACTOR })
      await Promise.resolve()
      backend.value.emit('normalized', 'restart-disabled-1', { type: 'tool_call', toolName: 'Bash', toolId: 'command', index: 0 } satisfies NormalizedEvent)
      backend.releaseAll()
      await Promise.resolve()
      expect(prepare.mock.calls.filter(([sql]) => /\b(INTO|FROM|UPDATE) runs\b/.test(sql))).toEqual([])
    } finally {
      prepare.mockRestore()
    }
  })

  test('Codex resumes its native conversation with the saved model and effort', async () => {
    const queueDirectory = await recoveryDirectory()
    const original = holdingBackend('codex', 'restart-codex')
    const first = new sessionRuntimeModule.SessionRuntime(new Map([['codex', original.value]]), { queueDirectory })
    first.on('error', () => {})
    cleanups.push(() => { first.shutdown(); original.releaseAll() })
    const context = ctx('restart-codex-root')
    context.session.provider = 'codex'
    context.session.preferredModel = 'gpt-6-astra'
    context.statusBar.model = 'gpt-6-astra'
    context.statusBar.reasoningEffort = 'high'
    await first.dispatch.submitPrompt(context, { prompt: 'Inspect the parser' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    first.shutdown()
    await Promise.resolve()
    const backend = holdingBackend('codex', 'restart-codex-next')
    const next = new sessionRuntimeModule.SessionRuntime(new Map([['codex', backend.value]]), { queueDirectory })
    next.on('error', () => {})
    cleanups.push(() => { next.shutdown(); backend.releaseAll() })
    const started = backend.nextStart()
    await next.restarts.recoverSessionsAfterRestart()
    const request = await started
    expect(request.conversation).toEqual({ kind: 'resume', threadId: 'restart-codex-1' })
    expect(request.model).toBe('gpt-6-astra')
    expect(request.reasoningEffort).toBe('high')
    backend.releaseAll()
    await Promise.resolve()
  })


  test('a failed native resume stays held with its error for manual review', async () => {
    const queueDirectory = await recoveryDirectory()
    const original = holdingBackend('claude-code', 'restart-failed')
    const first = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', original.value]]), { queueDirectory })
    first.on('error', () => {})
    cleanups.push(() => { first.shutdown(); original.releaseAll() })
    await first.dispatch.submitPrompt(ctx('restart-failure'), { prompt: 'Inspect the parser' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    first.shutdown()
    await Promise.resolve()
    const backend = holdingBackend('claude-code', 'restart-failed-next')
    backend.value.startRun = () => { throw new Error('Native conversation unavailable') }
    const next = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', backend.value]]), { queueDirectory })
    next.on('error', () => {})
    cleanups.push(() => next.shutdown())
    const held = new Promise<QueuedPromptSnapshot>((resolve) => {
      next.on('event', (_sessionId: string, event: NormalizedEvent) => {
        if (event.type === 'session_queue') {
          const entry = event.entries.find((item) => item.held && item.error?.includes('Native conversation unavailable'))
          if (entry) resolve(entry)
        }
      })
    })
    await next.restarts.recoverSessionsAfterRestart()
    expect((await held).error).toContain('Native conversation unavailable')
    expect(next.scheduler.sessionQueue(ctx('restart-failure')).held).toBe(true)
    await next.restarts.recoverSessionsAfterRestart()
    expect(next.scheduler.sessionQueue(ctx('restart-failure')).entries).toHaveLength(1)
  })

})

// WHY: a turn blocked on a card cannot take a steer. A person who writes instead
// of answering ("can we get it from wrangler?") must reach the agent now, not
// queue behind a card that no one will answer. The message declines each card
// that the composer does not take as its answer; an explicit queue keeps them all.
describe('a message sent while a card is open', () => {
  /** A Claude turn that is running on a backend that can steer, with what each card was answered. */
  async function runningTurn(sessionId: string) {
    const backend = holdingBackend('claude-code', sessionId)
    const value = backend.value as AgentBackend & { steerSession: AgentBackend['steerSession'] }
    value.steerSession = async (threadId) => value.getSessionHandle(threadId) ?? null
    // As a real backend does, the handle names its session, so the provider's init binds the turn.
    const startRun = value.startRun.bind(value)
    value.startRun = (request: AgentRunRequest, state?: AgentRunSessionState) => Object.assign(startRun(request), { sessionId: state?.sessionId })
    const chosen: string[] = []
    const answered: Array<Record<string, string>> = []
    value.permissions.respondToPermission = (_questionId: string, optionId: string) => { chosen.push(optionId); return true }
    value.permissions.respondToQuestion = (_questionId: string, answers: Record<string, string>) => { answered.push(answers); return true }
    const plane = new sessionRuntimeModule.SessionRuntime(new Map([['claude-code', value]]))
    plane.on('error', () => {})
    cleanups.push(() => { plane.shutdown(); backend.releaseAll() })
    await plane.dispatch.submitPrompt(ctx(sessionId), { prompt: 'Deploy it' }, { actor: HOST_ACTOR })
    await Promise.resolve()
    const threadId = `${sessionId}-1`
    const emit = (event: NormalizedEvent) => { value.emit('normalized', threadId, event) }
    const send = (options: PromptOptions) => plane.dispatch.submitPrompt(ctx(sessionId, threadId), options, { actor: HOST_ACTOR })
    return { plane, emit, send, chosen, answered, status: () => plane.activeSessions.get(sessionId)?.status }
  }

  const permission = (questionId: string, toolName = 'Bash'): NormalizedEvent => ({
    type: 'permission_request', questionId, toolName,
    options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }],
  })

  test('a sent message declines every secret on a secret card and steers the turn', async () => {
    const { requestSecrets } = await import('@solus/server/execution/sessions/secret-requests')
    const turn = await runningTurn('secret-steer')
    const outcome = requestSecrets({
      provider: 'claude-code', cwd: projectDir, sessionId: () => 'secret-steer', abortSignal: new AbortController().signal,
      parentToolUseId: () => undefined, emit: turn.emit,
    }, [{ name: 'BETTER_AUTH_SECRET', reason: 'To sign grants.' }, { name: 'Cloudflare token', reason: 'For wrangler.' }])
    expect(turn.status()).toBe('awaiting_input')
    expect((await turn.send({ prompt: 'Can we not get it from wrangler?' })).disposition).toBe('steered')
    expect(await outcome).toEqual({ secrets: [
      { name: 'BETTER_AUTH_SECRET', status: 'declined' },
      { name: 'Cloudflare token', status: 'declined' },
    ] })
  })

  test('a permission, an Add machine card, and an MCP elicitation are declined; the message steers', async () => {
    const turn = await runningTurn('cards-steer')
    turn.emit(permission('q-bash'))
    let addMachine: Record<string, string> | null = null
    inputRequestsModule.answerToolQuestionWith('q-host', (answers) => { addMachine = answers })
    turn.emit({ type: 'question_request', questionId: 'q-host', kind: 'host-link', hostLink: { reason: 'To run tests on Windows.' },
      questions: [{ header: 'Add a machine', question: 'To run tests on Windows.', options: [], multiSelect: false }] })
    turn.emit({ type: 'question_request', questionId: 'q-mcp', kind: 'mcp_form',
      questions: [{ id: 'name', question: 'Name', options: [], multiSelect: false }] })
    expect(turn.status()).toBe('awaiting_input')

    expect((await turn.send({ prompt: 'Use the staging database instead' })).disposition).toBe('steered')
    expect(turn.chosen).toEqual(['deny'])
    expect(addMachine).toEqual({ status: 'declined' })
    expect(turn.answered).toEqual([{ __action: 'decline' }])
    expect(turn.status()).toBe('running')
  })

  test('a queued message, or one Solus sends, leaves the cards open; a plan and a question stay for the composer', async () => {
    const turn = await runningTurn('cards-kept')
    turn.emit(permission('q-bash'))
    expect((await turn.send({ prompt: 'After that, tag the release', delivery: 'queue' })).disposition).toBe('queued')
    await turn.send({ prompt: 'Report back', via: 'session-report' })
    expect(turn.chosen).toEqual([])

    // The composer sends text as a plan's revision or a question's answer, so the host leaves them.
    const other = await runningTurn('plan-kept')
    other.emit(permission('q-plan', 'ExitPlanMode'))
    other.emit({ type: 'question_request', questionId: 'q-ask', questions: [{ question: 'Which database?', options: [], multiSelect: false }] })
    expect((await other.send({ prompt: 'Something else' })).disposition).toBe('queued')
    expect(other.chosen).toEqual([])
    expect(other.answered).toEqual([])
    expect(other.status()).toBe('awaiting_input')
  })
})
