// PR list vocabulary over the shared review-guide lifecycle. The typed PR
// target identifies a guide across projects, checkouts, and entry points.
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import type { PullRequest } from '@solus/contracts/providers'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { reviewGuideTargetId, type PrGuideMetadata, type PrGuideStatus, type ReviewGuideStatusEvent } from '@solus/contracts/review'
import { detached, type ProjectPrs } from './project-prs.svelte'
import type { PrsStore } from './prs.store.svelte'
import { prGuideIdentity, prGuideTarget, reviewGuideStore, type ListedPrGuide, type ReviewGuideIdentity, type ReviewGuideStore } from '../../components/review/review-guide.store.svelte'

export interface GuideBatchOutcome {
  total: number
  failed: number
}

export class PrGuidesStore {
  /** Revisions `loadMetadata` has asked the host about, by host and target. */
  private readonly probedRevisions = new Set<string>()

  constructor(private readonly prs: PrsStore, private readonly guides: ReviewGuideStore = reviewGuideStore) {}

  private listedGuide(serverId: string, ctx: IpcContext, number: number): ListedPrGuide | null {
    const repoRoot = projectScopeOf(ctx.session)
    const pr = this.prs.at(serverId, repoRoot)?.prFor(number)
    return pr
      ? { repoRoot, target: prGuideTarget({ ...pr.baseRepo, number, headSha: pr.headSha, baseSha: pr.baseSha }), headRef: pr.headRef }
      : null
  }

  private identityFor(serverId: string, ctx: IpcContext, number: number): ReviewGuideIdentity | null {
    const guide = this.listedGuide(serverId, ctx, number)
    return guide ? prGuideIdentity(guide.repoRoot, guide.target) : null
  }

  statusFor(serverId: string, ctx: IpcContext, number: number): PrGuideStatus | undefined {
    const identity = this.identityFor(serverId, ctx, number)
    const event = this.guides.statusFor(serverId, identity)
    // The list's baseSha is the target branch tip, not the guide's merge base.
    // The host checks comparison-base freshness; a known head push is local.
    if (event?.status === 'ready' && identity?.target?.kind === 'pr'
      && event.headSha !== identity.target.headSha) return 'outdated'
    return event?.status
  }

  /** Only the summary needs a collection; rows read the shared entry directly. */
  get status(): ReadonlyMap<string, PrGuideStatus> {
    const statuses = new Map<string, PrGuideStatus>()
    for (const project of this.prs.all) {
      for (const pr of project.prs.values()) {
        const status = this.statusFor(project.serverId, project.hostContext, pr.number)
        if (status) statuses.set(`${project.key}::${pr.number}`, status)
      }
    }
    return statuses
  }

  metadataFor(serverId: string, ctx: IpcContext, number: number): PrGuideMetadata | undefined {
    const event = this.guides.statusFor(serverId, this.identityFor(serverId, ctx, number))
    if (!event?.generatedAt) return undefined
    return { number, headSha: event.headSha, generatedAt: event.generatedAt, current: this.statusFor(serverId, ctx, number) === 'ready' }
  }

  /**
   * Ask the host about these pull requests' saved guides in one request, once
   * per revision.
   *
   * Once is enough: a guide that starts, finishes, or fails after this arrives
   * as `review.guideStatusChanged`, and a reconnect re-probes every guide the
   * shared store tracks. A push is a new revision, so it is asked about again.
   * A probe that failed is forgotten, so the next load retries it.
   */
  async loadMetadata(api: HostApi, serverId: string, ctx: IpcContext, prs: readonly Pick<PullRequest, 'number'>[]): Promise<void> {
    const revisionKey = ({ target }: ListedPrGuide) =>
      `${serverId}::${reviewGuideTargetId(target)}@${target.headSha}:${target.baseSha}`
    const fresh = prs
      .map((pr) => this.listedGuide(serverId, ctx, pr.number))
      .filter((guide): guide is ListedPrGuide => !!guide && !this.probedRevisions.has(revisionKey(guide)))
    if (!fresh.length) return
    for (const guide of fresh) this.probedRevisions.add(revisionKey(guide))
    await this.guides.loadPrs(api, serverId, detached(ctx), fresh)
    for (const guide of fresh) {
      if (this.guides.loadErrorFor(serverId, prGuideIdentity(guide.repoRoot, guide.target))) {
        this.probedRevisions.delete(revisionKey(guide))
      }
    }
  }

  /** Probe the guides for the rows a list read just landed. */
  loadListed(project: ProjectPrs): Promise<void> {
    return this.loadMetadata(project.hostApi, project.serverId, project.hostContext, project.items)
  }

  async request(
    api: HostApi,
    serverId: string,
    ctx: IpcContext,
    numbers: number[],
    options: { onSettled?: (outcome: GuideBatchOutcome) => void } = {},
  ): Promise<void> {
    const project = this.prs.get(api, serverId, ctx)
    const unique = [...new Set(numbers)]
    const targets = await Promise.all(unique.map(async (number) => {
      if (!project.prFor(number)) await project.get(number).loadDetail()
      const identity = this.identityFor(serverId, ctx, number)
      if (!identity?.target) throw new Error(`Pull request #${number} is unavailable.`)
      return { identity, target: identity.target }
    }))
    const remaining = new Set(targets.map(({ target }) => reviewGuideTargetId(target)))
    let failed = 0
    let unsubscribe = () => {}
    const settle = (host: string, event: ReviewGuideStatusEvent) => {
      if (host !== serverId || !event.target || event.status === 'queued' || event.status === 'generating') return
      if (!remaining.delete(reviewGuideTargetId(event.target))) return
      if (event.status !== 'ready') failed += 1
      if (remaining.size === 0) {
        unsubscribe()
        options.onSettled?.({ total: unique.length, failed })
      }
    }
    if (options.onSettled) unsubscribe = this.guides.onChange(settle)
    try {
      await Promise.all(targets.map(async ({ identity, target }) => {
        const status = this.guides.statusFor(serverId, identity)?.status
        if (status !== 'queued' && status !== 'generating') {
          await this.guides.generate(api, serverId, detached(ctx), identity, { target })
        }
        const event = this.guides.statusFor(serverId, identity)
        if (event) settle(serverId, event)
      }))
      if (unique.length === 0) {
        unsubscribe()
        options.onSettled?.({ total: 0, failed: 0 })
      }
    } catch (error) {
      unsubscribe()
      throw error
    }
  }

  /** Bind before any PR list is opened, so tool-initiated work is retained. */
  subscribe(): () => void {
    for (const serverId of serverConnections.connectedServerIds()) this.guides.bind(serverId)
    return serverConnections.onConnectionCreated((connection) => this.guides.bind(connection.serverId))
  }
}
