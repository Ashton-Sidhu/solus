import type {
  IpcContext,
  MergeMethod,
  MergeOrderMode,
  MergeQueueEntry,
  MergeQueueStartItem,
  MergeQueueStartOptions,
  MergeQueueState,
} from '../../shared/types'

/**
 * Renderer mirror of the main-process merge queue, plus the staged selection
 * ("queued" PR numbers) the user builds up before starting a run. Live state
 * arrives via the `merge-queue-update` topic (wired in App.svelte); `refresh`
 * pulls a snapshot for late joiners (page reopen, web reconnect).
 */
export class MergeQueueStore {
  /** PR numbers staged for the next run, in the order they were queued. */
  queued = $state<number[]>([])
  state = $state<MergeQueueState | null>(null)
  starting = $state(false)
  error = $state<string | null>(null)

  /** True while a run is in flight (merging or paused on conflicts). */
  get active(): boolean {
    return this.state?.status === 'running' || this.state?.status === 'waiting'
  }

  isQueued(number: number): boolean {
    return this.queued.includes(number)
  }

  /** This PR's entry in the current (or last finished) run, if any. */
  entryFor(number: number): MergeQueueEntry | null {
    return this.state?.entries.find((e) => e.number === number) ?? null
  }

  toggle(number: number): void {
    const idx = this.queued.indexOf(number)
    if (idx >= 0) this.queued.splice(idx, 1)
    else this.queued.push(number)
  }

  /** Move a staged PR by `offset` places (−1 up, +1 down) for manual ordering. */
  move(number: number, offset: number): void {
    const idx = this.queued.indexOf(number)
    const next = idx + offset
    if (idx < 0 || next < 0 || next >= this.queued.length) return
    this.queued.splice(idx, 1)
    this.queued.splice(next, 0, number)
  }

  apply(state: MergeQueueState): void {
    this.state = state
  }

  async refresh(ctx: IpcContext): Promise<void> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    const snapshot = await window.solus.mergeQueueState(safeCtx).catch(() => null)
    if (snapshot) this.state = snapshot
  }

  async start(ctx: IpcContext, items: MergeQueueStartItem[], order: MergeOrderMode, method: MergeMethod): Promise<void> {
    if (await this.begin(ctx, items, { order, method })) this.queued.length = 0
  }

  /** Merge one PR right away — a run of one — without touching the rest of the
   *  staged selection (only the merged PR leaves it). */
  async startSingle(ctx: IpcContext, item: MergeQueueStartItem, method: MergeMethod): Promise<void> {
    if (await this.begin(ctx, [item], { order: 'manual', method })) {
      const idx = this.queued.indexOf(item.number)
      if (idx >= 0) this.queued.splice(idx, 1)
    }
  }

  private async begin(ctx: IpcContext, items: MergeQueueStartItem[], options: MergeQueueStartOptions): Promise<boolean> {
    if (this.starting || this.active) return false
    this.starting = true
    this.error = null
    try {
      const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
      const result = await window.solus.mergeQueueStart(safeCtx, items, options)
      if (!result.success) this.error = result.error ?? 'Could not start the merge queue'
      return result.success
    } finally {
      this.starting = false
    }
  }

  async skip(ctx: IpcContext): Promise<void> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    await window.solus.mergeQueueSkip(safeCtx)
  }

  async cancel(ctx: IpcContext): Promise<void> {
    const safeCtx = JSON.parse(JSON.stringify(ctx)) as IpcContext
    await window.solus.mergeQueueCancel(safeCtx)
  }

  /** Dismiss a finished (done/cancelled) run from the panel. */
  clear(): void {
    if (!this.active) this.state = null
  }

  /** Failed entries of a finished run, mergeable again via re-queueing. */
  get failedNumbers(): number[] {
    if (this.active) return []
    return this.state?.entries.filter((e) => e.status === 'failed').map((e) => e.number) ?? []
  }

  /** Stage a finished run's failed entries back into the queue — retrying is
   *  just another run through the normal start path. */
  requeueFailed(): void {
    const failed = this.failedNumbers
    if (failed.length === 0) return
    for (const number of failed) {
      if (!this.queued.includes(number)) this.queued.push(number)
    }
    this.state = null
  }
}
