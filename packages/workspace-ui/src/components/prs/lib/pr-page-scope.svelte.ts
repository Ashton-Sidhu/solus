/**
 * Which pull requests the page reads, and through which host.
 *
 * The page owns its scope (docs/plans/project-model.md §5): one project and the
 * one checkout its pull requests are read through, or every project. The tab in
 * focus never sets it. Both scopes are the same list.
 *
 * A project's pull requests are read through a host with its checkout. The
 * Solus API is never that host: it serves records, not repositories
 * (docs/plans/workspace-and-machines.md).
 *
 * Constructed during a component's setup; every answer is reactive.
 */
import { hostKey } from '@solus/client-core/host-key'
import { serverConnections } from '@solus/client-core/server-connections'
import type { IpcContext } from '@solus/contracts/types'
import { serversStore, type SurfaceContext } from '../../../contexts'
import type { PrProject } from '../../../contexts/prs/prs.store.svelte'
import { prProjectTargets } from './pr-cross-project'
import { isSolusApiId } from '@solus/contracts/uplink'

export class PrPageScope {
  constructor(private readonly session: SurfaceContext) {}

  /** The scoped project's key, or null across every project. */
  readonly pageKey = $derived.by(() => {
    const scope = this.session.projectPageScope
    return scope.kind === 'project' ? scope.key : null
  })
  private readonly checkout = $derived.by(() => {
    const scope = this.session.projectPageScope
    return scope.kind === 'project' ? scope.checkout : null
  })
  readonly allProjects = $derived.by(() => !this.pageKey)
  /** One row per project, never one per host. */
  readonly projectOptions = $derived.by(() => this.session.projectScopeOptions)

  /** The one project's path on its checkout's host. */
  readonly projectPath = $derived.by(() => this.checkout?.projectRoot ?? null)
  /** The host the one project reads through. Null when nothing is connected to
   *  read from: a host is a precondition for loading, not something to assume. */
  readonly serverId = $derived.by(() => this.checkout?.serverId ?? null)
  readonly api = $derived.by(() => (this.serverId ? serverConnections.apiFor(this.serverId) : null))
  /** The one project's identity; empty with none. */
  readonly scopeKey = $derived.by(
    () => (this.serverId && this.projectPath ? hostKey(this.serverId, this.projectPath) : ''),
  )

  ctx(): IpcContext {
    return this.projectPath ? this.session.ctxForDirectory(this.projectPath) : this.session.ctx
  }

  /** Every project the every-project list can read right now. */
  readonly projectTargets = $derived.by<PrProject[]>(() =>
    prProjectTargets(this.projectOptions, {
      isOnlineCheckout: (serverId) =>
        !isSolusApiId(serverId) && serversStore.statusFor(serverId) === 'online',
      apiFor: (serverId) => serverConnections.apiFor(serverId),
      ctxFor: (projectRoot) => this.session.ctxForDirectory(projectRoot),
    }),
  )
  /** Which projects are reachable, as one key: hosts finish dialing and drop
   *  while the page is open, and the every-project read follows that set. */
  readonly reachableKey = $derived.by(() =>
    this.projectTargets.map((project) => `${project.serverId}\0${project.projectRoot}`).join('\n'),
  )
}
