import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { reviewGuideKeyFor, type ReviewGuideStatusEvent } from '@solus/contracts/review'
import { worktreeProjectRoot, type AgentId, type IpcContext, type ReasoningEffort, type Session } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostApi } from '@solus/client-core/host-api'

type SolusApi = HostApi
type ReviewScope = 'branch' | 'session'
type ReadyListener = (api: SolusApi, event: ReviewGuideStatusEvent) => void

export interface ReviewGuideIdentity {
  repoRoot: string
  key: string
  /** Present when the renderer already knows the checkout HEAD. */
  headSha?: string
  /** Renderer-known change-set identity. A ready guide is hidden once the
   * working tree or session file set moves beyond the snapshot it covered. */
  revision?: string
}

export interface ReviewGuideRequest {
  agent?: AgentId
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  scope: ReviewScope
}

export function branchGuideIdentity(environment: {
  repoRoot: string | null
  branch: string | null
  status?: { headSha: string } | null
}): ReviewGuideIdentity | null {
  if (!environment.repoRoot || !environment.branch) return null
  const identity: ReviewGuideIdentity = {
    repoRoot: worktreeProjectRoot(environment.repoRoot),
    key: reviewGuideKeyFor(environment.branch, 'branch', null),
  }
  if (environment.status?.headSha) identity.headSha = environment.status.headSha
  return identity
}

export function sessionGuideIdentity(
  session: Session | undefined,
): ReviewGuideIdentity | null {
  const repoRoot = session?.run.gitContext?.repoRoot
  const sessionId = session?.agentSessionId
  return repoRoot && sessionId
    ? { repoRoot: worktreeProjectRoot(repoRoot), key: reviewGuideKeyFor('', 'session', sessionId) }
    : null
}

function statusKey(identity: Pick<ReviewGuideIdentity, 'repoRoot' | 'key'>): string {
  return `${identity.repoRoot}::${identity.key}`
}

/** Review-guide generation state shared by every mounted surface. Components
 * may unmount while a guide is queued or generating; the store remains bound
 * to the host API and receives the eventual ready/failed event. */
export class ReviewGuideStore {
  private statusesByServer = new SvelteMap<string, SvelteMap<string, ReviewGuideStatusEvent>>()
  private subscribedApis = new WeakSet<SolusApi>()
  private loadedTargetsByServer = new Map<string, Map<string, string>>()
  private revisionsByServer = new Map<string, Map<string, string>>()
  private readyListeners = new Set<ReadyListener>()
  private openedReadyEventsByServer = new SvelteMap<string, SvelteSet<string>>()

  constructor(
    private readonly eventsForApi: (api: SolusApi) => HostEventSubscriber = (api) => serverConnections.eventsForApi(api),
    private readonly serverIdForApi: (api: SolusApi) => string = (api) => serverConnections.serverIdForApi(api),
  ) {}

  private rememberRevision(api: SolusApi, identity: ReviewGuideIdentity): void {
    if (identity.revision === undefined) return
    const serverId = this.serverIdForApi(api)
    let revisions = this.revisionsByServer.get(serverId)
    if (!revisions) {
      revisions = new Map()
      this.revisionsByServer.set(serverId, revisions)
    }
    revisions.set(statusKey(identity), identity.revision)
  }

  bind(api: SolusApi): void {
    if (this.subscribedApis.has(api)) return
    this.subscribedApis.add(api)
    const serverId = this.serverIdForApi(api)
    this.eventsForApi(api).subscribe('review.guideStatusChanged', (event) => {
      const previous = this.statusesByServer.get(serverId)?.get(statusKey(event))
      this.set(api, event)
      if (event.status === 'ready' && previous?.status !== 'ready') {
        for (const listener of this.readyListeners) listener(api, event)
      }
    })
  }

  /** Observe guides that become ready through a live host event. Cached status
   * probes deliberately do not notify: reopening Solus must not replay old
   * completion toasts. */
  onReady(listener: ReadyListener): () => void {
    this.readyListeners.add(listener)
    return () => this.readyListeners.delete(listener)
  }

