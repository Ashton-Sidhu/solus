import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

const stateShim = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
type RuneHost = typeof globalThis & { $state?: typeof stateShim }
const runeHost: RuneHost = globalThis
const previousState = runeHost.$state

beforeEach(() => {
  connections.reset()
  runeHost.$state = stateShim
})

afterEach(() => {
  connections.reset()
  if (previousState === undefined) delete runeHost.$state
  else runeHost.$state = previousState
})

const artifact: Work = {
  id: 'chart',
  organizationId: 'local',
  title: 'Revenue chart',
  content: '<title>Revenue chart</title><p>One</p>',
  contentVersion: 1,
  contentHash: 'one',
  contentAuthor: { kind: 'unknown' },
  preview: 'Revenue chart',
  type: 'artifact',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  sessionIds: [],
  agentProvider: 'claude-code',
  cwd: '/repo',
}

async function newStore() {
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  return new WorksStore()
}

test('an agent update without a title or with a reported doc type keeps the listed title and type', async () => {
  // WHY: a cloud-owned save cannot read the row it updates, so it reports `doc`
  // and an empty title. An update never changes what a work is or blanks its name.
  let stored: Work = { ...artifact, content: '<p>Two</p>', contentVersion: 2, updatedAt: '2026-09-22T00:00:01.000Z' }
  connections.registerPrimary('local', { loadWork: async () => stored })
  const store = await newStore()
  store.acceptCreated({ ...artifact }, 'local')

  store.applyRemoteUpdate('chart', '', '<p>Two</p>', '2026-09-22T00:00:01.000Z')
  expect(store.get('chart')!.title).toBe('Revenue chart')
  expect(store.get('chart')!.type).toBe('artifact')

  stored = { ...stored, title: 'Renamed', content: '<p>Three</p>', contentVersion: 3, updatedAt: '2026-09-22T00:00:02.000Z' }
  store.applyRemoteUpdate('chart', 'Renamed', '<p>Three</p>', '2026-09-22T00:00:02.000Z')
  expect(store.get('chart')!.title).toBe('Renamed')
})

test('a session update names no content version, so its body never becomes the saved record', async () => {
  // WHY: the saved record is what a pane bases its draft on. A body without the
  // host's version would let a later save pass a precondition for a body the
  // host never stored under that version.
  let reads = 0
  let finish!: (work: Work) => void
  connections.registerPrimary('local', {
    loadWork: () => { reads++; return new Promise<Work>((resolve) => { finish = resolve }) },
  })
  const store = await newStore()
  store.acceptCreated({ ...artifact }, 'local')

  store.applyRemoteUpdate('chart', 'Revenue chart', '<p>Agent</p>', '2026-09-22T00:00:05.000Z')
  expect(store.savedWork('chart')!.content).toBe(artifact.content)
  expect(store.savedWork('chart')!.contentVersion).toBe(1)
  expect(store.get('chart')!.preview).not.toBe('Revenue chart')
  expect(reads).toBe(1)
  // A second report while the read is in flight joins it.
  store.applyRemoteUpdate('chart', 'Revenue chart', '<p>Agent</p>', '2026-09-22T00:00:05.000Z')
  expect(reads).toBe(1)

  finish({ ...artifact, content: '<p>Agent</p>', contentVersion: 2, updatedAt: '2026-09-22T00:00:05.000Z' })
  await store.ensureContent('chart')
  await Promise.resolve()
  expect(store.savedWork('chart')!.content).toBe('<p>Agent</p>')
  expect(store.savedWork('chart')!.contentVersion).toBe(2)
})

test('a gallery listing is not a saved record: reading content goes to the host', async () => {
  let reads = 0
  connections.registerPrimary('local', {
    listWorks: async () => [{ ...artifact, content: undefined }],
    loadWork: async () => { reads++; return { ...artifact } },
  })
  const store = await newStore()
  await store.loadAll()
  expect(store.get('chart')!.title).toBe('Revenue chart')
  expect(store.savedWork('chart')).toBeUndefined()
  expect((await store.ensureContent('chart'))!.contentVersion).toBe(1)
  // Held once read: an empty body is still a saved body, and is not read again.
  await store.ensureContent('chart')
  expect(reads).toBe(1)
})

test('an older or equal answer never replaces a newer saved record; the record is updated in place', async () => {
  const store = await newStore()
  store.acceptCreated({ ...artifact, content: '<p>v3</p>', contentVersion: 3, updatedAt: '2026-09-22T00:00:03.000Z' }, 'local')
  const record = store.savedWork('chart')!
  store.acceptSaved({ ...artifact, content: '<p>v2</p>', contentVersion: 2, updatedAt: '2026-09-22T00:00:02.000Z' }, 'local')
  store.acceptSaved({ ...artifact, content: '<p>v3 again</p>', contentVersion: 3, updatedAt: '2026-09-22T00:00:03.000Z' }, 'local')
  expect(store.savedWork('chart')!.content).toBe('<p>v3</p>')
  store.acceptSaved({ ...artifact, title: 'Renamed', content: '<p>v3</p>', contentVersion: 3, updatedAt: '2026-09-22T00:00:04.000Z' }, 'local')
  expect(store.savedWork('chart')).toBe(record)
  expect(record.title).toBe('Renamed')
  expect(store.get('chart')!.title).toBe('Renamed')
})

test('an answer from a host that no longer owns the work is ignored', async () => {
  const store = await newStore()
  store.acceptCreated({ ...artifact }, 'machine')
  store.markPublished('chart', 'org-a', 'cloud')
  store.acceptSaved({ ...artifact, content: '<p>late</p>', contentVersion: 5, updatedAt: '2026-09-23T00:00:00.000Z' }, 'machine')
  expect(store.savedWork('chart')!.content).toBe(artifact.content)
  // The destination's record replaces the source's even at a lower version:
  // versions belong to one host's row.
  store.acceptSaved({ ...artifact, organizationId: 'org-a', contentVersion: 1, updatedAt: '2026-09-22T00:00:00.000Z', content: '<p>cloud</p>' }, 'cloud')
  expect(store.savedWork('chart')!.content).toBe('<p>cloud</p>')
})
