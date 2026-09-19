import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

// docs/plans/cloud-service-model.md R6: a work moves to the organization's
// workspace service one way — the same row there, the copy here deleted, the id
// kept so every link to it still resolves.

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

const work: Work = {
  id: 'work-a',
  title: 'Release plan',
  content: '# Release plan',
  preview: 'Release plan',
  type: 'doc',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sessionIds: [],
  agentProvider: 'claude-code',
  cwd: '/repo',
}

type CreateWorkArgs = [string, Work['type'], string | undefined, string | undefined, string | undefined, Work['agentProvider'], string | undefined, string | undefined]

describe('moving a work to Solus Cloud', () => {
  test('creates the same work on the cloud host, deletes the local copy, and follows the cloud one', async () => {
    const created: CreateWorkArgs[] = []
    const deleted: string[] = []
    connections.registerPrimary('local', {
      loadWork: async () => work,
      deleteWork: async (workId: string) => { deleted.push(workId) },
    })
    connections.registerHost(CLOUD, {
      createWork: async (...args: CreateWorkArgs) => {
        created.push(args)
        return { ...work, content: args[2] ?? '', updatedAt: '2026-02-01T00:00:00.000Z' }
      },
    })
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()
    store.works[work.id] = { ...work, content: '' }
    store.rememberHost(work.id, 'local')

    const moved = await store.moveToCloud('work-a', CLOUD)

    // WHY: the id rides along, so a task link or a transcript reference to the
    // work still opens it — on the cloud host the store now names for it.
    expect(created).toEqual([['Release plan', 'doc', '# Release plan', 'Release plan', undefined, 'claude-code', '/repo', 'work-a']])
    expect(deleted).toEqual(['work-a'])
    expect(moved.id).toBe('work-a')
    expect(store.hostFor('work-a')).toBe(CLOUD)
    expect(store.get('work-a')?.updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })

  test('a refused create leaves the local work where it was', async () => {
    const deleted: string[] = []
    connections.registerPrimary('local', {
      loadWork: async () => work,
      deleteWork: async (workId: string) => { deleted.push(workId) },
    })
    connections.registerHost(CLOUD, {
      createWork: async () => { throw new Error('PLANE_DISABLED') },
    })
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()
    store.works[work.id] = work
    store.rememberHost(work.id, 'local')

    await expect(store.moveToCloud('work-a', CLOUD)).rejects.toThrow('PLANE_DISABLED')
    expect(deleted).toEqual([])
    expect(store.hostFor('work-a')).toBe('local')
  })

  test('a work already on the cloud host does not move', async () => {
    connections.registerPrimary('local', {})
    connections.registerHost(CLOUD, {})
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()
    store.works[work.id] = work
    store.rememberHost(work.id, CLOUD)
    await expect(store.moveToCloud('work-a', CLOUD)).rejects.toThrow('already in Solus Cloud')
  })
})
