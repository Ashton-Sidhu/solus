import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mergeProjectOptions,
  normalizeProjectRoot,
  projectRefKey,
} from '@solus/workspace-ui/contexts/projects/project-catalog'
import { ProjectsStore } from '@solus/workspace-ui/contexts/projects/projects.store.svelte'
import { SOLUS_WORKTREE_PATH_MARKER } from '@solus/contracts/types'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

const originalLocalStorage = (globalThis as any).localStorage
let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true })
})

describe('normalizeProjectRoot', () => {
  test('strips the worktree marker segment so a worktree checkout collapses to its base project', () => {
    const worktreePath = `/repos/solus/${SOLUS_WORKTREE_PATH_MARKER}/feature-branch`
    expect(normalizeProjectRoot(worktreePath)).toBe('/repos/solus')
  })

  test('drops a trailing slash so it keys the same as the bare path', () => {
    expect(normalizeProjectRoot('/repos/solus/')).toBe('/repos/solus')
  })
})

describe('mergeProjectOptions', () => {
  test('dedupes by (serverId, projectRoot) across sources, first source keeping its label', () => {
    const merged = mergeProjectOptions(
      [
        [{ serverId: 'host-a', projectRoot: '/repos/solus', label: 'Live: Solus' }],
        [{ serverId: 'host-a', projectRoot: '/repos/solus', label: 'Catalog: Solus' }],
      ],
      () => true,
      (serverId) => serverId,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].label).toBe('Live: Solus')
  })

  test('keeps equal paths on different hosts as distinct rows, not deduped', () => {
    const merged = mergeProjectOptions(
      [[
        { serverId: 'host-a', projectRoot: '/repos/solus', label: 'solus' },
        { serverId: 'host-b', projectRoot: '/repos/solus', label: 'solus' },
      ]],
      () => true,
      (serverId) => (serverId === 'host-a' ? 'Laptop' : 'Build box'),
    )
    expect(merged).toHaveLength(2)
    expect(merged.map((option) => option.label).sort()).toEqual(['solus · Build box', 'solus · Laptop'])
    expect(new Set(merged.map((option) => option.key)).size).toBe(2)
  })

  test('marks a disconnected host unavailable without dropping the row', () => {
    const merged = mergeProjectOptions(
      [[{ serverId: 'offline-host', projectRoot: '/repos/solus', label: 'solus' }]],
      (serverId) => serverId !== 'offline-host',
      (serverId) => serverId,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].available).toBe(false)
  })

  test('ignores a bare workspace-root entry ("~")', () => {
    const merged = mergeProjectOptions(
      [[{ serverId: 'host-a', projectRoot: '~', label: 'Workspace' }]],
      () => true,
      (serverId) => serverId,
    )
    expect(merged).toHaveLength(0)
  })
})

describe('ProjectsStore', () => {
  test('records opened/cloned/adopted/session-run projects, touching an existing entry instead of duplicating it', () => {
    const catalog = new ProjectsStore()
    catalog.record({ serverId: 'host-a', projectRoot: '/repos/solus' }, 'Solus')
    catalog.record({ serverId: 'host-a', projectRoot: '/repos/solus' }, 'Solus (renamed)')

    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0].label).toBe('Solus (renamed)')
  })

  test('equal paths on different hosts stay two distinct catalog entries', () => {
    const catalog = new ProjectsStore()
    catalog.record({ serverId: 'host-a', projectRoot: '/repos/solus' }, 'Solus')
    catalog.record({ serverId: 'host-b', projectRoot: '/repos/solus' }, 'Solus')

    expect(catalog.entries).toHaveLength(2)
    expect(new Set(catalog.entries.map((entry) => projectRefKey(entry))).size).toBe(2)
  })

  test('explicit removal forgets only the named entry, and only that one', () => {
    const catalog = new ProjectsStore()
    catalog.record({ serverId: 'host-a', projectRoot: '/repos/solus' }, 'Solus')
    catalog.record({ serverId: 'host-a', projectRoot: '/repos/tools' }, 'Tools')

    catalog.remove({ serverId: 'host-a', projectRoot: '/repos/solus' })

    expect(catalog.entries.map((entry) => entry.projectRoot)).toEqual(['/repos/tools'])
  })

  test('removal never touches unrelated entries and is a no-op for an unknown project', () => {
    const catalog = new ProjectsStore()
    catalog.record({ serverId: 'host-a', projectRoot: '/repos/solus' }, 'Solus')

    catalog.remove({ serverId: 'host-a', projectRoot: '/repos/unknown' })

    expect(catalog.entries).toHaveLength(1)
  })

  test('persists across store instances — a project opened once is still known after a restart', () => {
    const first = new ProjectsStore()
    first.record({ serverId: 'host-a', projectRoot: '/repos/solus' }, 'Solus')
    first.flush()

    const restarted = new ProjectsStore()
    expect(restarted.entries).toHaveLength(1)
    expect(restarted.entries[0]).toMatchObject({ serverId: 'host-a', projectRoot: '/repos/solus', label: 'Solus' })
  })

  test('removal persists too — a forgotten project does not come back after a restart', () => {
    const first = new ProjectsStore()
    first.record({ serverId: 'host-a', projectRoot: '/repos/solus' }, 'Solus')
    first.flush()
    first.remove({ serverId: 'host-a', projectRoot: '/repos/solus' })
    first.flush()

    const restarted = new ProjectsStore()
    expect(restarted.entries).toHaveLength(0)
  })

  test('passive host discovery does not restore an explicitly removed project', () => {
    const catalog = new ProjectsStore()
    const project = { serverId: 'host-a', projectRoot: '/repos/solus' }
    catalog.recordDiscovered(project, 'Solus')
    catalog.remove(project)

    catalog.recordDiscovered(project, 'Solus')

    expect(catalog.entries).toHaveLength(0)
  })

  test('the discovery exclusion persists, but opening the project restores it', () => {
    const project = { serverId: 'host-a', projectRoot: '/repos/solus' }
    const first = new ProjectsStore()
    first.recordDiscovered(project, 'Solus')
    first.remove(project)
    first.flush()

    const restarted = new ProjectsStore()
    restarted.recordDiscovered(project, 'Solus')
    expect(restarted.entries).toHaveLength(0)

    restarted.record(project, 'Solus')
    expect(restarted.entries).toHaveLength(1)
  })
})
