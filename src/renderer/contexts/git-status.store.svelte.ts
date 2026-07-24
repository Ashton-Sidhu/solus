import { createContext } from 'svelte'
import type { GitProjectStatus, IpcContext, WorktreeEntry } from '../../shared/types'
import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID } from '@client-core/server-registry'

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
  private detailsLastRefresh = new Map<string, number>()
  private refsLastRefresh = new Map<string, number>()
  private detailWatchers = new Map<string, number>()
  private detailRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private serverByCwd = new Map<string, string>()

  bindCwd(cwd: string | null | undefined, serverId: string): void {
    if (cwd && cwd !== '~') this.serverByCwd.set(cwd, serverId)
  }

  private apiForCwd(cwd: string): typeof window.solus {
    return serverConnections.apiFor(this.serverByCwd.get(cwd) ?? LOCAL_SERVER_ID) as typeof window.solus
  }

  /** Resolves to true when the status fetch succeeded, false when it threw. */
  async refresh(cwd: string, opts: { force?: boolean; details?: boolean } = {}): Promise<boolean> {
    const includeDetails = opts.details === true
    const now = Date.now()
    const refreshTimes = includeDetails ? this.detailsLastRefresh : this.lastRefresh
    const last = refreshTimes.get(cwd) ?? 0
    if (!opts.force && now - last < 2_000) return true
    const inflightKey = `${cwd}\0${includeDetails ? 'details' : 'summary'}`
    const existing = this.inflight.get(inflightKey)
    if (existing) return existing
    const promise = this.apiForCwd(cwd).gitProjectStatus(cwd, includeDetails ? { includeDetails: true } : undefined)
      .then((status) => {
        this.applyStatus(cwd, status, includeDetails)
        this.lastRefresh.set(cwd, Date.now())
        if (includeDetails) this.detailsLastRefresh.set(cwd, Date.now())
        else this.scheduleDetailsRefresh(cwd)
        return true
      })
      .catch(() => {
        // A probe failure says nothing about whether the checkout is still a
        // repository. Preserve the last known status and leave the throttle
        // unstamped so the next lifecycle trigger can retry promptly.
        return false
      })
      .finally(() => this.inflight.delete(inflightKey))
    this.inflight.set(inflightKey, promise)
    return promise
  }

  /** Land a status pushed from the main-process git watcher into the same store the panel reads. */
  set(cwd: string, status: GitProjectStatus | null): void {
    // The watcher re-broadcasts on every fs event, frequently with a byte-identical
    // status. Reassigning would invalidate every downstream $derived (branch bar,
    // file counts, badges) even when nothing changed, so skip the write when the
    // payload is structurally identical — but still refresh the throttle stamp.
    const prev = this.byCwd[cwd]
    const next = this.statusWithVisibleDetails(cwd, status)
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(next)) {
      this.lastRefresh.set(cwd, Date.now())
      this.scheduleDetailsRefresh(cwd)
      return
    }
    this.byCwd[cwd] = next
    this.lastRefresh.set(cwd, Date.now())
    this.scheduleDetailsRefresh(cwd)
  }

  /** Keep expensive statistics live only while a visible Git section needs them. */
  watchDetails(cwd: string): () => void {
    this.detailWatchers.set(cwd, (this.detailWatchers.get(cwd) ?? 0) + 1)
    void this.refresh(cwd, { force: true, details: true })
    return () => {
      const remaining = (this.detailWatchers.get(cwd) ?? 1) - 1
      if (remaining > 0) {
        this.detailWatchers.set(cwd, remaining)
        return
      }
      this.detailWatchers.delete(cwd)
      const timer = this.detailRefreshTimers.get(cwd)
      if (timer) clearTimeout(timer)
      this.detailRefreshTimers.delete(cwd)
    }
  }

  private applyStatus(cwd: string, status: GitProjectStatus | null, includeDetails: boolean): void {
    const current = this.byCwd[cwd]
    if (includeDetails) {
      // A watcher summary may have landed while the slower numstat/PR request
      // was running. Never replace that newer branch/file state with the
      // snapshot bundled into the detail response; merge only expensive fields
      // when it still describes the same checkout.
      if (!status || current === null) return
      if (current && (current.repoRoot !== status.repoRoot || current.branch !== status.branch)) return
      const next = current
        ? {
            ...current,
            insertions: status.insertions,
            deletions: status.deletions,
            prUrl: status.prUrl,
          }
        : status
      if (JSON.stringify(current) !== JSON.stringify(next)) this.byCwd[cwd] = next
      return
    }

    const next = this.statusWithVisibleDetails(cwd, status)
    if (JSON.stringify(this.byCwd[cwd]) !== JSON.stringify(next)) this.byCwd[cwd] = next
  }

  /** Preserve the currently displayed details during the short summary→detail
   *  refresh gap. They are only retained when a visible consumer guarantees a
   *  trailing detailed refresh, and only while the branch stays the same. */
  private statusWithVisibleDetails(cwd: string, status: GitProjectStatus | null): GitProjectStatus | null {
    const previous = this.byCwd[cwd]
    if (!status || !previous || !this.detailWatchers.has(cwd) || previous.branch !== status.branch) return status
    return {
      ...status,
      insertions: previous.insertions,
      deletions: previous.deletions,
      ...(previous.prUrl ? { prUrl: previous.prUrl } : {}),
    }
  }

  private scheduleDetailsRefresh(cwd: string): void {
    if (!this.detailWatchers.has(cwd) || this.detailRefreshTimers.has(cwd)) return
    const timer = setTimeout(() => {
      this.detailRefreshTimers.delete(cwd)
      if (this.detailWatchers.has(cwd)) void this.refresh(cwd, { force: true, details: true })
    }, 150)
    this.detailRefreshTimers.set(cwd, timer)
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
    const api = this.apiForCwd(projectRoot)
    const promise = Promise.all([
      api.worktreeListProject($state.snapshot(ctx)).catch(() => []),
      api.worktreeBranches($state.snapshot(ctx)).catch(() => []),
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
