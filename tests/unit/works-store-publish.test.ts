import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

// docs/plans/organization-scope.md §7: a work reaches an organization through a
// publication the host performs. The client never exports, imports, or removes
// the work itself; once the host reports `committed`, the store follows the
// work to the organization's workspace service under the same id.

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
  organizationId: 'local',
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

describe('a work published into an organization', () => {
  test('follows the work to the workspace service under the same id, with no export, import, or removal from the client', async () => {
    const cloudCalls: string[] = []
    connections.registerPrimary('local', {
    })
    connections.registerHost(CLOUD, {
      loadWorkAnnotations: async () => { cloudCalls.push('loadWorkAnnotations'); return null },
    })
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const store = new WorksStore()
    store.works[work.id] = { ...work, content: '' }
    store.rememberHost(work.id, 'local')
    store.annotations[work.id] = { version: 1, workId: work.id, comments: [], updatedAt: 1 }

    store.markPublished('work-a', 'org-1', CLOUD)

    // WHY: the id rides along, so a task link or a transcript reference to the
    // work still opens it — on the workspace service the store now names for it.
    // The machine's cached sidecars described a Local copy and are re-read there.
    expect(store.hostFor('work-a')).toBe(CLOUD)
    expect(store.get('work-a')?.organizationId).toBe('org-1')
    expect(store.annotations['work-a']).toBeUndefined()
    await store.loadAnnotations('work-a')
    expect(cloudCalls).toEqual(['loadWorkAnnotations'])
  })

  test('a window shows Local works and the selected organization\'s, never another\'s', async () => {
    connections.registerPrimary('local', {})
    const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
    const { organizationSelection } = await import('@solus/workspace-ui/contexts/connections/organization-selection.store.svelte')
    const store = new WorksStore()
    store.works['local-work'] = { ...work, id: 'local-work' }
    store.works['acme-work'] = { ...work, id: 'acme-work', organizationId: 'org-1' }
    store.works['beta-work'] = { ...work, id: 'beta-work', organizationId: 'org-2' }

    organizationSelection.activeOrganizationId = 'org-1'
    expect(store.visibleWorks.map((entry) => entry.id).sort()).toEqual(['acme-work', 'local-work'])
    organizationSelection.activeOrganizationId = 'org-2'
    expect(store.visibleWorks.map((entry) => entry.id).sort()).toEqual(['beta-work', 'local-work'])
    organizationSelection.activeOrganizationId = null
    expect(store.visibleWorks.map((entry) => entry.id)).toEqual(['local-work'])
  })
})
