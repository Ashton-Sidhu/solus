import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { HostRpcError } from '@solus/client-core/rpc-error'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

/** The store is a `.svelte.ts` module: outside the compiler, `$state` is an
 *  identity function and `$state.snapshot` a plain read. */
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

const CLOUD = 'workspace:org-1'

test('a read the old host answers MOVED is asked again where the work is now', async () => {
  // WHY: Share moves a work to the organization's host and leaves only its
  // location here (cloud-sharing.md §3a). A reader that asks this host — a
  // reloaded html_path card, the History panel — must follow the answer to the
  // new owner, or every shared work reads as missing.
  connections.registerPrimary('local', {
    listWorks: async () => [],
    loadWorkRevisions: async () => { throw new HostRpcError('Work work-a moved to organization org-1.', 'MOVED') },
  })
  connections.registerHost(CLOUD, {
    listWorks: async () => [{ id: 'work-a', organizationId: 'org-1', title: 'Chart', preview: '', type: 'artifact', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessionIds: [], agentProvider: 'claude-code', cwd: '/repo' }],
    loadWorkRevisions: async () => [{ revisionId: 7, sourceContentVersion: 1 }, { revisionId: 8, sourceContentVersion: 2 }],
    loadWorkRevision: async (_workId: string, revisionId: number) => ({ content: `<p>revision ${revisionId}</p>` }),
  })
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const store = new WorksStore()

  expect(await store.history.bodyAtVersion('work-a', 2)).toBe('<p>revision 8</p>')
  expect(store.hostFor('work-a')).toBe(CLOUD)
  // A version no checkpoint holds has no body, rather than another version's.
  expect(await store.history.bodyAtVersion('work-a', 5)).toBeNull()
})

test('a host that does not have the work at all is not asked twice', async () => {
  // A plain refusal is not a move: the store does not reread every host's list for it.
  let lists = 0
  connections.registerPrimary('local', {
    listWorks: async () => { lists += 1; return [] },
    loadWorkRevisions: async () => { throw new Error('Work not found: work-b') },
  })
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const store = new WorksStore()
  store.rememberHost('work-b', 'local')

  await expect(store.history.bodyAtVersion('work-b', 1)).rejects.toThrow('Work not found')
  expect(lists).toBe(0)
})

test('a work shared before hosts kept a location is found from the work lists', async () => {
  // Its old host has no row and answers "not found", not MOVED. The lists still
  // name the organization that has it, so a reload rebuilds its cards.
  connections.registerPrimary('local', {
    listWorks: async () => [],
    loadWorkRevisions: async () => { throw new Error('Work not found: work-c') },
  })
  connections.registerHost(CLOUD, {
    listWorks: async () => [{ id: 'work-c', organizationId: 'org-1', title: 'Chart', preview: '', type: 'artifact', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessionIds: [], agentProvider: 'claude-code', cwd: '/repo' }],
    loadWorkRevisions: async () => [{ revisionId: 3, sourceContentVersion: 1 }],
    loadWorkRevision: async () => ({ content: '<p>before locations</p>' }),
  })
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const store = new WorksStore()

  expect(await store.history.bodyAtVersion('work-c', 1)).toBe('<p>before locations</p>')
})

test('a transcript card asks its session host without waiting for every host to list its works', async () => {
  // WHY: a session's artifact cards hold the session open until their bodies
  // load. Listing every work on every host first cost seconds when one host
  // was slow, so a card asks the host its session ran on, where it was saved.
  let lists = 0
  connections.registerPrimary('local', {
    listWorks: async () => { lists += 1; return [] },
    loadWorkRevisions: async () => [{ revisionId: 4, sourceContentVersion: 1 }],
    loadWorkRevision: async () => ({ content: '<p>from the session host</p>' }),
  })
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const store = new WorksStore()

  expect(await store.history.bodyAtVersion('work-d', 1, 'local')).toBe('<p>from the session host</p>')
  expect(lists).toBe(0)
})

test('a session host that does not have the work falls back to the work lists', async () => {
  // The guess can be wrong: a work shared before hosts kept a location answers
  // "not found" there. The lists still name its owner.
  connections.registerPrimary('local', {
    listWorks: async () => [],
    loadWorkRevisions: async () => { throw new Error('Work not found: work-e') },
  })
  connections.registerHost(CLOUD, {
    listWorks: async () => [{ id: 'work-e', organizationId: 'org-1', title: 'Chart', preview: '', type: 'artifact', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessionIds: [], agentProvider: 'claude-code', cwd: '/repo' }],
    loadWorkRevisions: async () => [{ revisionId: 9, sourceContentVersion: 1 }],
    loadWorkRevision: async () => ({ content: '<p>found by list</p>' }),
  })
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const store = new WorksStore()

  expect(await store.history.bodyAtVersion('work-e', 1, 'local')).toBe('<p>found by list</p>')
})

test('the cards of one work in one page share a single revision list read', async () => {
  // WHY: three revisions of one artifact asked for the same list three times.
  let listReads = 0
  connections.registerPrimary('local', {
    listWorks: async () => [],
    loadWorkRevisions: async () => { listReads += 1; return [{ revisionId: 1, sourceContentVersion: 1 }, { revisionId: 2, sourceContentVersion: 2 }] },
    loadWorkRevision: async (_workId: string, revisionId: number) => ({ content: `<p>${revisionId}</p>` }),
  })
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const store = new WorksStore()

  const bodies = await Promise.all([1, 2, 1].map((version) => store.history.bodyAtVersion('work-f', version, 'local')))
  expect(bodies).toEqual(['<p>1</p>', '<p>2</p>', '<p>1</p>'])
  expect(listReads).toBe(1)
  // A later reload asks again: an agent may have written a revision since.
  await store.history.bodyAtVersion('work-f', 2, 'local')
  expect(listReads).toBe(2)
})
