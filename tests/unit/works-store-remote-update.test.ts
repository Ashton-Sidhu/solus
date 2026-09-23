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
  title: 'Revenue chart',
  content: '<title>Revenue chart</title><p>One</p>',
  preview: 'Revenue chart',
  type: 'artifact',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  sessionIds: [],
  agentProvider: 'claude-code',
  cwd: '/repo',
}

test('an update without a title or with a reported doc type keeps the saved title and type', async () => {
  // WHY: a cloud-owned save cannot read the row it updates, so it reports `doc`
  // and an empty title. An update never changes what a work is or blanks its name.
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const store = new WorksStore()
  store.works[artifact.id] = { ...artifact }

  await store.applyRemoteUpdate('chart', '', '<p>Two</p>', '2026-09-22T00:00:01.000Z')

  const saved = store.get('chart')!
  expect(saved.title).toBe('Revenue chart')
  expect(saved.type).toBe('artifact')
  expect(saved.content).toBe('<p>Two</p>')
  expect(saved.updatedAt).toBe('2026-09-22T00:00:01.000Z')

  await store.applyRemoteUpdate('chart', 'Renamed', '<p>Three</p>', '2026-09-22T00:00:02.000Z')
  expect(store.get('chart')!.title).toBe('Renamed')
})
