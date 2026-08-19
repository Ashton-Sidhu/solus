import { SvelteMap } from 'svelte/reactivity'
import type { IpcContext } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import type { PrsStore } from '../../../../contexts/prs/prs.store.svelte'
import type { LinkedPrLifecycle } from './task-prs'

/**
 * Live lifecycle for the pull requests a task links.
 *
 * A task link stores only the number and a link-time title: PR state is a
 * provider round trip, and the host deliberately keeps it off the task read so
 * opening a task is never network-bound. The renderer overlays it instead, from
 * here — and never from the PRs page's own list, which belongs to whichever
 * project that page is showing and may be a different one entirely.
 *
 * Reads go through `PrsStore`, so a project the user already has open costs
 * nothing: the list page it loaded is the same cache entry this asks for. A PR
 * old enough to have fallen off that page is read individually, once. A PR that
 * resolves to neither stays unknown, and the row renders without a state rather
 * than guessing that it is open.
 */
export class LinkedPrsStore {
  private readonly lifecycleByKey = new SvelteMap<string, LinkedPrLifecycle>()
  /** Scopes whose list page has been asked for, so a re-render does not re-ask. */
  private readonly loadedScopes = new Set<string>()
  private readonly loadedNumbers = new Set<string>()

  constructor(private readonly prs: PrsStore) {}

  private key(serverId: string, projectRoot: string, number: number): string {
    return `${serverId}::${projectRoot}::${number}`
  }

  lifecycleFor(
    serverId: string | null | undefined,
    projectRoot: string | null | undefined,
    number: number,
  ): LinkedPrLifecycle | null {
    if (!serverId || !projectRoot) return null
    return this.lifecycleByKey.get(this.key(serverId, projectRoot, number)) ?? null
  }

  /** Fill in whatever is still unknown for these PRs. Safe to call on every
   *  render: each scope's list is asked for once, and each PR at most once. */
  ensure(
    scope: { api: HostApi; serverId: string; projectRoot: string; ctx: IpcContext },
    numbers: number[],
  ): void {
    const wanted = numbers.filter((number) => number > 0)
    if (!wanted.length) return
    const scopeKey = `${scope.serverId}::${scope.projectRoot}`
    if (this.loadedScopes.has(scopeKey)) {
      void this.loadIndividually(scope, wanted)
      return
    }
    this.loadedScopes.add(scopeKey)
    void this.loadScope(scope, wanted)
  }

  private async loadScope(
    scope: { api: HostApi; serverId: string; projectRoot: string; ctx: IpcContext },
    numbers: number[],
  ): Promise<void> {
    try {
      const page = await this.prs.loadFor(scope.api, scope.serverId, scope.ctx, { state: 'all' })
      for (const item of page.items) {
        this.lifecycleByKey.set(
          this.key(scope.serverId, scope.projectRoot, item.number),
          { state: item.state, draft: item.draft },
        )
      }
    } catch {
      // A project with no provider, or an unreachable one, simply has no PR
      // state to overlay. The rows still render from their link snapshot.
    }
    await this.loadIndividually(scope, numbers)
  }

  private async loadIndividually(
    scope: { api: HostApi; serverId: string; projectRoot: string; ctx: IpcContext },
    numbers: number[],
  ): Promise<void> {
    for (const number of numbers) {
      const key = this.key(scope.serverId, scope.projectRoot, number)
      if (this.lifecycleByKey.has(key) || this.loadedNumbers.has(key)) continue
      this.loadedNumbers.add(key)
      try {
        const detail = await this.prs.loadDetail(scope.api, scope.serverId, scope.ctx, number)
        this.lifecycleByKey.set(key, { state: detail.state, draft: detail.draft })
      } catch {
        // Deleted, private, or on a repo this host cannot read.
      }
    }
  }
}
