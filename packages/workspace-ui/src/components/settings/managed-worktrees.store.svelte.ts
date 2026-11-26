import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { managedWorktreeState, type ManagedWorktree } from '@solus/contracts/git-types'
import { keptBranchNotice } from './lib/managed-worktrees'

type WorktreesApi = Pick<HostApi, 'managedWorktreesList' | 'managedWorktreeRemove' | 'managedWorktreeSizes'>

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
  /** The path of the worktree being removed. */
  removing = $state<string | null>(null)
  private loadSequence = 0
  /** Only a new list stops the size reads: a removal does not. */
  private sizeSequence = 0

  async load(api: WorktreesApi): Promise<void> {
    const sequence = ++this.loadSequence
    this.loading = true
    this.error = ''
    try {
      const worktrees = await api.managedWorktreesList()
      if (sequence !== this.loadSequence) return
      this.worktrees = worktrees
      this.loaded = true
      void this.loadSizes(api, ++this.sizeSequence)
    } catch {
      if (sequence === this.loadSequence) this.error = 'Could not load the worktrees. Try again.'
    } finally {
      if (sequence === this.loadSequence) this.loading = false
    }
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

  /**
   * Remove a worktree and its branch. The unsaved work that the row showed is
   * what the person confirmed, so only then is the removal forced. Returns
   * null when the worktree is gone, else why it stays.
   */
  async remove(api: WorktreesApi, worktree: ManagedWorktree): Promise<string | null> {
    if (this.removing) return 'Another worktree is being deleted.'
    this.removing = worktree.path
    this.notice = ''
    try {
      const force = managedWorktreeState(worktree) === 'unsaved'
      const result = await api.managedWorktreeRemove(worktree.path, { force })
      // A load that started before the removal would show the worktree again.
      this.loadSequence++
      this.loading = false
      const index = this.worktrees.findIndex((each) => each.path === worktree.path)
      switch (result.status) {
        case 'removed':
          if (index !== -1) this.worktrees.splice(index, 1)
          this.sizes.delete(worktree.path)
          if (result.branchError) this.notice = keptBranchNotice(worktree, result.branchError)
          return null
        case 'unsaved':
          if (index !== -1) {
            this.worktrees[index].hasUncommittedWork = result.hasUncommittedWork
            this.worktrees[index].hasUnmergedCommits = result.hasUnmergedCommits
          }
          return 'It has new unsaved work. Confirm again to delete it.'
        case 'in_use':
          if (index !== -1) this.worktrees[index].sessions = result.sessions
          return 'A session works here now.'
        case 'failed':
          return result.error
      }
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not delete the worktree.'
    } finally {
      this.removing = null
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
