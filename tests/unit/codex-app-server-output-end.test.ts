import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventEmitter, once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import * as cliEnv from '@solus/server/cli-env'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type FakeChild = EventEmitter & {
  stdin: Writable
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  killed: boolean
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  signals: string[]
  kill(signal: string): void
}

/** An app-server that answers the startup handshake and nothing else. */
const children: FakeChild[] = []
mock.module('child_process', () => ({
  spawn() {
    const stdout = new PassThrough()
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          const request = JSON.parse(String(chunk)) as { id: number; method: string }
          if (request.method === 'initialize' || request.method === 'skills/extraRoots/set') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          }
          callback()
        },
      }),
      stdout, stderr: new PassThrough(), pid: 4242 + children.length, killed: false,
      exitCode: null, signalCode: null, signals: [],
      kill(signal: string) { child.signals.push(signal); child.killed = true },
    })
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child
  },
}))
spyOn(cliEnv, 'findOnPath').mockReturnValue('/fixture/codex')
spyOn(cliEnv, 'warmCliPath').mockResolvedValue('/fixture')

const { CodexAppServerClient } = await import('@solus/server/execution/agents/codex/codex-agent')
const { CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend')

type Client = InstanceType<typeof CodexAppServerClient>
type BackendInternals = { client: Client; activeRuns: Map<string, { client: Client }> }

/** Starts the client and leaves one request waiting for an answer that cannot come. */
async function pendingRequest(client: Client) {
  await client.ensureStarted()
  const child = children.at(-1)!
  const outcome = { settled: false }
  const request = client.request('model/list').finally(() => { outcome.settled = true })
  request.catch(() => {})
  return { child, request, outcome }
}

afterEach(() => {
  jest.useRealTimers()
  children.length = 0
})

describe('Codex app-server stdout end', () => {
  // stdout closing with the process still alive used to leave every pending
  // request waiting for its 120 s timeout and the active turn waiting forever.
  test('an output end with a live process fails pending requests and the active run', async () => {
    const backend = new CodexBackend()
    const internals = backend as unknown as BackendInternals
    const client = internals.client
    const runErrors: Array<[string, string]> = []
    backend.on('error', (sessionId: string, err: Error) => runErrors.push([sessionId, err.message]))
    internals.activeRuns.set('thread-1', { client })
    try {
      const { child, request, outcome } = await pendingRequest(client)

      jest.useFakeTimers()
      child.stdout.end()
      await once(child.stdout, 'end')
      jest.advanceTimersByTime(249)
      await Promise.resolve()
      expect(outcome.settled).toBe(false)

      jest.advanceTimersByTime(1)
      await expect(request).rejects.toThrow('Codex app-server output ended')
      expect(runErrors).toEqual([['thread-1', 'Codex app-server exited']])
      expect(child.signals).toEqual(['SIGTERM'])
      // The orphan's late exit reports nothing more.
      child.emit('exit', null, 'SIGTERM')
      expect(runErrors).toHaveLength(1)

      jest.useRealTimers()
      await client.ensureStarted()
      expect(children).toHaveLength(2)
    } finally {
      internals.activeRuns.clear()
      backend.shutdown()
    }
  })

  test('an exit inside the grace keeps its exit status', async () => {
    const client = new CodexAppServerClient()
    const exits: Array<[number | null, string | null]> = []
    client.on('exit', (code: number | null, signal: string | null) => exits.push([code, signal]))
    try {
      const { child, request } = await pendingRequest(client)

      jest.useFakeTimers()
      child.stdout.end()
      await once(child.stdout, 'end')
      jest.advanceTimersByTime(100)
      child.exitCode = 1
      child.emit('exit', 1, null)
      await expect(request).rejects.toThrow('Codex app-server exited code=1 signal=null')

      jest.advanceTimersByTime(500)
      expect(exits).toEqual([[1, null]])
    } finally {
      client.shutdown()
    }
  })

  test('shutdown kills an app-server that ignores SIGTERM', async () => {
    const client = new CodexAppServerClient()
    await client.ensureStarted()
    const child = children.at(-1)!

    jest.useFakeTimers()
    client.shutdown()
    jest.advanceTimersByTime(4999)
    expect(child.signals).toEqual(['SIGTERM'])
    jest.advanceTimersByTime(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
