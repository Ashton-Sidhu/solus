import { createContext } from 'svelte'
import type { GitProjectStatus, IpcContext, WorktreeEntry } from '../../shared/types'

export interface GitProjectRefs {
  branches: string[]
  worktrees: WorktreeEntry[]
}

export class GitStatusStore {
  byCwd = $state<Record<string, GitProjectStatus | null>>({})
  refsByRoot = $state<Record<string, GitProjectRefs>>({})
  private inflight = new Map<string, Promise<boolean>>()
  private refsInflight = new Map<string, Promise<boolean>>()
  private lastRefresh = new Map<string, number>()
  private refsLastRefresh = new Map<string, number>()

  /** Resolves to true when the status fetch succeeded, false when it threw. */
  async refresh(cwd: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const now = Date.now()
    const last = this.lastRefresh.get(cwd) ?? 0
    if (!opts.force && now - last < 2_000) return true
    const existing = this.inflight.get(cwd)
    if (existing) return existing
    const promise = window.solus.gitProjectStatus(cwd)
      .then((status) => {
        this.byCwd[cwd] = status
        this.lastRefresh.set(cwd, Date.now())
        return true
      })
      .catch(() => {
        this.byCwd[cwd] = null
        this.lastRefresh.set(cwd, Date.now())
        return false
      })
      .finally(() => this.inflight.delete(cwd))
    this.inflight.set(cwd, promise)
    return promise
  }

  /** Land a status pushed from the main-process git watcher into the same store the panel reads. */
  set(cwd: string, status: GitProjectStatus | null): void {
    // The watcher re-broadcasts on every fs event, frequently with a byte-identical
    // status. Reassigning would invalidate every downstream $derived (branch bar,
    // file counts, badges) even when nothing changed, so skip the write when the
    // payload is structurally identical — but still refresh the throttle stamp.
    const prev = this.byCwd[cwd]
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(status)) {
      this.lastRefresh.set(cwd, Date.now())
      return
    }
    this.byCwd[cwd] = status
    this.lastRefresh.set(cwd, Date.now())
  }

  statusFor(cwd: string | null | undefined): GitProjectStatus | null | undefined {
    if (!cwd) return undefined
    return this.byCwd[cwd]
  }

  async refreshRefs(projectRoot: string, ctx: IpcContext, opts: { force?: boolean } = {}): Promise<boolean> {
    const now = Date.now()
    const last = this.refsLastRefresh.get(projectRoot) ?? 0
    if (!opts.force && now - last < 5_000) return true
    const existing = this.refsInflight.get(projectRoot)
    if (existing) return existing
    const promise = Promise.all([
      window.solus.worktreeListProject($state.snapshot(ctx)).catch(() => []),
      window.solus.worktreeBranches($state.snapshot(ctx)).catch(() => []),
    ])
      .then(([worktrees, branches]) => {
        this.refsByRoot[projectRoot] = { worktrees, branches }
        this.refsLastRefresh.set(projectRoot, Date.now())
        return true
      })
      .catch(() => {
        this.refsByRoot[projectRoot] = { worktrees: [], branches: [] }
        this.refsLastRefresh.set(projectRoot, Date.now())
        return false
      })
      .finally(() => this.refsInflight.delete(projectRoot))
    this.refsInflight.set(projectRoot, promise)
    return promise
  }

  refsFor(projectRoot: string | null | undefined): GitProjectRefs {
    if (!projectRoot) return { worktrees: [], branches: [] }
    return this.refsByRoot[projectRoot] ?? { worktrees: [], branches: [] }
  }
}

export const [getGitStatusStore, setGitStatusStore] = createContext<GitStatusStore>()
