import { expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'

// WHY: the live work code (Yjs, and Tiptap for a document) loads when a work
// opens, not with the workspace, so a lease's doc arrives later. Two panes on
// one work must still edit one doc, the last release must destroy it, and a
// load that failed must not stick: the next open tries again.

const works = resolve(import.meta.dir, '../../packages/workspace-ui/src/contexts/works')
const created: FakeDoc[] = []
let failNextLoad = false

class FakeDoc {
  destroyed = false
  constructor(readonly options: { workId: string; schemaVersion: number }) {
    if (failNextLoad) {
      failNextLoad = false
      throw new Error('Chunk unavailable')
    }
    created.push(this)
  }
  async start() {}
  async destroy() { this.destroyed = true }
}

mock.module(`${works}/work-live-doc.svelte`, () => ({ WorkLiveDoc: FakeDoc }))
mock.module(`${works}/work-live-offline`, () => ({
  indexedDbOffline: async () => null,
  liveDatabaseName: (host: string, workId: string) => `${host}:${workId}`,
  recordUnsentLiveWork: () => {},
}))
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: {} }))

const { WorkLiveStore } = await import(`${works}/work-live.store.svelte`)

test('two panes on one work share one doc, and the last release destroys it', async () => {
  const store = new WorkLiveStore({ title: () => 'Plan' })
  const first = store.acquire('host', 'work-1')
  const second = store.acquire('host', 'work-1')
  const doc = await first.live
  expect(await second.live).toBe(doc)
  expect(created.filter((each) => each.options.workId === 'work-1')).toHaveLength(1)

  first.release()
  first.release()
  await Promise.resolve()
  expect(doc.destroyed).toBe(false)
  second.release()
  await new Promise((done) => setTimeout(done, 0))
  expect(doc.destroyed).toBe(true)
})

test('a pane released before its doc loads still destroys the doc', async () => {
  const store = new WorkLiveStore({ title: () => 'Plan' })
  const lease = store.acquire('host', 'work-2')
  lease.release()
  const doc = await lease.live
  await new Promise((done) => setTimeout(done, 0))
  expect(doc.destroyed).toBe(true)
})

test('a failed load is not kept: the next open loads again', async () => {
  const store = new WorkLiveStore({ title: () => 'Plan' })
  failNextLoad = true
  await expect(store.acquire('host', 'work-3').live).rejects.toThrow('Chunk unavailable')
  const doc = await store.acquire('host', 'work-3').live
  expect(doc.options.workId).toBe('work-3')
})
