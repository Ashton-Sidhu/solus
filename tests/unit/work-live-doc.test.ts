import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import type { HostEventMap } from '@solus/contracts/host-events'
import { base64ToBytes, bytesToBase64, type WorkLiveOpenResult, type WorkLivePushRequest, type WorkLivePushResult } from '@solus/contracts/work-live'
import type { HostApi } from '@solus/client-core/host-api'
import type { LiveHost, LiveOfflineStore } from '@solus/workspace-ui/contexts/works/work-live-doc.svelte'
import { liveStatus } from '@solus/workspace-ui/components/work/lib/live-status'

/**
 * The client half of live editing (docs/plans/work-review-and-live-editing.md,
 * phases 3b and 3c): an edit leaves the queue only when the host stored it; a
 * locked or failed push is kept and sent again; edits made offline, even before
 * a restart, reach the host when the connection returns; and a work with
 * unsent edits never says it is saved.
 */

const stateShim = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value })
type RuneHost = typeof globalThis & { $state?: typeof stateShim }
const runeHost: RuneHost = globalThis
const previousState = runeHost.$state
beforeEach(() => { runeHost.$state = stateShim })
afterEach(() => { runeHost.$state = previousState })

type LiveTopic = 'workLive.update' | 'workLive.awareness' | 'workLive.state'

