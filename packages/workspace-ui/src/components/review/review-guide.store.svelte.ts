import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { reviewGuideKeyFor, reviewGuideKeyForTarget, reviewGuideTargetId, type ReviewGuideStatusEvent, type ReviewTarget } from '@solus/contracts/review'
import type { PrReviewTarget } from '@solus/contracts/providers'
import { worktreeProjectRoot, type AgentId, type IpcContext, type ReasoningEffort, type Session } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostApi } from '@solus/client-core/host-api'
import type { ConnectionStatus } from '@solus/client-core/ws-transport'

type SolusApi = HostApi
type ReviewScope = 'branch' | 'session'
type ReadyListener = (serverId: string, event: ReviewGuideStatusEvent) => void
type ConnectionListener = (serverId: string, status: ConnectionStatus, attempt: number) => void

interface TrackedGuide {
  api: HostApi
  ctx: IpcContext
  identity: ReviewGuideIdentity
  scope: ReviewScope | ReviewTarget
}

export function prGuideTarget(pr: Pick<PrReviewTarget, 'host' | 'owner' | 'repo' | 'number' | 'headSha' | 'baseSha'>): Extract<ReviewTarget, { kind: 'pr' }> {
  return { kind: 'pr', host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha }
}

export function prGuideIdentity(repoRoot: string, target: Extract<ReviewTarget, { kind: 'pr' }>): ReviewGuideIdentity {
  return { repoRoot, target, key: reviewGuideKeyForTarget(target, '', null), headSha: target.headSha }
}

export interface ReviewGuideIdentity {
  repoRoot: string
  key: string
  /** Set by surfaces that know the target they asked about. It, not `key`,
   * then identifies the entry — the key embeds the live branch, which the host
   * reads from the checkout and a client outside a worktree cannot. */
  target?: ReviewTarget
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
  scope?: ReviewScope
  target?: ReviewTarget
  instructions?: string
  reportSessionLifecycle?: boolean
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

/**
 * One entry per guide. Identified by target where the caller knows one, because
 * the host's key embeds the live branch: a session outside a Solus worktree has
 * no `gitContext`, so that client can name the target but never the key.
 *
 * Scope-shaped callers (the Git section, a session walkthrough) pass no target
 * and keep keying by the key they can compute. Both sides of a given entry
 * always agree, so there is no second index to drift.
 */
function statusKey(identity: Pick<ReviewGuideIdentity, 'repoRoot' | 'key' | 'target'>): string {
  // Session guide keys already include the provider session id. Keep scope
  // requests from the action row and typed targets from /review:session on the
  // same entry, even though only the tool event carries `target`.
  if (identity.target?.kind === 'session') return `${identity.repoRoot}::${identity.key}`
  // A typed target is portable across projects. In particular, an arbitrary PR
  // URL resolves to a managed checkout whose repoRoot cannot match the session
  // that requested it. The host partition plus target identity is sufficient;
  // scope-shaped entries still need their project root and guide key.
  return identity.target
    ? `target::${reviewGuideTargetId(identity.target)}`
    : `${identity.repoRoot}::${identity.key}`
}

function targetOptions(scope: ReviewScope | ReviewTarget): { scope: ReviewScope } | { target: ReviewTarget } {
  return scope === 'branch' || scope === 'session' ? { scope } : { target: scope }
}

function isReviewScope(scope: ReviewScope | ReviewTarget): scope is ReviewScope {
  return scope === 'branch' || scope === 'session'
}

function matchesGuideProbe(
  event: ReviewGuideStatusEvent | null,
  identity: ReviewGuideIdentity,
  scope: ReviewScope | ReviewTarget,
): event is ReviewGuideStatusEvent {
  if (!event) return false
  const matchesRequest = isReviewScope(scope)
    ? event.key === identity.key
    : reviewGuideTargetId(event.target ?? scope) === reviewGuideTargetId(scope)
  const matchesRepository = isReviewScope(scope) || !identity.target
    ? event.repoRoot === identity.repoRoot
    : true
  return matchesRequest && matchesRepository
    && (identity.target?.kind === 'pr' || !identity.headSha || event.headSha === identity.headSha)
}

/** Review-guide generation state shared by every mounted surface. Components
 * may unmount while a guide is queued or generating; the store remains bound
 * to the host API and receives the eventual ready/failed event. */
export class ReviewGuideStore {
  private statusesByServer = new SvelteMap<string, SvelteMap<string, ReviewGuideStatusEvent>>()
  private subscribedServerIds = new Set<string>()
  private trackedGuides = new Map<string, Map<string, TrackedGuide>>()
  private pendingLoads = new Map<string, { version: string; promise: Promise<void> }>()
  private requestVersions = new Map<string, number>()
  private eventVersions = new Map<string, number>()
  private startingRequests = new SvelteMap<string, { eventVersion: number; event: ReviewGuideStatusEvent }>()
  private loadErrors = new SvelteMap<string, string>()
  private disconnectedServers = new SvelteSet<string>()
  private connectionUnsubscribe: (() => void) | null = null
  private revisionsByServer = new Map<string, Map<string, string>>()
  private readyListeners = new Set<ReadyListener>()
  private changeListeners = new Set<ReadyListener>()
  private openedReadyEventsByServer = new SvelteMap<string, SvelteSet<string>>()

