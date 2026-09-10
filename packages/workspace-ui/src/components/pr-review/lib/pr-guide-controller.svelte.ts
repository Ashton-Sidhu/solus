import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import type { PrReviewTarget } from '@solus/contracts/providers'
import type { ReviewGuideRequestOptions, ReviewGuideStatusEvent } from '@solus/contracts/review'
import { projectScopeOf } from '@solus/contracts/types'
import { GuideLoader } from '../../review/lib/guide-loader.svelte'
import { prGuideIdentity, prGuideTarget, reviewGuideStore } from '../../review/review-guide.store.svelte'
import { requestInputFocus } from '../../../lib/inputFocus'
import { toasts } from '../../../lib/toasts'

interface PrGuideOptions {
  getApi: () => HostApi
  getServerId: () => string
  getCtx: () => IpcContext
  getPr: () => PrReviewTarget | null
  getAgent: () => Required<Pick<ReviewGuideRequestOptions, 'agent' | 'model' | 'reasoningEffort'>>
}

/** Pane-local content backed by the shared host guide job. All commands name
 * the PR explicitly, so the active conversation cannot change their scope. */
export class PrGuideController {
  readonly loader: GuideLoader
  private loadedGeneration = ''
  private loadSequence = 0
  private checkedRevision = $state('')

  constructor(private readonly options: PrGuideOptions) {
    this.loader = new GuideLoader({
      getApi: options.getApi,
      getServerId: options.getServerId,
      getCtx: options.getCtx,
      getKey: () => this.identity?.key ?? '',
      getTarget: () => this.target ?? undefined,
      getScope: () => 'branch',
      getAgent: options.getAgent,
      getCurrentRevision: () => {
        const event = this.event
        return event?.baseSha && !this.running && this.checkedRevision === this.revisionKey
          ? { headSha: event.headSha, baseSha: event.baseSha }
          : options.getPr()
      },
    })
  }

  get target() {
    const pr = this.options.getPr()
    return pr ? prGuideTarget(pr) : null
  }

  private get revisionKey(): string {
    const pr = this.options.getPr()
    return `${this.options.getServerId()}:${this.identity?.key}:${pr?.headSha}:${pr?.baseSha}`
  }

  get identity() {
    const target = this.target
    return target ? prGuideIdentity(projectScopeOf(this.options.getCtx().session), target) : null
  }

  get event(): ReviewGuideStatusEvent | null {
    return reviewGuideStore.statusFor(this.options.getServerId(), this.identity)
  }

  get unavailable(): boolean {
    return reviewGuideStore.reconnectingFor(this.options.getServerId())
      || !!reviewGuideStore.loadErrorFor(this.options.getServerId(), this.identity)
  }

  get running(): boolean {
    return this.event?.status === 'queued' || this.event?.status === 'generating'
  }

  async load(generateIfMissing: boolean): Promise<void> {
    const identity = this.identity
    const target = this.target
    if (!identity || !target) return
    const sequence = ++this.loadSequence
    const revision = this.revisionKey
    await Promise.all([
      this.loader.load(false, false).catch(() => {}),
      reviewGuideStore.load(this.options.getApi(), this.options.getServerId(), this.options.getCtx(), identity, target),
    ])
    if (sequence !== this.loadSequence) return
    if (!this.unavailable) this.checkedRevision = revision
    if (generateIfMissing && !this.loader.guide && !this.loader.error && !this.event && !this.unavailable) {
      await this.generate()
    }
  }

  /** A same-HEAD rewrite is still new content. Consume the saved generation,
   * rather than skipping it just because a previous guide is already open. */
  async syncSaved(event: ReviewGuideStatusEvent): Promise<void> {
    if (this.loader.loading || (event.status !== 'ready' && event.status !== 'outdated')) return
    const generation = `${this.options.getServerId()}:${event.key}:${event.generatedAt ?? event.generationId ?? event.updatedAt}`
    if (generation === this.loadedGeneration) return
    this.loadedGeneration = generation
    if (event.generatedAt && event.generatedAt === this.loader.guide?.generatedAt) return
    await this.loader.load(false, false).catch(() => {})
  }

  async generate(): Promise<void> {
    const identity = this.identity
    const target = this.target
    if (!identity || !target || this.running) return
    try {
      await reviewGuideStore.generate(this.options.getApi(), this.options.getServerId(), this.options.getCtx(), identity, {
        ...this.options.getAgent(), target,
      })
    } catch (error) {
      toasts.error("Couldn't generate the review guide", {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      requestInputFocus()
    }
  }

  async cancel(): Promise<void> {
    const target = this.target
    if (!target) return
    try {
      await reviewGuideStore.cancel(this.options.getApi(), this.options.getCtx(), target)
    } catch (error) {
      toasts.error("Couldn't cancel the review guide", { description: String(error) })
    } finally {
      requestInputFocus()
    }
  }
}
