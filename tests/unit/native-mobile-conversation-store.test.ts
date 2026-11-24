import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { ConversationStore } from '../../apps/mobile/solus-core/features/conversation/conversation-store'
import { memoryKeyValueStore } from '../../apps/mobile/solus-core/platform/ports'
import { createHostWorld, FakeApi, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

async function openStore() {
  const api = new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', () => ({ runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => 1)
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  const transport = world.transports[0]!
  await transport.accept()
  let nextFrame = 0
  const frames = new Map<number, () => void>()
  const storage = memoryKeyValueStore()
  const store = new ConversationStore({ hostId: 'inst-a', record: {
    sessionId: 'thread-1', provider: 'codex', projectPath: '/repo', model: null,
    reasoningEffort: null, title: null, customTitle: null,
  } }, {
    connection,
    outbox: new SendOutbox(() => storage),
    runSettings: async () => ({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} }),
    organizationId: () => null,
    uuid: () => 'client-1',
  }, {
    request: (callback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancel: (frame) => { frames.delete(frame) },
  })
  await store.controller.load()
  const emitText = (text: string) => transport.emitSession('thread-1', { type: 'text_chunk', text })
  emitText('first')
  const rowId = store.orderSnapshot().at(-1)!
  let notifications = 0
  store.subscribeItem(rowId, () => { notifications++ })
  return { store, transport, frames, emitText, rowId, notifications: () => notifications }
}

describe('mobile conversation render notifications', () => {
  test('a burst renders the latest text once per frame without rebuilding the list', async () => {
    const view = await openStore()
    try {
      const feedBatches: string[][] = []
      view.store.subscribeFeedItems((ids) => feedBatches.push([...ids]))
      let orderChanges = 0
      view.store.order.subscribe(() => { orderChanges++ })
      for (let index = 0; index < 100; index++) view.emitText(' more')
      expect(view.notifications()).toBe(0)
      expect(view.frames.size).toBe(1)
      const frame = [...view.frames.values()][0]!
      frame()
      expect(feedBatches).toEqual([[view.rowId]])
      expect(view.notifications()).toBe(1)
      expect(view.store.item(view.rowId)).toMatchObject({ text: 'first' + ' more'.repeat(100) })
      expect(orderChanges).toBe(0)
      expect(view.frames.size).toBe(0)
      view.emitText(' next')
      expect(view.frames.size).toBe(1)
    } finally { view.store.close() }
  })

  test('new rows publish pending text at once and cancel its redundant frame', async () => {
    const view = await openStore()
    try {
      view.emitText(' pending')
      view.transport.emitSession('thread-1', { type: 'user_message', text: 'Next', clientPromptId: 'next-prompt' })
      expect(view.notifications()).toBe(1)
      expect(view.frames.size).toBe(0)
      expect(view.store.orderSnapshot()).toContain('next-prompt')
    } finally { view.store.close() }
  })

  test('settings publish immediately and flush pending text before the next frame', async () => {
    const view = await openStore()
    try {
      let metadataChanges = 0
      view.store.meta.subscribe(() => { metadataChanges++ })
      view.emitText(' pending')
      view.store.controller.updateRun({ fastMode: true })
      expect(metadataChanges).toBe(1)
      expect(view.notifications()).toBe(1)
      expect(view.frames.size).toBe(0)
      expect(view.store.metaSnapshotOf().run.fastMode).toBe(true)
    } finally { view.store.close() }
  })

  test('closing a conversation cancels its pending render', async () => {
    const view = await openStore()
    view.emitText(' pending')
    expect(view.frames.size).toBe(1)
    view.store.close()
    expect(view.frames.size).toBe(0)
    expect(view.notifications()).toBe(0)
  })
})
