import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { reviewGuideKeyFor, reviewGuideTargetId, type ReviewGuideStatusEvent, type ReviewTarget } from '@solus/contracts/review'
import { worktreeProjectRoot, type AgentId, type IpcContext, type ReasoningEffort, type Session } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { HostApi } from '@solus/client-core/host-api'

type SolusApi = HostApi
type ReviewScope = 'branch' | 'session'
type ReadyListener = (serverId: string, event: ReviewGuideStatusEvent) => void

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

/** Review-guide generation state shared by every mounted surface. Components
 * may unmount while a guide is queued or generating; the store remains bound
 * to the host API and receives the eventual ready/failed event. */
export class ReviewGuideStore {
  private statusesByServer = new SvelteMap<string, SvelteMap<string, ReviewGuideStatusEvent>>()
  private subscribedServerIds = new Set<string>()
  private loadedTargetsByServer = new Map<string, Map<string, string>>()
  private revisionsByServer = new Map<string, Map<string, string>>()
  private readyListeners = new Set<ReadyListener>()
  private openedReadyEventsByServer = new SvelteMap<string, SvelteSet<string>>()

  constructor(
    private readonly eventsFor: (serverId: string) => HostEventSubscriber = (serverId) => serverConnections.eventsFor(serverId),
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
    this.eventsFor(serverId).subscribe('review.guideStatusChanged', (event) => {
      const previous = this.statusesByServer.get(serverId)?.get(statusKey(event))
      this.set(serverId, event)
      if (event.status === 'ready' && previous?.status !== 'ready') {
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

  async load(
    api: SolusApi,
    serverId: string,
    ctx: IpcContext,
    identity: ReviewGuideIdentity,
    scope: ReviewScope | ReviewTarget,
  ): Promise<void> {
    this.bind(serverId)
    let loadedTargets = this.loadedTargetsByServer.get(serverId)
    if (!loadedTargets) {
      loadedTargets = new Map()
      this.loadedTargetsByServer.set(serverId, loadedTargets)
    }

    const key = statusKey(identity)
    const targetVersion = `${identity.headSha ?? ''}::${identity.revision ?? ''}`
    if (loadedTargets.get(key) === targetVersion) return
    loadedTargets.set(key, targetVersion)
    this.rememberRevision(serverId, identity)

    try {
      const event = await api.reviewGuideStatus(ctx, targetOptions(scope))
      // A newer load for the same stable guide key owns the entry now. Keep
      // this response under its original target instead of letting it replace
      // the newer checkout/revision state.
      if (loadedTargets.get(key) !== targetVersion) return
      // A request made by target is answered by target: the host's key may embed
      // a branch this client cannot read, so matching on it would discard the
      // very answer that reveals it. A request made by scope has no target to
      // match, and keeps the key check. `event.target` is optional in the
      // contract, so fall back to the target we asked about rather than
      // treating its absence as a mismatch — that would strand the card on
      // "Preparing" for good, a worse failure than the one this fixes.
      const matchesRequest = !!event && (isReviewScope(scope)
        ? event.key === identity.key
        : reviewGuideTargetId(event.target ?? scope) === reviewGuideTargetId(scope))
      const matchesRepository = isReviewScope(scope) || !identity.target
        ? event?.repoRoot === identity.repoRoot
        : true
      if (event && matchesRequest && matchesRepository && (!identity.headSha || event.headSha === identity.headSha)) {
        this.set(serverId, event)
      } else {
        this.statusesByServer.get(serverId)?.delete(key)
      }
    } catch {
      if (loadedTargets.get(key) === targetVersion) loadedTargets.delete(key)
    }
  }

  async generate(
    api: SolusApi,
    serverId: string,
    ctx: IpcContext,
    identity: ReviewGuideIdentity,
    request: ReviewGuideRequest,
  ): Promise<void> {
    this.bind(serverId)
    this.rememberRevision(serverId, identity)
    const event = await api.requestReviewGuide(ctx, request)
    const matchesRequest = request.target
      ? !!event && reviewGuideTargetId(event.target ?? request.target) === reviewGuideTargetId(request.target)
      : !!event && event.repoRoot === identity.repoRoot && event.key === identity.key
    if (event && matchesRequest) {
      this.set(serverId, event)
    }
  }

  async cancel(
    api: SolusApi,
    ctx: IpcContext,
    scope: ReviewScope | ReviewTarget,
  ): Promise<void> {
    await api.cancelGenerateGuide(ctx, targetOptions(scope))
  }

  set(serverId: string, event: ReviewGuideStatusEvent): void {
    let statuses = this.statusesByServer.get(serverId)
    if (!statuses) {
      statuses = new SvelteMap()
      this.statusesByServer.set(serverId, statuses)
    }
    statuses.set(statusKey(event), event)
  }

  statusFor(
    serverId: string,
    identity: ReviewGuideIdentity | null,
  ): ReviewGuideStatusEvent | null {
    if (!identity) return null
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

  isRunningFor(serverId: string, session: Session | undefined): boolean {
    const status = this.statusFor(serverId, sessionGuideIdentity(session))?.status
    return status === 'queued' || status === 'generating'
  }
}

export const reviewGuideStore = new ReviewGuideStore()