  async load(
    api: SolusApi,
    ctx: IpcContext,
    identity: ReviewGuideIdentity,
    scope: ReviewScope,
  ): Promise<void> {
    this.bind(api)
    const serverId = this.serverIdForApi(api)
    let loadedTargets = this.loadedTargetsByServer.get(serverId)
    if (!loadedTargets) {
      loadedTargets = new Map()
      this.loadedTargetsByServer.set(serverId, loadedTargets)
    }

    const key = statusKey(identity)
    const targetVersion = `${identity.headSha ?? ''}::${identity.revision ?? ''}`
    if (loadedTargets.get(key) === targetVersion) return
    loadedTargets.set(key, targetVersion)
    this.rememberRevision(api, identity)

    try {
      const event = await api.reviewGuideStatus(ctx, { scope })
      // A newer load for the same stable guide key owns the entry now. Keep
      // this response under its original target instead of letting it replace
      // the newer checkout/revision state.
      if (loadedTargets.get(key) !== targetVersion) return
      if (
        event &&
        event.repoRoot === identity.repoRoot &&
        event.key === identity.key &&
        (!identity.headSha || event.headSha === identity.headSha)
      ) {
        this.set(api, event)
      } else {
        this.statusesByServer.get(serverId)?.delete(key)
      }
    } catch {
      if (loadedTargets.get(key) === targetVersion) loadedTargets.delete(key)
    }
  }

  async generate(
    api: SolusApi,
    ctx: IpcContext,
    identity: ReviewGuideIdentity,
    request: ReviewGuideRequest,
  ): Promise<void> {
    this.bind(api)
    this.rememberRevision(api, identity)
    const event = await api.requestReviewGuide(ctx, request)
    if (
      event &&
      event.repoRoot === identity.repoRoot &&
      event.key === identity.key
    ) {
      this.set(api, event)
    }
  }

  async cancel(
    api: SolusApi,
    ctx: IpcContext,
    scope: ReviewScope,
  ): Promise<void> {
    await api.cancelGenerateGuide(ctx, { scope })
  }

  set(api: SolusApi, event: ReviewGuideStatusEvent): void {
    const serverId = this.serverIdForApi(api)
    let statuses = this.statusesByServer.get(serverId)
    if (!statuses) {
      statuses = new SvelteMap()
      this.statusesByServer.set(serverId, statuses)
    }
    statuses.set(statusKey(event), event)
  }

  statusFor(
    api: SolusApi,
    identity: ReviewGuideIdentity | null,
  ): ReviewGuideStatusEvent | null {
    if (!identity) return null
    const serverId = this.serverIdForApi(api)
    const event = this.statusesByServer.get(serverId)?.get(statusKey(identity)) ?? null
    if (event && identity.headSha && event.headSha !== identity.headSha) return null
    if (
      event &&
      identity.revision !== undefined &&
      this.revisionsByServer.get(serverId)?.get(statusKey(identity)) !== identity.revision
    ) return null
    return event
  }

  /** Status presented in navigation. A ready mark is an unread affordance: it
   * disappears after that exact generated guide has been opened, while the
   * durable ready status remains available to the review action itself. */
  indicatorStatusFor(
    api: SolusApi,
    identity: ReviewGuideIdentity | null,
  ): ReviewGuideStatusEvent | null {
    const event = this.statusFor(api, identity)
    if (!event || event.status !== 'ready') return event
    const openedKey = `${statusKey(event)}::${event.updatedAt}`
    return this.openedReadyEventsByServer.get(this.serverIdForApi(api))?.has(openedKey) ? null : event
  }

  markOpened(api: SolusApi, identity: ReviewGuideIdentity | null): void {
    const event = this.statusFor(api, identity)
    if (!event || event.status !== 'ready') return
    const serverId = this.serverIdForApi(api)
    let opened = this.openedReadyEventsByServer.get(serverId)
    if (!opened) {
      opened = new SvelteSet()
      this.openedReadyEventsByServer.set(serverId, opened)
    }
    opened.add(`${statusKey(event)}::${event.updatedAt}`)
  }

  isRunningFor(api: SolusApi, session: Session | undefined): boolean {
    const status = this.statusFor(api, sessionGuideIdentity(session))?.status
    return status === 'queued' || status === 'generating'
  }
}

export const reviewGuideStore = new ReviewGuideStore()
