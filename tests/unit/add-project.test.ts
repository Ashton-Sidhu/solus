import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SOLUS_WORKTREE_PATH_MARKER } from '@solus/contracts/types'

/**
 * "Add project…" in a page-level project switcher. A project used to reach the
 * Tasks / Pull requests / Automations / Workspace switchers only after a
 * session ran in it; this flow lets a person name a folder that is on disk but
 * has never been opened. Two records have to agree for that to work: the client
 * catalog the switchers read, and the browsed host's own recents.
 */

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

// The stores under test are `.svelte.ts` modules read as plain TypeScript here,
// so `$state` has to exist as an ordinary identity function.
declare global {
  var $state: <T>(value: T) => T
}

const originalLocalStorage = globalThis.localStorage
const originalState = globalThis.$state

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
  globalThis.$state = <T>(value: T): T => value
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true })
  globalThis.$state = originalState
})

/** The host side of the flow: what the picked folder was reported to the host as. */
function fakeHost() {
  const tracked: string[] = []
  return { tracked, api: { trackRecentProject: async (path: string) => { tracked.push(path) } } }
}

async function stores() {
  const { ProjectsStore } = await import('@solus/workspace-ui/contexts/projects/projects.store.svelte')
  return new ProjectsStore({ entries: [], ignoredDiscoveryKeys: [] }, async () => [])
}

describe('adding a project from the directory picker', () => {
  test('records it against the browsed host and tells that host to remember it', async () => {
    const projectsStore = await stores()
    const host = fakeHost()

    const project = await projectsStore.addProject('studio-vm', host.api, '/repos/solus')

    expect(projectsStore.has({ serverId: 'studio-vm', projectRoot: '/repos/solus' })).toBe(true)
    expect(host.tracked).toEqual(['/repos/solus'])
    expect(project).toEqual({ serverId: 'studio-vm', projectRoot: '/repos/solus' })
    // The folder name is what a switcher row identifies the project by.
    const entry = projectsStore.entries.find((e) => e.projectRoot === '/repos/solus')
    expect(entry?.label).toBe('solus')
  })

  test('a worktree checkout is added as its project, not as a second project', async () => {
    const projectsStore = await stores()
    const host = fakeHost()

    await projectsStore.addProject(
      'local',
      host.api,
      `/repos/atlas/${SOLUS_WORKTREE_PATH_MARKER}/feature-branch`,
    )

    expect(projectsStore.has({ serverId: 'local', projectRoot: '/repos/atlas' })).toBe(true)
    expect(host.tracked).toEqual(['/repos/atlas'])
  })

  test('the host workspace root is not a project, so neither record is written', async () => {
    const projectsStore = await stores()
    const host = fakeHost()
    const before = projectsStore.entries.length

    const project = await projectsStore.addProject('local', host.api, '~')

    expect(projectsStore.entries).toHaveLength(before)
    expect(host.tracked).toEqual([])
    expect(project).toBeNull()
  })

  test('a host that cannot record the project still leaves the switcher able to scope to it', async () => {
    const projectsStore = await stores()
    const failing = { trackRecentProject: async () => { throw new Error('host offline') } }

    await projectsStore.addProject('studio-vm', failing, '/repos/lighthouse')

    expect(projectsStore.has({ serverId: 'studio-vm', projectRoot: '/repos/lighthouse' })).toBe(true)
  })

  test('records the project before the host finishes updating its recents', async () => {
    const projectsStore = await stores()
    let finishTracking: (() => void) | undefined
    const api = {
      trackRecentProject: () => new Promise<void>((resolve) => { finishTracking = resolve }),
    }

    const pending = projectsStore.addProject('remote', api, '/repos/instant')

    expect(projectsStore.has({ serverId: 'remote', projectRoot: '/repos/instant' })).toBe(true)
    finishTracking?.()
    await pending
  })
})
