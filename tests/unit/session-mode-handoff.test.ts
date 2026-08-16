import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../../src/client-core/local-api', () => ({
  localApi: { getPlatform: () => 'darwin' },
}))

const {
  consumeSessionHandoff,
  writeSessionHandoff,
} = await import('../../src/renderer/contexts/workspace/active-session-pointer')

const HANDOFF_KEY = 'solus-session-handoff'
const previousLocalStorage = globalThis.localStorage
const previousWindow = globalThis.window
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  })
})

afterEach(() => {
  for (const [name, previous] of [
    ['localStorage', previousLocalStorage],
    ['window', previousWindow],
  ] as const) {
    if (previous === undefined) {
      delete (globalThis as unknown as { [key: string]: unknown })[name]
    } else {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: previous })
    }
  }
})

describe('mode-switch session handoff', () => {
  test('delivers a scoped handoff to its target and consumes the key', () => {
    // WHY: dispatch-client step 1 — the handoff is a session ref crossing the
    // client (two windows), so it must name the session's host; the target
    // window must not guess one.
    writeSessionHandoff({
      sessionId: 'sess-1',
      serverId: 'host-a',
      provider: 'claude-code',
      cwd: '/repo',
      title: 'Fix parser',
      target: 'editor',
    })

    const delivered: string[] = []
    const unsubscribe = consumeSessionHandoff('editor', (handoff) => {
      delivered.push(`${handoff.serverId}:${handoff.sessionId}`)
    })
    unsubscribe()

    expect(delivered).toEqual(['host-a:sess-1'])
    expect(store.has(HANDOFF_KEY)).toBe(false)
  })

  test('a handoff addressed to the other mode is left for that window', () => {
    writeSessionHandoff({
      sessionId: 'sess-1',
      serverId: 'host-a',
      provider: 'claude-code',
      cwd: '/repo',
      title: null,
      target: 'pill',
    })

    let deliveredCount = 0
    consumeSessionHandoff('editor', () => {
      deliveredCount += 1
    })()

    expect(deliveredCount).toBe(0)
    expect(store.has(HANDOFF_KEY)).toBe(true)
  })

  test('a hostless or corrupt record is deleted, never delivered', () => {
    // Delete-and-miss: a poison record used to re-fail on every storage event
    // for the lifetime of both windows. A pre-scoping record without a host is
    // ignored the same way — resend beats guessing a host.
    for (const raw of [
      '{not json',
      JSON.stringify({ target: 'editor', sessionId: 'sess-1', updatedAt: Date.now() }),
    ]) {
      store.set(HANDOFF_KEY, raw)
      let deliveredCount = 0
      consumeSessionHandoff('editor', () => {
        deliveredCount += 1
      })()
      expect(deliveredCount).toBe(0)
      expect(store.has(HANDOFF_KEY)).toBe(false)
    }
  })
})