  constructor(
    private readonly eventsFor: (serverId: string) => HostEventSubscriber = (serverId) => serverConnections.eventsFor(serverId),
    private readonly watchConnections: (listener: ConnectionListener) => () => void = (listener) => serverConnections.onStatusChange(listener),
  ) {}

  private rememberRevision(serverId: string, identity: ReviewGuideIdentity): void {
    if (identity.revision === undefined) return
    let revisions = this.revisionsByServer.get(serverId)
    if (!revisions) {
      revisions = new Map()
      this.revisionsByServer.set(serverId, revisions)
    }
    revisions.set(statusKey(identity), identity.revision)
  }

  bind(serverId: string): void {
    if (this.subscribedServerIds.has(serverId)) return
    this.subscribedServerIds.add(serverId)
    this.connectionUnsubscribe ??= this.watchConnections((host, status) => {
      if (!this.subscribedServerIds.has(host)) return
      if (status !== 'connected') {
        this.disconnectedServers.add(host)
        return
      }
      this.disconnectedServers.delete(host)
      for (const tracked of this.trackedGuides.get(host)?.values() ?? []) {
        void this.load(tracked.api, host, tracked.ctx, tracked.identity, tracked.scope)
      }
    })
    this.eventsFor(serverId).subscribe('review.guideStatusChanged', (event) => {
      const previous = this.statusesByServer.get(serverId)?.get(statusKey(event))
      if (!this.set(serverId, event)) return
      if (event.status === 'ready' && (previous?.status !== 'ready' || previous.generatedAt !== event.generatedAt)) {
        for (const listener of this.readyListeners) listener(serverId, event)
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

  onChange(listener: ReadyListener): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  reconnectingFor(serverId: string): boolean {
    return this.disconnectedServers.has(serverId)
  }

  loadErrorFor(serverId: string, identity: ReviewGuideIdentity | null): string | null {
    return identity ? this.loadErrors.get(`${serverId}::${statusKey(identity)}`) ?? null : null
  }

  private track(api: HostApi, serverId: string, ctx: IpcContext, identity: ReviewGuideIdentity, scope: ReviewScope | ReviewTarget): void {
    let tracked = this.trackedGuides.get(serverId)
    if (!tracked) {
      tracked = new Map()
      this.trackedGuides.set(serverId, tracked)
    }
    tracked.set(statusKey(identity), { api, ctx, identity, scope })
  }

  load(
    api: SolusApi,
    serverId: string,
    ctx: IpcContext,
    identity: ReviewGuideIdentity,
    scope: ReviewScope | ReviewTarget,
  ): Promise<void> {
    this.bind(serverId)
    this.track(api, serverId, ctx, identity, scope)
    const key = statusKey(identity)
    const requestKey = `${serverId}::${key}`
    const targetVersion = `${identity.headSha ?? ''}::${identity.revision ?? ''}::${identity.target?.kind === 'pr' ? identity.target.baseSha ?? '' : ''}`
    const pending = this.pendingLoads.get(requestKey)
    if (pending?.version === targetVersion) return pending.promise
    const requestVersion = (this.requestVersions.get(requestKey) ?? 0) + 1
    this.requestVersions.set(requestKey, requestVersion)
    const eventVersion = this.eventVersions.get(requestKey) ?? 0
    this.rememberRevision(serverId, identity)
    const current = () => this.requestVersions.get(requestKey) === requestVersion
      && (this.eventVersions.get(requestKey) ?? 0) === eventVersion
    const promise = (async () => { try {
      const event = await api.reviewGuideStatus(ctx, targetOptions(scope))
      // A newer load for the same stable guide key owns the entry now. Keep
      // this response under its original target instead of letting it replace
      // the newer checkout/revision state.
      if (!current()) return
      this.loadErrors.delete(requestKey)
      // A request made by target is answered by target: the host's key may embed
      // a branch this client cannot read, so matching on it would discard the
      // very answer that reveals it. A request made by scope has no target to
      // match, and keeps the key check. `event.target` is optional in the
      // contract, so fall back to the target we asked about rather than
      // treating its absence as a mismatch — that would strand the card on
      // "Preparing" for good, a worse failure than the one this fixes.
      if (matchesGuideProbe(event, identity, scope)) {
        this.set(serverId, !isReviewScope(scope) && !event.target ? { ...event, target: scope } : event)
      } else {
        this.statusesByServer.get(serverId)?.delete(key)
      }
    } catch (error) {
      if (current()) this.loadErrors.set(requestKey, error instanceof Error ? error.message : String(error))
    } finally {
      if (this.requestVersions.get(requestKey) === requestVersion) this.pendingLoads.delete(requestKey)
    } })()
    this.pendingLoads.set(requestKey, { version: targetVersion, promise })
    return promise
  }

  async generate(
    api: SolusApi,
    serverId: string,
    ctx: IpcContext,
    identity: ReviewGuideIdentity,
    request: ReviewGuideRequest,
  ): Promise<void> {
    this.bind(serverId)
    this.track(api, serverId, ctx, identity, request.target ?? request.scope ?? 'branch')
    this.rememberRevision(serverId, identity)
    const requestKey = `${serverId}::${statusKey(identity)}`
    this.requestVersions.set(requestKey, (this.requestVersions.get(requestKey) ?? 0) + 1)
    this.pendingLoads.delete(requestKey)
    this.startingRequests.set(requestKey, {
      eventVersion: this.eventVersions.get(requestKey) ?? 0,
      event: {
        repoRoot: identity.repoRoot, key: identity.key, target: request.target,
        scope: request.target?.kind ?? request.scope ?? 'branch',
        headSha: identity.headSha ?? '', status: 'queued', updatedAt: Date.now(),
        generatedAt: this.statusFor(serverId, identity)?.generatedAt,
      },
    })
    try {
      const event = await api.requestReviewGuide(ctx, request)
      const matchesRequest = request.target
        ? !!event && reviewGuideTargetId(event.target ?? request.target) === reviewGuideTargetId(request.target)
        : !!event && event.repoRoot === identity.repoRoot && event.key === identity.key
      if (!event || !matchesRequest) throw new Error('The guide could not be queued.')
      this.set(serverId, request.target && !event.target ? { ...event, target: request.target } : event)
    } finally {
      this.startingRequests.delete(requestKey)
    }
  }

  async cancel(
    api: SolusApi,
    ctx: IpcContext,
    scope: ReviewScope | ReviewTarget,
  ): Promise<void> {
    await api.cancelGenerateGuide(ctx, targetOptions(scope))
  }

  set(serverId: string, event: ReviewGuideStatusEvent): boolean {
    let statuses = this.statusesByServer.get(serverId)
    if (!statuses) {
      statuses = new SvelteMap()
      this.statusesByServer.set(serverId, statuses)
    }
    const key = statusKey(event)
    const previous = statuses.get(key)
    if (previous && previous.updatedAt > event.updatedAt) return false
    if (previous && previous.updatedAt === event.updatedAt && previous.generationId === event.generationId) {
      const rank = (status: ReviewGuideStatusEvent['status']) => status === 'queued' ? 0 : status === 'generating' ? 1 : 2
      if (rank(previous.status) > rank(event.status)) return false
    }
    const requestKey = `${serverId}::${key}`
    this.eventVersions.set(requestKey, (this.eventVersions.get(requestKey) ?? 0) + 1)
    this.startingRequests.delete(requestKey)
    this.loadErrors.delete(requestKey)
    // A replacement job does not remove the saved PR guide.
    if (event.target?.kind === 'pr' && !event.generatedAt && previous?.generatedAt) {
      event = { ...event, generatedAt: previous.generatedAt }
    }
    statuses.set(key, event)
    for (const listener of this.changeListeners) listener(serverId, event)
    return true
  }

  statusFor(
    serverId: string,
    identity: ReviewGuideIdentity | null,
  ): ReviewGuideStatusEvent | null {
    if (!identity) return null
    const requestKey = `${serverId}::${statusKey(identity)}`
    const starting = this.startingRequests.get(requestKey)
    if (starting && starting.eventVersion === (this.eventVersions.get(requestKey) ?? 0)) return starting.event
    const event = this.statusesByServer.get(serverId)?.get(statusKey(identity)) ?? null
    if (event && identity.headSha && event.headSha !== identity.headSha && identity.target?.kind !== 'pr') return null
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
    serverId: string,
    identity: ReviewGuideIdentity | null,
  ): ReviewGuideStatusEvent | null {
    const event = this.statusFor(serverId, identity)
    if (!event || event.status !== 'ready') return event
    const openedKey = `${statusKey(event)}::${event.updatedAt}`
    return this.openedReadyEventsByServer.get(serverId)?.has(openedKey) ? null : event
  }

  markOpened(serverId: string, identity: ReviewGuideIdentity | null): void {
    const event = this.statusFor(serverId, identity)
    if (!event || event.status !== 'ready') return
    let opened = this.openedReadyEventsByServer.get(serverId)
    if (!opened) {
      opened = new SvelteSet()
      this.openedReadyEventsByServer.set(serverId, opened)
    }
    opened.add(`${statusKey(event)}::${event.updatedAt}`)
  }

  /** Reopening a closed session is already an acknowledgement of the guide it
   * produced. Clear an in-memory ready mark immediately, then probe the host so
   * the same rule also covers a cached guide after an app restart. A guide that
   * is still generating remains visible when it becomes ready later. */
  async acknowledgeSessionGuide(
    api: SolusApi,
    serverId: string,
    ctx: IpcContext,
    identity: ReviewGuideIdentity,
  ): Promise<void> {
    this.markOpened(serverId, identity)
    await this.load(api, serverId, ctx, identity, 'session')
    this.markOpened(serverId, identity)
  }

  isRunningFor(serverId: string, session: Session | undefined): boolean {
    const status = this.statusFor(serverId, sessionGuideIdentity(session))?.status
    return status === 'queued' || status === 'generating'
  }
}

export const reviewGuideStore = new ReviewGuideStore()
