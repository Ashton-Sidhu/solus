import { createContext } from 'svelte'
import type { GitProjectStatus } from '../../shared/types'

export class GitStatusStore {
  byCwd = $state<Record<string, GitProjectStatus | null>>({})
  private inflight = new Map<string, Promise<boolean>>()
  private lastRefresh = new Map<string, number>()

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
    this.byCwd[cwd] = status
    this.lastRefresh.set(cwd, Date.now())
  }

  statusFor(cwd: string | null | undefined): GitProjectStatus | null | undefined {
    if (!cwd) return undefined
    return this.byCwd[cwd]
  }
}

export const [getGitStatusStore, setGitStatusStore] = createContext<GitStatusStore>()
