// PR list vocabulary over the shared review-guide lifecycle. The typed PR
// target identifies a guide across projects, checkouts, and entry points.
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import type { PullRequest } from '@solus/contracts/providers'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { reviewGuideTargetId, type PrGuideMetadata, type PrGuideStatus, type ReviewGuideStatusEvent } from '@solus/contracts/review'
import { detached } from './project-prs.svelte'
import type { PrsStore } from './prs.store.svelte'
import { prGuideIdentity, prGuideTarget, reviewGuideStore, type ReviewGuideIdentity, type ReviewGuideStore } from '../../components/review/review-guide.store.svelte'

export interface GuideBatchOutcome {
  total: number
  failed: number
}

export class PrGuidesStore {
  constructor(private readonly prs: PrsStore, private readonly guides: ReviewGuideStore = reviewGuideStore) {}

  private identityFor(serverId: string, ctx: IpcContext, number: number): ReviewGuideIdentity | null {
    const root = projectScopeOf(ctx.session)
    const pr = this.prs.at(serverId, root)?.prFor(number)
    return pr ? prGuideIdentity(root, prGuideTarget({ ...pr.baseRepo, number, headSha: pr.headSha, baseSha: pr.baseSha })) : null
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

  async loadMetadata(api: HostApi, serverId: string, ctx: IpcContext, pr: Pick<PullRequest, 'number' | 'headSha'>): Promise<void> {
    const identity = this.identityFor(serverId, ctx, pr.number)
    if (identity?.target) await this.guides.load(api, serverId, detached(ctx), identity, identity.target)
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
