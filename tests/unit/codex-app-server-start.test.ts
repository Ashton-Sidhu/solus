import { describe, expect, spyOn, test } from 'bun:test'
import * as cliEnv from '@solus/server/cli-env'
import { CodexAppServerClient } from '@solus/server/execution/agents/codex/codex-agent'

/**
 * `start()` assigns `this.proc` the instant it spawns, long before the
 * `initialize` handshake lands. At boot the renderer asks for usage, sessions
 * and skills at once, so a second caller could reach `ensureStarted` inside
 * that window — and whichever lost the race wrote to a spawned but
 * uninitialized app-server, which answers "Not initialized". That is what
 * showed Codex as unavailable in the usage panel on a cold boot.
 *
 * The client owns a real child process, so this drives the gate directly:
 * a start that is in flight must hold every other caller until it finishes.
 */
describe('CodexAppServerClient.ensureStarted', () => {
  test('concurrent transcript reads send no requests before initialization', async () => {
    const client = new CodexAppServerClient()
    const sent: string[] = []
    let finishStart: (() => void) | undefined
    let initialized = false
    Object.defineProperty(client, 'start', {
      value: () => {
        Object.defineProperty(client, 'proc', { value: { killed: false } })
        return new Promise<void>((resolve) => {
          finishStart = () => { initialized = true; resolve() }
        })
      },
    })
    Object.defineProperty(client, '_send', {
      value: async (method: string, params: { threadId: string }) => {
        sent.push(method)
        if (!initialized) throw new Error('Not initialized')
        return { thread: { id: params.threadId, turns: [] } }
      },
    })

    const reads = Promise.all([
      client.request('thread/read', { threadId: 'first', includeTurns: true }),
      client.request('thread/read', { threadId: 'second', includeTurns: true }),
    ])
    await Promise.resolve()
    expect(sent).toEqual([])
    finishStart?.()
    const results = await reads
    expect(results.map((result) => result.thread.id)).toEqual(['first', 'second'])
    expect(sent).toEqual(['thread/read', 'thread/read'])
  })

  test('a caller arriving mid-start waits for the handshake, not just the spawn', async () => {
    const client = new CodexAppServerClient()
    const order: string[] = []
    let finishStart: (() => void) | undefined

    // Stand in for start(): mark the process live immediately, as spawn does,
    // then finish much later, as the handshake does.
    Object.defineProperty(client, 'start', {
      value: () => {
        Object.defineProperty(client, 'proc', {
          value: { killed: false, stdin: { writable: true } },
          configurable: true,
          writable: true,
        })
        order.push('spawned')
        return new Promise<void>((resolve) => {
          finishStart = () => { order.push('initialized'); resolve() }
        })
      },
      configurable: true,
      writable: true,
    })

    const first = client.ensureStarted().then(() => order.push('first-resolved'))
    // Same tick as a boot fan-out: the process exists, the handshake does not.
    const second = client.ensureStarted().then(() => order.push('second-resolved'))

    await Promise.resolve()
    expect(order).toEqual(['spawned'])

    finishStart?.()
    await Promise.all([first, second])

    // Both callers are behind 'initialized'. Before the fix, 'second-resolved'
    // landed while only 'spawned' had happened.
    expect(order.indexOf('second-resolved')).toBeGreaterThan(order.indexOf('initialized'))
    expect(order.indexOf('first-resolved')).toBeGreaterThan(order.indexOf('initialized'))
  })
})

/**
 * A host without Codex spawned `codex` anyway. The spawn failed with ENOENT,
 * but the dead process stayed on the client, so it counted as started: the
 * session-index poll then failed every few minutes with "Codex app-server is
 * not running", and an install after boot was never picked up.
 */
describe('CodexAppServerClient without codex installed', () => {
  test('refuses to start, stays unstarted, and checks again on the next request', async () => {
    const pathLookup = spyOn(cliEnv, 'warmCliPath').mockResolvedValue('/nonexistent-solus-test-dir')
    try {
      const client = new CodexAppServerClient()
      await expect(client.ensureStarted()).rejects.toThrow('Codex was not found on this host')
      expect(client.hasStarted).toBe(false)
      await expect(client.ensureStarted()).rejects.toThrow('Codex was not found on this host')
      expect(pathLookup).toHaveBeenCalledTimes(2)
    } finally {
      pathLookup.mockRestore()
    }
  })
})
