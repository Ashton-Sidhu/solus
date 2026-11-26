import { describe, expect, test } from 'bun:test'
import type { BrowserCloseResult } from '@solus/contracts/browser-types'
import type { RunningServer } from '@solus/contracts/running-servers'
import { SERVER_RETURN_GRACE_MS, ServedPages } from '@solus/server/browser/served-pages'
import { runningServer } from './running-server-fixtures'

/**
 * An agent that starts a dev server, opens it in the browser, and then stops the
 * server leaves a dead tab behind. These tests encode when Solus closes that tab
 * for the agent, and the cases where closing it would take something from the
 * user or from an agent that only restarts its server.
 */

const PAGE = 'browser_page-1'
const URL = 'http://localhost:3001/'

function serverOn(pid: number, sessionId = 'session-1'): RunningServer {
  const server = runningServer(`server-${pid}`)
  server.process.pid = pid
  server.startedBy = { kind: 'agent', sessionId }
  return server
}

function harness(initial: RunningServer[]) {
  const state = {
    servers: initial,
    alive: new Set(initial.map((server) => server.process.pid)),
    pages: new Map([[PAGE, URL]]),
    closeResult: { closed: true } as BrowserCloseResult,
    closed: [] as string[],
    now: 0,
    tick: null as (() => Promise<void>) | null,
  }
  const served = new ServedPages({
    servers: async () => state.servers,
    isAlive: (pid) => state.alive.has(pid),
    pageUrl: (id) => state.pages.get(id) ?? null,
    close: async (id) => {
      if (state.closeResult.closed) {
        state.closed.push(id)
        state.pages.delete(id)
      }
      return state.closeResult
    },
    now: () => state.now,
    schedule: (tick) => {
      state.tick = tick
      return () => { state.tick = null }
    },
  })
  /** Let time pass and run the checks that fall due in it. */
  const advance = async (ms: number) => {
    const end = state.now + ms
    while (state.tick && state.now + 3000 <= end) {
      state.now += 3000
      const tick = state.tick
      state.tick = null
      await tick()
    }
    state.now = end
  }
  /** The server process exits, as after `kill` or a Stop. */
  const stopServer = () => {
    state.alive.clear()
    state.servers = []
  }
  return { served, state, advance, stopServer }
}

describe('served pages', () => {
  test('the page closes when its server stops and does not come back', async () => {
    const { served, state, advance, stopServer } = harness([serverOn(500)])
    await served.follow(PAGE, URL, 'session-1')
    stopServer()

    await advance(SERVER_RETURN_GRACE_MS - 3000)
    expect(state.closed).toEqual([])
    await advance(6000)
    expect(state.closed).toEqual([PAGE])
    // Nothing is left to check, so the check stops.
    expect(state.tick).toBeNull()
  })

  test('a server restarted on the same port keeps the page and is followed again', async () => {
    const { served, state, advance, stopServer } = harness([serverOn(500)])
    await served.follow(PAGE, URL, 'session-1')
    stopServer()
    await advance(6000)
    state.servers = [serverOn(600)]
    state.alive.add(600)

    await advance(SERVER_RETURN_GRACE_MS)
    expect(state.closed).toEqual([])

    // The link moved to the new process: its stop closes the page.
    stopServer()
    await advance(SERVER_RETURN_GRACE_MS + 3000)
    expect(state.closed).toEqual([PAGE])
  })

  test('a server that another session started does not close the page', async () => {
    const { served, state, advance, stopServer } = harness([serverOn(500, 'session-2')])
    await served.follow(PAGE, URL, 'session-1')
    stopServer()

    await advance(SERVER_RETURN_GRACE_MS * 2)
    expect(state.closed).toEqual([])
    expect(state.tick).toBeNull()
  })

  test('a page that now shows another site is no longer closed with the server', async () => {
    const { served, state, advance, stopServer } = harness([serverOn(500)])
    await served.follow(PAGE, URL, 'session-1')
    state.pages.set(PAGE, 'https://example.com/')
    stopServer()

    await advance(SERVER_RETURN_GRACE_MS * 2)
    expect(state.closed).toEqual([])
  })

  test('the error page of a failed reload does not end the link', async () => {
    const { served, state, advance, stopServer } = harness([serverOn(500)])
    await served.follow(PAGE, URL, 'session-1')
    state.pages.set(PAGE, 'chrome-error://chromewebdata/')
    stopServer()

    await advance(SERVER_RETURN_GRACE_MS + 3000)
    expect(state.closed).toEqual([PAGE])
  })

  test('a page an agent is working in is closed only when that work ends', async () => {
    const { served, state, advance, stopServer } = harness([serverOn(500)])
    await served.follow(PAGE, URL, 'session-1')
    state.closeResult = { closed: false, reason: 'agent-use', agentUse: { verb: 'browser_click', running: 1, at: 0 } }
    stopServer()

    await advance(SERVER_RETURN_GRACE_MS + 3000)
    expect(state.closed).toEqual([])
    state.closeResult = { closed: true }
    await advance(3000)
    expect(state.closed).toEqual([PAGE])
  })
})
