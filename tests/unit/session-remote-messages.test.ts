import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostApi } from '@solus/client-core/host-api'
import type { HeadlessPromptRequest, HeadlessSessionRequest, IpcContext, NormalizedEvent, PromptImageRef, SessionMeta, WireNormalizedEvent } from '@solus/contracts/types'
import type { AttachmentUploadRequest } from '@solus/contracts/rpc'
import type { Codebase } from '@solus/contracts/codebases'
import type { RemoteHost } from '@solus/server/execution/orchestration/remote-hosts'
import type { OrchestratedRuntime, RemoteTarget } from '@solus/server/execution/orchestration/session-orchestrator'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: an agent on one host works with a session it started on another the
// way it works with a local one (docs/session-orchestration.md). Its files
// must reach that host's attachment store, where the session there can read
// them, and the reply it hears must come from the turn that answers its own
// message — not from whatever that session was doing when the message came.

let SessionOrchestrator: typeof import('@solus/server/execution/orchestration/session-orchestrator')['SessionOrchestrator']
let writeAttachmentUpload: typeof import('@solus/server/transport/handlers/attachment-handlers')['writeAttachmentUpload']
let resolvePromptImages: typeof import('@solus/server/execution/agents/prompt-image-refs')['resolvePromptImages']

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
let root = ''
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'solus-remote-messages-'))
  process.env.SOLUS_DATA_DIR = join(root, 'host-a')
  ;({ SessionOrchestrator } = await import('@solus/server/execution/orchestration/session-orchestrator'))
  ;({ writeAttachmentUpload } = await import('@solus/server/transport/handlers/attachment-handlers'))
  ;({ resolvePromptImages } = await import('@solus/server/execution/agents/prompt-image-refs'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** Host B: it stores uploads with the real upload code, in its own store. */
function hostB() {
  const store = join(root, 'host-b-attachments')
  const events = new HostEventSubscriber()
  const started: HeadlessSessionRequest[] = []
  const prompted: HeadlessPromptRequest[] = []
  const treeReads: string[] = []
  let answer: { disposition: 'started' | 'steered' | 'queued'; queueId?: string } = { disposition: 'started' }
  const api = {
    watchSession: async () => ({}),
    unwatchSession: async () => {},
    attachUpload: (ctx: IpcContext, request: AttachmentUploadRequest) => writeAttachmentUpload(ctx, request, { attachmentsDir: store }),
    createHeadlessSession: async (request: HeadlessSessionRequest) => { started.push(request); return { sessionId: request.sessionId!, agentSessionId: 'thread' } },
    promptHeadlessSession: async (request: HeadlessPromptRequest) => { prompted.push(request); return answer },
    sessionTree: async (sessionId: string) => { treeReads.push(sessionId); return { nodes: [] } },
  }
  const host: RemoteHost = {
    hostId: 'host-b', installationId: 'install-b', label: 'Host B',
    // SAFETY: the orchestrator calls only the methods above on host B.
    api: api as unknown as HostApi,
    events,
    onReconnected: () => () => {},
    call: (_what, request) => request(),
  }
  const emit = (sessionId: string, event: WireNormalizedEvent) =>
    events.receive({ type: 'session.eventReceived', payload: { sessionId, event }, occurredAt: Date.now() })
  return { host, store, started, prompted, treeReads, emit, answer: (next: typeof answer) => { answer = next } }
}

/** The orchestrator, and a wait for the work it runs in the background: a
 *  session's startup, and a settled exchange's report. */
function orchestrator() {
  const updates: NormalizedEvent[] = []
  const work: Promise<unknown>[] = []
  const prompted: Array<{ prompt: string; imageAttachmentRefs?: PromptImageRef[] }> = []
  const runtime: OrchestratedRuntime = {
    activeExchangeIdsFor: () => [], queuedExchanges: () => [],
    sessionMeta: (sessionId) => sessionId === 'local-peer' ? { sessionId, provider: 'codex' } as SessionMeta : null,
    createSession: async () => { throw new Error('The session runs on host B') },
    promptSession: async (_id, prompt, _delivery, order) => {
      prompted.push(order.imageAttachmentRefs ? { prompt, imageAttachmentRefs: order.imageAttachmentRefs } : { prompt })
      return { disposition: 'started' }
    },
    stopSession: () => false, respondToPermission: () => false,
    pendingInputEvents: () => [], replaceQueuedPrompt: () => false,
    hasQueuedPrompt: () => false, cancelQueuedPrompt: () => false,
    turnEnding: async () => ({}), taskIdFor: async () => undefined,
    turnOrganization: async (sessionId) => sessionId === 'org-parent' ? 'org-a' : undefined,
    codebase: async (codebaseId) => codebaseId === SHOP.id ? SHOP : null,
    emit: (_id, event) => { updates.push(event) }, invalidatePlanCaches: () => {},
    recordActivity: async () => { throw new Error('No person acted in this test') },
    trackWork: (promise) => { work.push(promise); return promise },
    repliesEnded: () => {},
    delegatedRequestChanged: () => {},
  }
  const orchestration = new SessionOrchestrator(runtime, { findPullRequest: async () => null })
  const settled = async () => {
    await Promise.allSettled(work)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return Object.assign(orchestration, { settled, prompted })
}

const ORDER = { provider: 'codex' as const, modelId: 'model-on-b', reasoningEffort: 'medium' as const, contextWindow: null, cwd: '~/app', taskId: null, codebaseId: null }

/** The codebase of the sender: one root on each host. */
const SHOP: Codebase = {
  id: 'codebase-shop', name: 'shop', updatedAt: 2_000, deletedAt: null,
  roots: [{ installationId: 'install-a', path: '/Users/me/shop', name: '' }, { installationId: 'install-b', path: '/srv/infra', name: 'infra' }],
}

describe('files sent with a message', () => {
  test('go to this host\'s attachment store as a copy taken when the message was sent', async () => {
    // WHY: a session on this host reads the file as it was when it was sent,
    // even after the sender changes it, and its run accepts the image only from
    // the attachment store.
    const source = join(root, 'local-source')
    mkdirSync(source)
    writeFileSync(join(source, 'shot.png'), ONE_PIXEL_PNG)
    writeFileSync(join(source, 'log.txt'), 'first')
    const orchestration = orchestrator()
    await orchestration.send('parent', 'local-peer', { prompt: 'Look.', delivery: 'queue', notify: false, attachments: [join(source, 'shot.png'), join(source, 'log.txt')] })
    writeFileSync(join(source, 'log.txt'), 'changed')

    const { prompt, imageAttachmentRefs } = orchestration.prompted[0]!
    const [, filePath] = /^\[Attached file: (.+)\]\n\nLook\.$/.exec(prompt) ?? []
    expect(readFileSync(filePath!, 'utf8')).toBe('first')
    expect(await resolvePromptImages({ imageAttachmentRefs })).toEqual([
      { mimeType: 'image/png', dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}` },
    ])
  })
})

describe('messages to a session on another host', () => {
  test('start_sessions uploads its files to that host and names them by their paths there', async () => {
    const b = hostB()
    const target: RemoteTarget = { host: b.host, origin: { kind: 'session', hostLabel: 'Host A', sessionId: 'parent' } }
    const source = join(root, 'source')
    rmSync(source, { recursive: true, force: true })
    mkdirSync(source)
    writeFileSync(join(source, 'shot.png'), ONE_PIXEL_PNG)
    writeFileSync(join(source, 'log.txt'), 'log')
    const attachments = [join(source, 'shot.png'), join(source, 'log.txt')]

    const orchestration = orchestrator()
    await orchestration.spawn('parent', { ...ORDER, prompt: 'Read these.', attachments }, true, 0, undefined, target)
    await orchestration.settled()

    const request = b.started[0]!
    const [, filePath] = /^\[Attached file: (.+)\]\n\nRead these\.$/.exec(request.prompt) ?? []
    expect(filePath!.startsWith(b.store)).toBe(true)
    // Host B's run reads the image only from its own store: this proves it can.
    expect(await resolvePromptImages({ imageAttachmentRefs: request.imageAttachmentRefs }, b.store)).toEqual([
      { mimeType: 'image/png', dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}` },
    ])
  })

  test('start_sessions sends the record of the sender\'s codebase, so host B can find the folders of the child', async () => {
    // WHY: docs/plans/codebases.md §6. Host B has no copy of a codebase that a
    // person made on host A. Without the record, the child there has only its
    // working directory and does not know the other folders of the work.
    const b = hostB()
    const target: RemoteTarget = { host: b.host, origin: { kind: 'session', hostLabel: 'Host A', sessionId: 'parent' } }
    const orchestration = orchestrator()

    await orchestration.spawn('parent', { ...ORDER, prompt: 'Change the infrastructure.', codebaseId: SHOP.id }, true, 0, undefined, target)
    await orchestration.spawn('parent', { ...ORDER, prompt: 'No codebase.' }, true, 0, undefined, target)
    await orchestration.settled()

    expect(b.started.map((request) => request.codebase)).toEqual([SHOP, undefined])
  })

  test('start_sessions names the parent\'s organization, so host B admits the child as a prompt in it', async () => {
    // WHY: on a host attached for organization work a new root without an
    // organization is refused, and a Local parent's child must not become organization work.
    const b = hostB()
    const orchestration = orchestrator()
    await orchestration.spawn('org-parent', { ...ORDER, prompt: 'Org work.' }, true, 0, undefined, { host: b.host, origin: { kind: 'session', hostLabel: 'Host A', sessionId: 'org-parent' } })
    await orchestration.spawn('parent', { ...ORDER, prompt: 'Local work.' }, true, 0, undefined, { host: b.host, origin: { kind: 'session', hostLabel: 'Host A', sessionId: 'parent' } })
    await orchestration.settled()
    expect(b.started.map((request) => [request.prompt, request.organizationId])).toEqual([['Org work.', 'org-a'], ['Local work.', undefined]])
  })

  test('send_session hears the turn that answers its message, not the turn in progress', async () => {
    const b = hostB()
    const target: RemoteTarget = { host: b.host, origin: { kind: 'session', hostLabel: 'Host A', sessionId: 'parent' } }
    const orchestration = orchestrator()
    const child = await orchestration.spawn('parent', { ...ORDER, prompt: 'Start.' }, true, 0, undefined, target)
    await orchestration.settled()
    b.emit(child.sessionId, { type: 'turn_settled', turnId: 't0', outcome: 'completed', settledAt: 1 })

    b.answer({ disposition: 'queued', queueId: 'queue-1' })
    const sent = await orchestration.send('parent', child.sessionId, { prompt: 'More work.', delivery: 'queue', notify: true }, target)
    expect(sent.disposition).toBe('queued')
    expect(b.prompted[0]).toMatchObject({ sessionId: child.sessionId, prompt: 'More work.', delivery: 'queue', promptId: sent.exchangeId })

    // The turn that was running when the message came ends first.
    b.emit(child.sessionId, { type: 'task_complete', result: 'Old work done.', costUsd: 0, durationMs: 1, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0 }, sessionId: 'thread' } as WireNormalizedEvent)
    b.emit(child.sessionId, { type: 'turn_settled', turnId: 't1', outcome: 'completed', settledAt: 2 })
    await orchestration.settled()
    expect(orchestration.readExchange('parent', sent.exchangeId)?.state).not.toBe('settled')

    b.emit(child.sessionId, { type: 'prompt_dequeued', queueId: 'queue-1' })
    b.emit(child.sessionId, { type: 'user_message', text: 'More work.', clientPromptId: sent.exchangeId })
    b.emit(child.sessionId, { type: 'task_complete', result: 'More work done.', costUsd: 0, durationMs: 1, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0 }, sessionId: 'thread' } as WireNormalizedEvent)
    b.emit(child.sessionId, { type: 'turn_settled', turnId: 't2', outcome: 'completed', settledAt: 3 })
    await orchestration.settled()
    const exchange = orchestration.readExchange('parent', sent.exchangeId)
    expect(exchange?.state).toBe('settled')
    expect(exchange?.report?.reply).toBe('More work done.')
  })

  test('send_session reaches only a session this sender started on that host', async () => {
    const b = hostB()
    const target: RemoteTarget = { host: b.host, origin: { kind: 'session', hostLabel: 'Host A', sessionId: 'parent' } }
    await expect(orchestrator().send('parent', 'someone-elses', { prompt: 'Hi.', delivery: 'queue', notify: true }, target))
      .rejects.toThrow('was not started on Host B by this session')
    expect(b.prompted).toEqual([])
  })
})

