import { describe, expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { CheckoutStore } from '@solus/workspace-ui/contexts/git/checkout.store.svelte'
import type { CheckoutChange, CheckoutSnapshot, CheckoutState } from '@solus/contracts/checkout'
import { browserPageForCheckout } from '@solus/contracts/browser-checkout'
import { defaultViewport, type BrowserPage } from '@solus/contracts/browser-types'

const cwd = '/repo/.git/solus/worktrees/solus-12345678'
function change(branch: string | null, revision: number, generation = 'host-boot-1'): CheckoutChange {
  return { generation, cause: 'observed', state: {
    cwd, revision, checkout: { repoRoot: '/repo', worktreePath: cwd, branch, targetBranch: 'main' },
  } }
}

describe('checkout identity projection', () => {
  test('a selected path reuses the host snapshot already in progress', async () => {
    const store = new CheckoutStore()
    let finish!: (snapshot: CheckoutSnapshot) => void
    let calls = 0
    const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
      checkoutSnapshot: () => {
        calls++
        return new Promise<CheckoutSnapshot>((resolve) => { finish = resolve })
      },
    }))
    try {
      const recovery = store.refresh('host-a')
      const selected = store.ensure('host-a', cwd)
      expect(calls).toBe(1)
      finish({ generation: 'host-boot-1', revision: 1, states: [change('main', 1).state] })
      await Promise.all([recovery, selected])
      expect(calls).toBe(1)
      expect(store.get('host-a', cwd)?.checkout?.branch).toBe('main')
    } finally { api.mockRestore() }
  })

  test('startup recovery includes restored paths before the host has any checkout state', async () => {
    const store = new CheckoutStore()
    const calls: Array<string[] | undefined> = []
    let finish!: (snapshot: CheckoutSnapshot) => void
    const events = new HostEventSubscriber()
    const spies = [
      spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({ checkoutSnapshot: (paths) => {
        calls.push(paths)
        return new Promise<CheckoutSnapshot>((resolve) => { finish = resolve })
      } })),
      spyOn(serverConnections, 'connectedServerIds').mockReturnValue(['host-a']),
      spyOn(serverConnections, 'eventsFor').mockReturnValue(events),
      spyOn(serverConnections, 'onConnectionCreated').mockReturnValue(() => {}),
      spyOn(serverConnections, 'onStatusChange').mockReturnValue(() => {}),
    ]
    const stop = store.subscribe(() => [cwd, cwd])
    try {
      const selected = store.ensure('host-a', cwd)
      expect(calls).toEqual([[cwd]])
      finish({ generation: 'host-boot-1', revision: 1, states: [change('main', 1).state] })
      await selected
      expect(calls).toEqual([[cwd]])
      expect(store.get('host-a', cwd)?.checkout?.branch).toBe('main')
    } finally { stop(); for (const spy of spies) spy.mockRestore() }
  })

  test('a path missing from the host snapshot still gets its own read', async () => {
    const store = new CheckoutStore()
    let finish!: (snapshot: CheckoutSnapshot) => void
    const calls: Array<string[] | undefined> = []
    const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
      checkoutSnapshot: (paths) => {
        calls.push(paths)
        return calls.length === 1
          ? new Promise<CheckoutSnapshot>((resolve) => { finish = resolve })
          : Promise.resolve({ generation: 'host-boot-1', revision: 1, states: [change('main', 1).state] })
      },
    }))
    try {
      const recovery = store.refresh('host-a')
      const selected = store.ensure('host-a', cwd)
      finish({ generation: 'host-boot-1', revision: 0, states: [] })
      await Promise.all([recovery, selected])
      expect(calls).toEqual([[], [cwd]])
      expect(store.get('host-a', cwd)?.checkout?.branch).toBe('main')
    } finally { api.mockRestore() }
  })

  test('late snapshots cannot replace a rename and another host stays separate', () => {
    const store = new CheckoutStore()
    store.apply('host-a', change('solus/fix-layout', 2))
    store.apply('host-b', change('solus/12345678', 1))
    store.applySnapshot('host-a', { generation: 'host-boot-1', revision: 1, states: [change('solus/12345678', 1).state] })
    expect(store.get('host-a', cwd)?.checkout?.branch).toBe('solus/fix-layout')
    expect(store.get('host-b', cwd)?.checkout?.branch).toBe('solus/12345678')
  })

  test('a restarted host resets revisions and rejects responses from its old generation', () => {
    const store = new CheckoutStore()
    store.apply('host-a', change('before-restart', 100))
    store.applySnapshot('host-a', { generation: 'host-boot-2', revision: 1, states: [change('after-restart', 1).state] })
    store.apply('host-a', change('late-old-event', 101))
    expect(store.get('host-a', cwd)?.checkout?.branch).toBe('after-restart')
  })

  test('removed checkouts do not fall back to a stale session attachment', () => {
    const store = new CheckoutStore()
    const fallback = change('old-name', 1).state.checkout
    store.apply('host-a', { generation: 'host-boot-1', cause: 'observed', state: { cwd, revision: 2, checkout: null } })
    expect(store.resolve('host-a', cwd, fallback)).toBeNull()
    expect(store.resolve('host-b', cwd, fallback)).toEqual(fallback)
  })

  test('browser labels derive from checkout state without changing page snapshots or custom labels', () => {
    const page: BrowserPage = {
      browserPageId: 'page-1', target: { kind: 'url', url: 'http://localhost:5173', worktreePath: cwd, branch: 'solus/12345678' },
      url: 'http://localhost:5173', title: 'Preview', viewport: defaultViewport(), appearance: 'system', profileId: 'default',
      hostKind: 'none', loadState: 'idle', canGoBack: false, canGoForward: false, devToolsOpen: false,
      annotationTool: null, label: 'solus/12345678', automaticLabel: true, createdAt: 1,
    }
    const state: CheckoutState = change('solus/fix-layout', 2).state
    expect(browserPageForCheckout(page, state)).toMatchObject({ label: 'solus/fix-layout', target: { branch: 'solus/fix-layout' } })
    expect(page.label).toBe('solus/12345678')
    expect(browserPageForCheckout({ ...page, automaticLabel: false }, state).label).toBe('solus/12345678')
    expect(browserPageForCheckout(page, { ...state, cwd: '/other' })).toBe(page)
  })
})
