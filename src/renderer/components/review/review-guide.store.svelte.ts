import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { reviewGuideKeyFor, type ReviewGuideStatusEvent } from '../../../shared/review'
import { worktreeProjectRoot, type AgentId, type IpcContext, type ReasoningEffort, type Session } from '../../../shared/types'
import { serverConnections } from '@client-core/server-connections'
import type { HostEventSubscriber } from '@client-core/host-event-subscriber'

type SolusApi = typeof window.solus
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
  return {
    repoRoot: worktreeProjectRoot(environment.repoRoot),
    key: reviewGuideKeyFor(environment.branch, 'branch', null),
    ...(environment.status?.headSha ? { headSha: environment.status.headSha } : {}),
  }
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
  private statusesByApi = new SvelteMap<SolusApi, SvelteMap<string, ReviewGuideStatusEvent>>()
  private subscribedApis = new WeakSet<SolusApi>()
  private loadedTargetsByApi = new WeakMap<SolusApi, Map<string, string>>()
  private revisionsByApi = new WeakMap<SolusApi, Map<string, string>>()
  private readyListeners = new Set<ReadyListener>()
  private openedReadyEventsByApi = new SvelteMap<SolusApi, SvelteSet<string>>()

  constructor(
    private readonly eventsForApi: (api: SolusApi) => HostEventSubscriber = (api) => serverConnections.eventsForApi(api),
  ) {}

  private rememberRevision(api: SolusApi, identity: ReviewGuideIdentity): void {
    if (identity.revision === undefined) return
    let revisions = this.revisionsByApi.get(api)
    if (!revisions) {
      revisions = new Map()
      this.revisionsByApi.set(api, revisions)
    }
    revisions.set(statusKey(identity), identity.revision)
  }

  bind(api: SolusApi): void {
    if (this.subscribedApis.has(api)) return
    this.subscribedApis.add(api)
    this.eventsForApi(api).subscribe('review.guideStatusChanged', (event) => {
      const previous = this.statusesByApi.get(api)?.get(statusKey(event))
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
    let loadedTargets = this.loadedTargetsByApi.get(api)
    if (!loadedTargets) {
      loadedTargets = new Map()
      this.loadedTargetsByApi.set(api, loadedTargets)
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
        this.statusesByApi.get(api)?.delete(key)
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
    let statuses = this.statusesByApi.get(api)
    if (!statuses) {
      statuses = new SvelteMap()
      this.statusesByApi.set(api, statuses)
    }
    statuses.set(statusKey(event), event)
  }

  statusFor(
    api: SolusApi,
    identity: ReviewGuideIdentity | null,
  ): ReviewGuideStatusEvent | null {
    if (!identity) return null
    const event = this.statusesByApi.get(api)?.get(statusKey(identity)) ?? null
    if (event && identity.headSha && event.headSha !== identity.headSha) return null
    if (
      event &&
      identity.revision !== undefined &&
      this.revisionsByApi.get(api)?.get(statusKey(identity)) !== identity.revision
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
    return this.openedReadyEventsByApi.get(api)?.has(openedKey) ? null : event
  }

  markOpened(api: SolusApi, identity: ReviewGuideIdentity | null): void {
    const event = this.statusFor(api, identity)
    if (!event || event.status !== 'ready') return
    let opened = this.openedReadyEventsByApi.get(api)
    if (!opened) {
      opened = new SvelteSet()
      this.openedReadyEventsByApi.set(api, opened)
    }
    opened.add(`${statusKey(event)}::${event.updatedAt}`)
  }

  isRunningFor(api: SolusApi, session: Session | undefined): boolean {
    const status = this.statusFor(api, sessionGuideIdentity(session))?.status
    return status === 'queued' || status === 'generating'
  }
}

export const reviewGuideStore = new ReviewGuideStore()