/** A host that keeps one Y.Doc and answers the live calls the way the real one does. */
function fakeHost(initial: (doc: Y.Doc) => void) {
  const hostDoc = new Y.Doc()
  hostDoc.transact(() => initial(hostDoc))
  const listeners = new Map<LiveTopic, Set<(payload: never) => void>>()
  const connectionListeners = new Set<(connected: boolean) => void>()
  const pushes: WorkLivePushRequest[] = []
  let lastSeq = 0
  const state = { connected: true, lock: false, failNext: false }
  const api = {
    async workLiveOpen(request: { stateVector: string }): Promise<WorkLiveOpenResult> {
      if (!state.connected) throw new Error('Transport disconnected')
      return {
        mode: 'edit',
        update: bytesToBase64(Y.encodeStateAsUpdate(hostDoc, base64ToBytes(request.stateVector))),
        stateVector: bytesToBase64(Y.encodeStateVector(hostDoc)),
        lastSeq,
        awareness: [],
        lock: null,
      }
    },
    async workLivePush(request: WorkLivePushRequest): Promise<WorkLivePushResult> {
      if (!state.connected || state.failNext) {
        state.failNext = false
        throw new Error('Transport disconnected')
      }
      if (state.lock) return { status: 'locked' }
      if (request.seq <= lastSeq) return { status: 'duplicate', seq: lastSeq }
      pushes.push(request)
      Y.applyUpdate(hostDoc, base64ToBytes(request.update))
      lastSeq = request.seq
      return { status: 'accepted', seq: request.seq }
    },
    async workLiveAwareness() {},
    async workLiveClose() {},
  }
  const host: LiveHost = {
    // SAFETY: the provider calls only the four live methods this fake defines.
    api: () => api as unknown as HostApi,
    subscribe: <K extends LiveTopic>(type: K, listener: (payload: HostEventMap[K]) => void) => {
      const set = listeners.get(type) ?? new Set()
      // SAFETY: each topic's listeners are only ever called with that topic's payload.
      set.add(listener as (payload: never) => void)
      listeners.set(type, set)
      return () => set.delete(listener as (payload: never) => void)
    },
    onConnection: (listener) => {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
    isConnected: () => state.connected,
  }
  return {
    host, hostDoc, pushes, state,
    emit<K extends LiveTopic>(type: K, payload: HostEventMap[K]) {
      // SAFETY: as in `subscribe`.
      for (const listener of listeners.get(type) ?? []) (listener as (payload: HostEventMap[K]) => void)(payload)
    },
    setConnected(connected: boolean) {
      state.connected = connected
      for (const listener of connectionListeners) listener(connected)
    },
  }
}

/** A device copy in memory, standing in for IndexedDB across a "restart". */
function memoryOffline(saved: { state: Uint8Array | null; meta: Map<string, string | number> }) {
  return (doc: Y.Doc): LiveOfflineStore => {
    if (saved.state) Y.applyUpdate(doc, saved.state)
    const store = () => { saved.state = Y.encodeStateAsUpdate(doc) }
    doc.on('update', store)
    return {
      whenLoaded: Promise.resolve(),
      get: async (key) => saved.meta.get(key),
      set: async (key, value) => { saved.meta.set(key, value) },
      destroy: async () => { doc.off('update', store) },
    }
  }
}

const text = (doc: Y.Doc) => doc.getText('t').toString()
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function liveDoc(host: LiveHost, offline?: (doc: Y.Doc) => LiveOfflineStore) {
  const { WorkLiveDoc } = await import('@solus/workspace-ui/contexts/works/work-live-doc.svelte')
  const live = new WorkLiveDoc({ workId: 'w1', schemaVersion: 1, host, offline, schedule: () => () => {} })
  await live.start()
  return live
}

describe('the push queue', () => {
  test('an edit is dropped from the queue only when the host stored it', async () => {
    const fake = fakeHost((doc) => doc.getText('t').insert(0, 'Hello'))
    const live = await liveDoc(fake.host)
    expect(text(live.doc)).toBe('Hello')
    expect(live.connection).toBe('live')
    live.doc.getText('t').insert(5, ' world')
    await flush()
    expect(text(fake.hostDoc)).toBe('Hello world')
    expect(live.unsent).toBe(0)
    expect(liveStatus(live).label).toBe('Saved')
  })

  test('a push refused while the agent holds the work is kept, and sent when the lock ends', async () => {
    const fake = fakeHost((doc) => doc.getText('t').insert(0, 'A'))
    const live = await liveDoc(fake.host)
    fake.state.lock = true
    fake.emit('workLive.state', { workId: 'w1', lock: { by: { kind: 'agent', sessionId: 's' } } })
    live.doc.getText('t').insert(1, 'B')
    await flush()
    expect(text(fake.hostDoc)).toBe('A')
    expect(live.unsent).toBe(1)
    expect(liveStatus(live).label).toBe('Agent is editing')
    fake.state.lock = false
    fake.emit('workLive.state', { workId: 'w1', lock: null })
    await flush()
    expect(text(fake.hostDoc)).toBe('AB')
    expect(live.unsent).toBe(0)
  })

  test('a failed push goes offline, keeps the edit, and sends it after the reconnect', async () => {
    const fake = fakeHost((doc) => doc.getText('t').insert(0, 'A'))
    const live = await liveDoc(fake.host)
    fake.state.failNext = true
    live.doc.getText('t').insert(1, 'B')
    await flush()
    expect(live.connection).toBe('offline')
    expect(liveStatus(live).label).toBe('Offline · 1 unsent edit')
    fake.setConnected(true)
    await flush()
    await flush()
    expect(text(fake.hostDoc)).toBe('AB')
    expect(live.connection).toBe('live')
    expect(live.unsent).toBe(0)
  })

  test("a teammate's update is applied and never pushed back", async () => {
    const fake = fakeHost((doc) => doc.getText('t').insert(0, 'A'))
    const live = await liveDoc(fake.host)
    const teammate = new Y.Doc()
    Y.applyUpdate(teammate, Y.encodeStateAsUpdate(fake.hostDoc))
    const updates: Uint8Array[] = []
    teammate.on('update', (update: Uint8Array) => updates.push(update))
    teammate.getText('t').insert(1, 'Z')
    fake.emit('workLive.update', { workId: 'w1', update: bytesToBase64(updates[0]!) })
    await flush()
    expect(text(live.doc)).toBe('AZ')
    expect(fake.pushes).toHaveLength(0)
    expect(live.unsent).toBe(0)
  })
})

describe('offline edits', () => {
  test('edits made offline survive a restart and merge with the host when the connection returns', async () => {
    const fake = fakeHost((doc) => doc.getText('t').insert(0, 'Base'))
    const device = { state: null as Uint8Array | null, meta: new Map<string, string | number>() }
    const first = await liveDoc(fake.host, memoryOffline(device))
    fake.setConnected(false)
    first.doc.getText('t').insert(4, ' mine')
    await flush()
    expect(first.connection).toBe('offline')
    await first.destroy()

    // Meanwhile a teammate edited on the host.
    fake.hostDoc.getText('t').insert(0, '> ')

    // The app restarts, still offline: the edits are on the device and counted.
    const second = await liveDoc(fake.host, memoryOffline(device))
    expect(text(second.doc)).toBe('Base mine')
    expect(second.ready).toBe(true)
    expect(liveStatus(second).label).toBe('Offline · 1 unsent edit')

    fake.setConnected(true)
    await flush()
    await flush()
    expect(text(fake.hostDoc)).toBe('> Base mine')
    expect(text(second.doc)).toBe('> Base mine')
    expect(second.unsent).toBe(0)
  })
})