describe('the tree of a session started on another host', () => {
  test('keeps a copy of an independent session under its sender, as it does a delegated one', async () => {
    // WHY: an independent session is still its sender's child. The sender's
    // host lists it under the sender only from the copy it keeps.
    const b = hostB()
    const target: RemoteTarget = { host: b.host, origin: { kind: 'session', hostLabel: 'Host A', sessionId: 'parent' } }
    const orchestration = orchestrator()
    const delegated = await orchestration.spawn('parent', { ...ORDER, prompt: 'Delegated part.' }, true, 0, undefined, target)
    const independent = await orchestration.spawn('parent', { ...ORDER, prompt: 'Independent part.', independent: true }, false, 0, undefined, target)
    await orchestration.settled()
    expect(b.treeReads).toContain(delegated.sessionId)
    expect(b.treeReads).toContain(independent.sessionId)
  })
})

describe('work an outside app starts on another host (plans/035 §0.6)', () => {
  test('names no session there, reports to nobody, and only that app reads or messages it', async () => {
    // WHY: the app has no session here. Host B records the person who started the
    // work, as this host does for an app's work here. The result waits in the
    // app's exchange, keyed by its grant: another app or a session cannot read it.
    const APP_A = 'client:grant-a'
    const b = hostB()
    const orchestration = orchestrator()
    const child = await orchestration.spawn(APP_A, { ...ORDER, prompt: 'Run the suite.' }, false, 0, undefined, { host: b.host })
    await orchestration.settled()
    expect(b.started[0]?.startedBy).toBeUndefined()
    expect(b.started[0]?.organizationId).toBeUndefined()

    b.emit(child.sessionId, { type: 'task_complete', result: 'Suite passes.', costUsd: 0, durationMs: 1, numTurns: 1, usage: { inputTokens: 0, outputTokens: 0 }, sessionId: 'thread' } as WireNormalizedEvent)
    b.emit(child.sessionId, { type: 'turn_settled', turnId: 't1', outcome: 'completed', settledAt: 1 })
    await orchestration.settled()

    expect(orchestration.readExchange(APP_A, child.exchangeId)?.report?.reply).toBe('Suite passes.')
    expect(orchestration.readExchange('client:grant-b', child.exchangeId)).toBeUndefined()
    expect(orchestration.readExchange('parent', child.exchangeId)).toBeUndefined()
    expect(orchestration.remoteHostOf(APP_A, child.sessionId)).toBe('host-b')
    expect(orchestration.remoteHostOf('client:grant-b', child.sessionId)).toBeUndefined()

    // Only the app that started it reaches it there again.
    await expect(orchestration.send('client:grant-b', child.sessionId, { prompt: 'Hi.', delivery: 'queue', notify: false }, { host: b.host }))
      .rejects.toThrow('was not started on Host B')
    const sent = await orchestration.send(APP_A, child.sessionId, { prompt: 'Once more.', delivery: 'queue', notify: false }, { host: b.host })
    expect(b.prompted.map((request) => request.prompt)).toEqual(['Once more.'])
    expect(orchestration.readExchange(APP_A, sent.exchangeId)?.targetSessionId).toBe(child.sessionId)
  })
})
