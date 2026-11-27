import { afterAll, describe, expect, test } from 'bun:test'
import type { ManagedWorktree, ManagedWorktreeRemoveResult, ManagedWorktreeSize } from '@solus/contracts/types'
import type { HostResources } from '@solus/contracts/host-resources'
import { deleteConfirmText, worktreeStatusText } from '@solus/client-core/managed-worktrees'
import { SvelteRunes } from './helpers/svelte-runes'
import {
  deleteSummaryText,
  projectFilterOptions,
  statusFilterOptions,
  statusCount,
  worktreeGroups,
} from '@solus/workspace-ui/components/settings/lib/managed-worktrees'

// The store runs on Svelte's real client runtime, as in the app.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const { ManagedWorktreesStore }: typeof import('@solus/workspace-ui/components/settings/managed-worktrees.store.svelte') = await import(
  runes.source('managed-worktrees', 'packages/workspace-ui/src/components/settings/managed-worktrees.store.svelte.ts', {
    '@solus/client-core/managed-worktrees': SvelteRunes.file('packages/client-core/src/managed-worktrees.ts'),
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
  sessionId: null,
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
      hostResources: async (): Promise<HostResources> => ({
        sampledAt: 1, cpuUtilization: 0, cpuCount: 1, availableMemoryBytes: 1, totalMemoryBytes: 2,
        disk: { availableBytes: 10 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
      }),
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

  test('the free disk space shows the gain of a removal at once', async () => {
    // WHY: the host caches its resource read for a few seconds. The removal
    // answers with a fresh read, so the number the person watches goes up now.
    const store = new ManagedWorktreesStore()
    const freed = { availableBytes: 13 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }
    const host = hostWith([worktree()], [{ status: 'removed', disk: freed }])
    await store.load(host.api)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.disk?.availableBytes).toBe(10 * 1024 ** 3)

    await store.remove(host.api, store.worktrees[0])
    expect(store.disk).toEqual(freed)
  })

  test('keeps the row of a worktree that a session started to use', async () => {
    const store = new ManagedWorktreesStore()
    const sessions = [{ sessionId: 's1', title: 'Fix the login', isBusy: true }]
    const host = hostWith([worktree()], [{ status: 'in_use', sessions }])
    await store.load(host.api)

    expect(await store.remove(host.api, store.worktrees[0])).toContain('A session works')
    expect(worktreeStatusText(store.worktrees[0])).toBe('A turn is running')
  })

  test('a batch continues past a refusal and only forces the work the user confirmed', async () => {
    const store = new ManagedWorktreesStore()
    const clean = worktree({ path: '/clean' })
    const changed = worktree({ path: '/changed', title: 'Changed after confirmation' })
    const unsaved = worktree({ path: '/unsaved', hasUnmergedCommits: true })
    const host = hostWith([clean, changed, unsaved], [
      { status: 'removed', branchError: 'branch is checked out elsewhere' },
      { status: 'unsaved', hasUncommittedWork: true, hasUnmergedCommits: false },
      { status: 'removed', branchError: 'branch could not be locked' },
    ])
    await store.load(host.api)

    const deleting = store.removeMany(host.api, [clean, changed, unsaved])
    expect(await store.remove(host.api, unsaved)).toContain('being deleted')
    expect(await deleting).toEqual([{ path: changed.path, title: changed.title, error: expect.stringContaining('Confirm again') }])
    expect(host.removals).toEqual([
      { path: clean.path, force: false },
      { path: changed.path, force: false },
      { path: unsaved.path, force: true },
    ])
    expect(store.worktrees.map((row) => row.path)).toEqual([changed.path])
    expect(worktreeStatusText(store.worktrees[0])).toBe('Has uncommitted work')
    expect(store.notice).toContain('branch is checked out elsewhere')
    expect(store.notice).toContain('branch could not be locked')
  })

  test('each row of a batch says whether it is being deleted or waits', async () => {
    // WHY: a batch deletes one worktree at a time and each can take seconds.
    // Without a word on the row, the user sees nothing happen after Delete.
    const store = new ManagedWorktreesStore()
    const first = worktree({ path: '/first' })
    const second = worktree({ path: '/second' })
    const answers: Array<(result: ManagedWorktreeRemoveResult) => void> = []
    const host = hostWith([first, second], [])
    const api = { ...host.api, managedWorktreeRemove: () => new Promise<ManagedWorktreeRemoveResult>((resolve) => answers.push(resolve)) }
    await store.load(api)
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

    const deleting = store.removeMany(api, [first, second])
    expect([store.removalOf(first.path), store.removalOf(second.path)]).toEqual(['deleting', 'waiting'])
    await tick()
    answers.shift()?.({ status: 'removed' })
    await tick()
    expect([store.removalOf(first.path), store.removalOf(second.path)]).toEqual([null, 'deleting'])
    answers.shift()?.({ status: 'failed', error: 'locked' })
    await deleting
    expect(store.removalOf(second.path)).toBeNull()
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
    worktree({ path: '/1', group: solus, title: 'In use', sessions: [{ sessionId: 's', title: 'S', isBusy: true }] }),
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

  test('the Filters menu offers each project and each status, with counts', () => {
    expect(projectFilterOptions(rows)).toEqual([
      { value: 'all', label: 'All projects', count: 4 },
      { value: solus.key, label: 'Solus', count: 3 },
      { value: atlas.key, label: 'atlas', count: 1 },
    ])
    expect(statusFilterOptions(rows, solus.key).map((option) => [option.label, option.count])).toEqual([
      ['All', 3], ['Safe to delete', 1], ['Unsaved work', 1], ['In use', 1],
    ])
  })

  test('a row says its state in plain words', () => {
    expect(rows.map(worktreeStatusText)).toEqual(['A turn is running', 'Has unmerged commits', 'No unsaved work', 'Has uncommitted work'])
  })

  test('an idle session does not block Delete, and the confirmation names it', () => {
    const open = worktree({ sessions: [{ sessionId: 's', title: 'Add Antigravity Provider', isBusy: false }] })
    expect(worktreeStatusText(open)).toBe('No unsaved work')
    expect(deleteConfirmText(open, null)).toBe(
      'No work is lost. “Add Antigravity Provider” is open. It loses its working folder; its conversation stays. The branch solus/fix-login is deleted.',
    )
  })

  test('the Delete dialog says in one place what is lost, what stays, and what it frees', () => {
    const sizes = new Map([['/2', 2 * 1024 ** 3], ['/3', 1024 ** 3]])
    const safe = rows[2]
    const open = worktree({ path: '/5', sessions: [{ sessionId: 's', title: 'S', isBusy: false }] })
    expect(deleteSummaryText([safe], sizes)).toBe('No work is lost. Its branch is deleted. Frees 1.0 GB.')
    expect(deleteSummaryText([rows[1], safe, open], sizes)).toBe(
      'The unsaved work in 1 of them is lost. Their branches are deleted. Open sessions keep their conversations. Frees 3.0 GB.',
    )
  })
})
