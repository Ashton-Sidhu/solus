import { afterAll, describe, expect, test } from 'bun:test'
import type { ManagedWorktree, ManagedWorktreeRemoveResult, ManagedWorktreeSize } from '@solus/contracts/types'
import { SvelteRunes } from './helpers/svelte-runes'
import {
  deleteConfirmText,
  statusCount,
  worktreeGroups,
  worktreeStatusText,
} from '@solus/workspace-ui/components/settings/lib/managed-worktrees'

// The store runs on Svelte's real client runtime, as in the app.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const { ManagedWorktreesStore }: typeof import('@solus/workspace-ui/components/settings/managed-worktrees.store.svelte') = await import(
  runes.source('managed-worktrees', 'packages/workspace-ui/src/components/settings/managed-worktrees.store.svelte.ts', {
    './lib/managed-worktrees': SvelteRunes.file('packages/workspace-ui/src/components/settings/lib/managed-worktrees.ts'),
    'svelte/reactivity': SvelteRunes.file('node_modules/svelte/src/reactivity/index-client.js'),
    '@solus/contracts/git-types': SvelteRunes.file('packages/contracts/src/git-types.ts'),
  })
)

const solus = { key: 'codebase:cb1', name: 'Solus', detail: 'solus + solus-cloud' }
const atlas = { key: 'project:/repos/atlas', name: 'atlas', detail: '/repos/atlas' }

const worktree = (overrides: Partial<ManagedWorktree> = {}): ManagedWorktree => ({
  path: '/repos/atlas/.git/solus/worktrees/fix-login',
  kind: 'worktree',
  group: atlas,
  title: 'Fix the login',
  branch: 'solus/fix-login',
  lastModified: 1_000,
  hasUncommittedWork: false,
  hasUnmergedCommits: false,
  sessions: [],
  ...overrides,
})

/** A host that lists `listed`, answers each removal with the next result, and measures each folder as 1 GB. */
function hostWith(listed: ManagedWorktree[], results: ManagedWorktreeRemoveResult[]) {
  const removals: { path: string; force: boolean | undefined }[] = []
  return {
    removals,
    api: {
      managedWorktreesList: async () => listed.map((each) => ({ ...each })),
      managedWorktreeRemove: async (path: string, options?: { force?: boolean }) => {
        removals.push({ path, force: options?.force })
        return results.shift() ?? { status: 'failed', error: 'no answer' }
      },
      managedWorktreeSizes: async (paths: string[]): Promise<ManagedWorktreeSize[]> => paths.map((path) => ({ path, bytes: 1024 ** 3 })),
    },
  }
}

describe('Solus worktrees in Settings', () => {
  test('forces a removal only when the row showed the work that is lost', async () => {
    // WHY: Delete loses unsaved work. The host forces the removal only after
    // the person saw that work in the confirmation.
    const store = new ManagedWorktreesStore()
    const host = hostWith([worktree()], [{ status: 'unsaved', hasUncommittedWork: true, hasUnmergedCommits: false }, { status: 'removed' }])
    await store.load(host.api)

    expect(await store.remove(host.api, store.worktrees[0])).toContain('Confirm again')
    expect(host.removals[0].force).toBe(false)
    // The row now shows the new work, so the next confirmation names it.
    expect(worktreeStatusText(store.worktrees[0])).toBe('Has uncommitted work')
    expect(deleteConfirmText(store.worktrees[0], 1024 ** 3)).toBe(
      'You lose its uncommitted work. The branch solus/fix-login is deleted. Frees 1.0 GB.',
    )

    expect(await store.remove(host.api, store.worktrees[0])).toBeNull()
    expect(host.removals[1].force).toBe(true)
    expect(store.worktrees).toEqual([])
  })

  test('keeps the row of a worktree that a session started to use', async () => {
    const store = new ManagedWorktreesStore()
    const sessions = [{ sessionId: 's1', title: 'Fix the login' }]
    const host = hostWith([worktree()], [{ status: 'in_use', sessions }])
    await store.load(host.api)

    expect(await store.remove(host.api, store.worktrees[0])).toContain('A session works')
    expect(worktreeStatusText(store.worktrees[0])).toBe('A session works here')
  })

  test('sizes arrive after the list, and a removal does not stop them', async () => {
    // WHY: a size walks a whole checkout. The list must not wait for it, and
    // deleting a row while sizes load must not leave the other rows empty.
    const store = new ManagedWorktreesStore()
    const paths = ['/a', '/b', '/c'].map((path) => `/repos/atlas/.git/solus/worktrees${path}`)
    const host = hostWith(paths.map((path) => worktree({ path })), [{ status: 'removed' }])
    await store.load(host.api)
    await store.remove(host.api, store.worktrees[0])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.sizes.get(paths[1])).toBe(1024 ** 3)
    expect(store.sizes.get(paths[2])).toBe(1024 ** 3)
  })
})

describe('the project and status filters', () => {
  const rows = [
    worktree({ path: '/1', group: solus, title: 'In use', sessions: [{ sessionId: 's', title: 'S' }] }),
    worktree({ path: '/2', group: solus, title: 'Unsaved', hasUnmergedCommits: true }),
    worktree({ path: '/3', group: solus, title: 'Safe' }),
    worktree({ path: '/4', group: atlas, title: 'Atlas unsaved', hasUncommittedWork: true }),
  ]

  test('groups by project, with what can go first in each group', () => {
    const groups = worktreeGroups(rows, 'all', 'all')
    expect(groups.map((view) => view.group.name)).toEqual(['Solus', 'atlas'])
    expect(groups[0].shown.map((each) => each.title)).toEqual(['Safe', 'Unsaved', 'In use'])
  })

  test('a status filter leaves out the groups with no match, and counts in the chosen project', () => {
    expect(worktreeGroups(rows, 'all', 'safe').map((view) => view.group.name)).toEqual(['Solus'])
    expect(worktreeGroups(rows, atlas.key, 'all').map((view) => view.group.name)).toEqual(['atlas'])
    expect(statusCount(rows, 'all', 'unsaved')).toBe(2)
    expect(statusCount(rows, solus.key, 'unsaved')).toBe(1)
  })

  test('a row says its state in plain words', () => {
    expect(rows.map(worktreeStatusText)).toEqual(['A session works here', 'Has unmerged commits', 'No unsaved work', 'Has uncommitted work'])
  })
})
