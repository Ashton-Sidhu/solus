import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { CodexAppServerClient } from '@solus/server/execution/agents/codex/codex-agent'
import type { TurnSeat } from '@solus/server/execution/seats/seat-manager'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WORKAROUND(openai/codex#54472): delete this file with the workaround.
//
// Every Codex home keeps its own projection of a thread's history, and an
// unloaded `thread/read` never projects the shared rollout first. A thread a
// member's seat ran reads empty through the host's app-server (seen on a
// managed host: a plain Codex session showed no messages, and a Claude -> Codex
// handoff showed nothing after the switch). So history is read through the
// app-server of the seat that last ran the thread.

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let CodexThreadWriters: typeof import('@solus/server/data/sessions/codex-thread-writers')['CodexThreadWriters']

const previousDataDir = process.env.SOLUS_DATA_DIR
const dataDir = mkdtempSync(join(tmpdir(), 'solus-codex-reader-'))
beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ CodexThreadWriters } = await import('@solus/server/data/sessions/codex-thread-writers'))
})

afterAll(async () => {
  const { closeDb } = await import('@solus/server/db')
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

/** One app-server: it answers history with its own name, so a test sees which home a read reached. */
function fakeAppServer(name: string) {
  const methods: string[] = []
  let markTurnStarted = () => {}
  const client = {
    methods,
    shutdown() {},
    nextTurn: () => new Promise<void>((resolve) => { markTurnStarted = resolve }),
    async request(method: string, params: { threadId?: string }) {
      methods.push(method)
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId ?? 'thread-1' }, model: 'gpt-5.6-sol' }
      if (method === 'turn/start') {
        markTurnStarted()
        return { turn: { id: `turn-${methods.length}` } }
      }
      if (method === 'thread/read') {
        return { thread: { turns: [{ id: 'turn-1', status: 'completed', itemsView: 'full', items: [
          { id: `message-${name}`, type: 'userMessage', content: [{ type: 'text', text: `read on ${name}` }] },
        ] }] } }
      }
      if (method === 'thread/items/list') return { data: [], nextCursor: null }
      if (method === 'thread/goal/get') return { goal: null }
      throw new Error(`Unexpected method: ${method}`)
    },
  }
  return client
}

function memberSeat(accountId: string): TurnSeat {
  return { seat: { kind: 'user', userId: { kind: 'account', accountId } }, provider: 'codex', home: `/seats/codex/${accountId}` }
}

function backendWith(host: ReturnType<typeof fakeAppServer>, running: Record<string, ReturnType<typeof fakeAppServer>>) {
  const backend = new CodexBackend()
  Reflect.set(backend, 'client', host)
  const pool = Reflect.get(backend, 'seatClients') as Map<string, { client: unknown; activeRuns: number; idleTimer: null }>
  for (const [accountId, client] of Object.entries(running)) pool.set(accountId, { client, activeRuns: 0, idleTimer: null })
  return backend
}

async function runTurn(backend: InstanceType<typeof CodexBackend>, server: ReturnType<typeof fakeAppServer>, threadId: string, seat?: TurnSeat) {
  const turnStarted = server.nextTurn()
  backend.startRun({
    provider: 'codex', prompt: 'Continue', cwd: '/tmp/project', tools: [], model: 'gpt-5.6-sol',
    permissionMode: 'full-access', persistence: 'session', service: 'sessions',
    conversation: { kind: 'resume', threadId }, seat,
  })
  await turnStarted
}

describe('Codex history reader (WORKAROUND openai/codex#54472)', () => {
  test('a thread is read through the seat that last ran it, and the reader follows a second member', async () => {
    const host = fakeAppServer('host')
    const ann = fakeAppServer('ann')
    const bob = fakeAppServer('bob')
    const backend = backendWith(host, { ann, bob })

    await runTurn(backend, ann, 'thread-shared', memberSeat('ann'))
    const page = await backend.loadSessionPage('thread-shared', undefined, 10)
    expect(page.messages.map((message) => message.content)).toEqual(['read on ann'])

    // Bob continues the thread, so only Bob's home holds its newest turn.
    await runTurn(backend, bob, 'thread-shared', memberSeat('bob'))
    const messages = await backend.loadSession('thread-shared')
    expect(messages.map((message) => message.content)).toEqual(['read on bob'])
    await backend.getThreadGoal('thread-shared')
    expect(bob.methods).toContain('thread/goal/get')

    expect(host.methods).toEqual([])
    backend.shutdown()
  })

  test('the host login\'s threads stay on the host\'s app-server', async () => {
    const host = fakeAppServer('host')
    const backend = backendWith(host, {})
    await runTurn(backend, host, 'thread-host')
    expect((await backend.loadSession('thread-host')).map((message) => message.content)).toEqual(['read on host'])
    backend.shutdown()
  })

  test('a full read starts a stopped seat\'s app-server; a picker preview never does', async () => {
    const host = fakeAppServer('host')
    const cara = fakeAppServer('cara')
    const backend = backendWith(host, {})
    new CodexThreadWriters().record('thread-cara', 'cara')
    const started: TurnSeat[] = []
    backend.useReaderSeats({ readerSeat: async (key) => memberSeat(key) })
    Reflect.set(backend, 'clientFor', (seat: TurnSeat) => {
      started.push(seat)
      return cara as unknown as CodexAppServerClient
    })

    const preview = await backend.loadSessionPreview('thread-cara')
    expect(preview.head.map((message) => message.content)).toEqual(['read on host'])
    expect(started).toEqual([])

    const messages = await backend.loadSession('thread-cara')
    expect(messages.map((message) => message.content)).toEqual(['read on cara'])
    expect(started.map((seat) => seat.home)).toEqual(['/seats/codex/cara'])
  })

  test('a thread with no record, or whose member is gone, reads on the host\'s app-server', async () => {
    const host = fakeAppServer('host')
    const backend = backendWith(host, {})
    backend.useReaderSeats({ readerSeat: async () => null })
    new CodexThreadWriters().record('thread-gone', 'dan')

    expect((await backend.loadSession('thread-unrecorded')).map((message) => message.content)).toEqual(['read on host'])
    expect((await backend.loadSession('thread-gone')).map((message) => message.content)).toEqual(['read on host'])
  })
})
