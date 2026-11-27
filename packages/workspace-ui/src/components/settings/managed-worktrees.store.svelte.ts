import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import type { ManagedWorktree } from '@solus/contracts/git-types'
import type { HostDiskSpace } from '@solus/contracts/host-resources'
import { keptBranchNotice, removeConfirmedWorktrees, worktreeRemovalError } from '@solus/client-core/managed-worktrees'

export type WorktreeRemovalFailure = Pick<ManagedWorktree, 'path' | 'title'> & { error: string }

type WorktreesApi = Pick<HostApi, 'managedWorktreesList' | 'managedWorktreeRemove' | 'managedWorktreeSizes' | 'hostResources'>

/** Size reads at one time. Each one walks a whole checkout on the host. */
const SIZE_READS = 2

/** The worktrees and task folders that Solus made on one host, for Settings. */
export class ManagedWorktreesStore {
  worktrees = $state<ManagedWorktree[]>([])
  /** Bytes on disk by path. Absent while the host measures it; null when it could not. */
  readonly sizes = new SvelteMap<string, number | null>()
  loading = $state(false)
  loaded = $state(false)
  error = $state('')
  /** A removal that kept the branch: the folder is gone, the branch stays. */
  notice = $state('')
  isRemoving = $state(false)
  /** The paths of a removal in its order: the first is being deleted, the rest wait. */
  removalQueue = $state<string[]>([])
  /** The free space on the host's disk. Null until read, or when the host cannot say. */
  disk = $state<HostDiskSpace | null>(null)
  private loadSequence = 0
  /** Only a new list stops the size reads: a removal does not. */
  private sizeSequence = 0

  async load(api: WorktreesApi): Promise<void> {
    if (this.isRemoving) return
    const sequence = ++this.loadSequence
    this.loading = true
    this.error = ''
    try {
      const worktrees = await api.managedWorktreesList()
      if (sequence !== this.loadSequence) return
      this.worktrees = worktrees
      this.loaded = true
      void this.loadSizes(api, ++this.sizeSequence)
      void this.loadDisk(api, sequence)
    } catch {
      if (sequence === this.loadSequence) this.error = 'Could not load the worktrees. Try again.'
    } finally {
      if (sequence === this.loadSequence) this.loading = false
    }
  }

  /** Read with the list. A removal answers with a fresh read, so the gain shows at once. */
  private async loadDisk(api: WorktreesApi, sequence: number): Promise<void> {
    const resources = await api.hostResources().catch(() => null)
    if (sequence === this.loadSequence) this.disk = resources?.disk ?? null
  }

  /** The list shows first; each size arrives when the host has measured it. */
  private async loadSizes(api: WorktreesApi, sequence: number): Promise<void> {
    const queue = this.worktrees.map((worktree) => worktree.path).filter((path) => !this.sizes.has(path))
    const read = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        if (sequence !== this.sizeSequence) return
        const [size] = await api.managedWorktreeSizes([path]).catch(() => [{ path, bytes: null }])
        if (sequence === this.sizeSequence) this.sizes.set(path, size?.bytes ?? null)
      }
    }
    await Promise.all(Array.from({ length: SIZE_READS }, read))
  }

  /** Where a worktree is in the running removal, for its row. */
  removalOf(path: string): 'deleting' | 'waiting' | null {
    const at = this.removalQueue.indexOf(path)
    return at === -1 ? null : at === 0 ? 'deleting' : 'waiting'
  }

  /** Null when the worktree is gone, else why it stays. */
  async remove(api: WorktreesApi, worktree: ManagedWorktree): Promise<string | null> {
    const [failure] = await this.removeMany(api, [worktree])
    return failure?.error ?? null
  }

  async removeMany(api: WorktreesApi, worktrees: readonly ManagedWorktree[]): Promise<WorktreeRemovalFailure[]> {
    if (this.isRemoving) {
      return worktrees.map(({ path, title }) => ({ path, title, error: 'Another worktree is being deleted.' }))
    }
    this.isRemoving = true
    this.removalQueue = worktrees.map((worktree) => worktree.path)
    this.notice = ''
    // A load that started before the removal could show a deleted worktree again.
    this.loadSequence++
    this.loading = false
    const failures: WorktreeRemovalFailure[] = []
    const notices: string[] = []
    try {
      for await (const { worktree, result } of removeConfirmedWorktrees(api, worktrees)) {
        const queued = this.removalQueue.indexOf(worktree.path)
        if (queued !== -1) this.removalQueue.splice(queued, 1)
        const index = this.worktrees.findIndex((each) => each.path === worktree.path)
        if (result.status === 'removed') {
          if (index !== -1) this.worktrees.splice(index, 1)
          this.sizes.delete(worktree.path)
          if (result.disk !== undefined) this.disk = result.disk
          if (result.branchError) notices.push(keptBranchNotice(worktree, result.branchError))
        } else {
          const current = this.worktrees[index]
          if (current && result.status === 'unsaved') {
            current.hasUncommittedWork = result.hasUncommittedWork
            current.hasUnmergedCommits = result.hasUnmergedCommits
          }
          if (current && result.status === 'in_use') current.sessions = result.sessions
          failures.push({ path: worktree.path, title: worktree.title, error: worktreeRemovalError(result) })
        }
      }
      return failures
    } finally {
      this.notice = notices.join('\n')
      this.removalQueue = []
      this.isRemoving = false
    }
  }
}

// Stable host lookup cache; only the state inside each store is reactive.
const stores = new Map<string, ManagedWorktreesStore>()
export function managedWorktreesForHost(serverId: string): ManagedWorktreesStore {
  let store = stores.get(serverId)
  if (!store) {
    store = new ManagedWorktreesStore()
    stores.set(serverId, store)
  }
  return store
}
