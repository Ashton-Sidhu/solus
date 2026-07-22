import type { PullRequestDetail, PullRequestSummary } from '../../shared/providers'
import {
  reviewGuideKeyForBase,
  type PrGuideMetadata,
  type PrGuideMetadataRequest,
  type PrGuideStatus,
} from '../../shared/review'
import { resolveStackDiffBase, type StackGraph } from '../../shared/stack-types'
import type { IpcContext } from '../../shared/types'
import { fetchAndCheckoutPr, getHeadCommit, listProjectWorktrees, type PrWorktree } from '../git/worktree-manager'
import { createLogger } from '../logger'
import type { Provider, RepoRef } from '../providers/types'
import { generateGuide } from './guide-producer'
import { readGuideByKey } from './ledger'
import { guideKeyFor } from './review-target'

const log = createLogger('review', 'guide-warmer.ts')
const HEAD_STABLE_MS = 60_000
const PREFETCH_COUNT = 3

interface GuideWarmerInput {
  ctx: IpcContext
  repoRoot: string
  repo: RepoRef
  provider: Provider
  openPullRequests: PullRequestSummary[]
  graph: StackGraph
  isWorktreeInUse: (path: string) => boolean
}

interface HeadObservation {
  headSha: string
  timer: ReturnType<typeof setTimeout> | null
}

interface RepoWarmState {
  latest: GuideWarmerInput
  heads: Map<number, HeadObservation>
}

const repoStates = new Map<string, RepoWarmState>()
const queuedGuides = new Set<string>()
const queuedRequests = new Set<string>()
const queuedPrefetches = new Set<string>()
let guideTail = Promise.resolve()
let prefetchTail = Promise.resolve()

export interface PrGuideRequest {
  ctx: IpcContext
  repoRoot: string
  repo: RepoRef
  provider: Provider
  graph: StackGraph | null
  isWorktreeInUse: (path: string) => boolean
  onStatus: (number: number, status: PrGuideStatus, metadata?: PrGuideMetadata) => void
}

/**
 * Explicit user request: generate guides for these PRs now, regardless of the
 * background-warming opt-in or an existing cached guide. Shares the warmer's
 * serialized queue so only one guide generates at a time.
 */
export function requestPrGuides(request: PrGuideRequest, numbers: number[]): void {
  for (const number of numbers) {
    const key = `${request.repoRoot}::${number}`
    if (queuedRequests.has(key)) continue
    queuedRequests.add(key)
    request.onStatus(number, 'queued')
    guideTail = guideTail
      .then(async () => {
        request.onStatus(number, 'generating')
        const metadata = await generateRequestedGuide(request, number)
        request.onStatus(number, 'ready', metadata ?? undefined)
      })
      .catch((err) => {
        log.warn(`requested guide failed for PR #${number}: ${errorMessage(err)}`)
        request.onStatus(number, 'failed')
      })
      .finally(() => queuedRequests.delete(key))
  }
}

async function generateRequestedGuide(request: PrGuideRequest, number: number): Promise<PrGuideMetadata | null> {
  const detail = await request.provider.review.getPullRequest(request.repo, number)
  if (detail.state !== 'open') throw new Error(`PR #${number} is not open`)
  const diffBase = request.graph ? resolveStackDiffBase(request.graph, number, '') : null
  const ownDelta = diffBase?.kind === 'own-delta' && diffBase.parent
    ? { parent: diffBase.parent, headSha: diffBase.ref }
    : null
  const checkout = await checkoutForGuide(request.repoRoot, request.isWorktreeInUse, detail)
  if (!checkout) throw new Error(`PR #${number}'s review worktree is busy on a different commit`)
  const ctx = contextForPr(request.ctx, request.repoRoot, detail, checkout)
  const generated = await generateGuide(ctx, {
    agent: request.ctx.settings.reviewAgent ?? request.ctx.settings.activeAgent,
    model: request.ctx.settings.reviewModel,
    reasoningEffort: request.ctx.settings.reviewReasoning ?? 'medium',
    scope: 'branch',
    ownDeltaBase: ownDelta ?? undefined,
  })
  if (!generated?.persisted) return null
  return {
    number,
    headSha: generated.guide.headSha,
    generatedAt: generated.guide.generatedAt ?? null,
    current: generated.guide.headSha === detail.headSha,
  }
}

/** Read locally cached guide metadata for a PR page without checking out the
 *  PRs or contacting the provider. The live stack graph selects the same cache
 *  key as generation, so a moved stacked base correctly appears guide-less. */
export async function readPrGuideMetadata(
  repoRoot: string,
  graph: StackGraph | null,
  requests: PrGuideMetadataRequest[],
): Promise<PrGuideMetadata[]> {
  const metadata = await Promise.all(requests.map(async (request) => {
    const diffBase = resolveStackDiffBase(graph, request.number, '')
    const key = reviewGuideKeyForBase(
      guideKeyFor({ branch: `solus/pr-${request.number}` }, 'branch', null),
      diffBase.kind === 'own-delta' ? diffBase.ref : null,
    )
    const guide = await readGuideByKey(repoRoot, key)
    if (!guide) return null
    return {
      number: request.number,
      headSha: guide.headSha,
      generatedAt: guide.generatedAt ?? null,
      current: guide.headSha === request.headSha,
    }
  }))
  return metadata.filter((item): item is PrGuideMetadata => item !== null)
}

/**
 * Observe the complete open-PR list after stack detection has resolved. A head
 * must remain unchanged for a minute before it enters the serialized model
 * queue; `updatedAt` lets an already-settled PR warm immediately on first sight.
 */
export function scheduleGuideWarming(input: GuideWarmerInput): void {
  const enabled = input.ctx.settings.reviewWarmingEnabled === true
  const eligible = input.openPullRequests.filter((pr) => pr.state === 'open' && !pr.draft)
  let state = repoStates.get(input.repoRoot)
  if (!state) {
    state = { latest: input, heads: new Map() }
    repoStates.set(input.repoRoot, state)
  } else {
    state.latest = input
  }

  if (!enabled) {
    for (const observation of state.heads.values()) if (observation.timer) clearTimeout(observation.timer)
    state.heads.clear()
    return
  }

  const openNumbers = new Set(eligible.map((pr) => pr.number))
  for (const [number, observation] of state.heads) {
    if (openNumbers.has(number)) continue
    if (observation.timer) clearTimeout(observation.timer)
    state.heads.delete(number)
  }

  for (const pr of eligible) {
    const previous = state.heads.get(pr.number)
    if (previous?.headSha === pr.headSha) continue
    if (previous?.timer) clearTimeout(previous.timer)
    const delay = Math.max(0, HEAD_STABLE_MS - Math.max(0, Date.now() - Date.parse(pr.updatedAt)))
    const observation: HeadObservation = { headSha: pr.headSha, timer: null }
    observation.timer = setTimeout(() => {
      observation.timer = null
      enqueueGuide(input.repoRoot, pr.number, pr.headSha)
    }, Number.isFinite(delay) ? delay : HEAD_STABLE_MS)
    state.heads.set(pr.number, observation)
  }

  for (const pr of [...eligible].sort(comparePrefetchPriority).slice(0, PREFETCH_COUNT)) {
    enqueuePrefetch(input.repoRoot, pr.number, pr.headSha)
  }
}

function comparePrefetchPriority(a: PullRequestSummary, b: PullRequestSummary): number {
  if (a.effort && b.effort) return a.effort.minutes - b.effort.minutes || b.updatedAt.localeCompare(a.updatedAt)
  if (a.effort) return -1
  if (b.effort) return 1
  return b.updatedAt.localeCompare(a.updatedAt)
}

function enqueueGuide(repoRoot: string, number: number, headSha: string): void {
  const key = `${repoRoot}::${number}::${headSha}`
  if (queuedGuides.has(key)) return
  queuedGuides.add(key)
  guideTail = guideTail
    .then(() => warmGuide(repoRoot, number, headSha))
    .catch((err) => {
      log.warn(`guide warm failed for PR #${number}: ${errorMessage(err)}`)
      scheduleRetry(repoRoot, number, headSha)
    })
    .finally(() => queuedGuides.delete(key))
}

function enqueuePrefetch(repoRoot: string, number: number, headSha: string): void {
  const key = `${repoRoot}::${number}::${headSha}`
  if (queuedPrefetches.has(key)) return
  queuedPrefetches.add(key)
  prefetchTail = prefetchTail
    .then(() => prefetchWorktree(repoRoot, number, headSha))
    .catch((err) => log.warn(`worktree prefetch failed for PR #${number}: ${errorMessage(err)}`))
    .finally(() => queuedPrefetches.delete(key))
}

async function warmGuide(repoRoot: string, number: number, headSha: string): Promise<void> {
  const state = repoStates.get(repoRoot)
  const input = state?.latest
  const pr = input?.openPullRequests.find((candidate) => candidate.number === number)
  if (!input || input.ctx.settings.reviewWarmingEnabled !== true || pr?.headSha !== headSha || pr.draft) return

  const diffBase = resolveStackDiffBase(input.graph, number, '')
  const guideKey = reviewGuideKeyForBase(
    guideKeyFor({ branch: `solus/pr-${number}` }, 'branch', null),
    diffBase.kind === 'own-delta' ? diffBase.ref : null,
  )
  const cached = await readGuideByKey(repoRoot, guideKey)
  // Re-check after acquiring the global model slot: a foreground generation may
  // have filled the same cache while this task waited.
  if (cached?.headSha === headSha) return

  const detail = await input.provider.review.getPullRequest(input.repo, number)
  if (detail.state !== 'open' || detail.draft || detail.headSha !== headSha) return
  const checkout = await checkoutForGuide(input.repoRoot, input.isWorktreeInUse, detail)
  if (!checkout) {
    scheduleRetry(repoRoot, number, headSha)
    return
  }

  const ctx = contextForPr(input.ctx, repoRoot, detail, checkout)
  await generateGuide(ctx, {
    agent: input.ctx.settings.reviewAgent ?? input.ctx.settings.activeAgent,
    model: input.ctx.settings.reviewModel,
    reasoningEffort: input.ctx.settings.reviewReasoning ?? 'medium',
    scope: 'branch',
    ownDeltaBase: diffBase.kind === 'own-delta' && diffBase.parent
      ? { parent: diffBase.parent, headSha: diffBase.ref }
      : undefined,
  })
}

async function checkoutForGuide(
  repoRoot: string,
  isWorktreeInUse: (path: string) => boolean,
  detail: PullRequestDetail,
): Promise<PrWorktree | null> {
  const existing = findPrWorktree(repoRoot, detail.number)
  if (existing && isWorktreeInUse(existing.path)) {
    if (getHeadCommit(existing.path) !== detail.headSha) return null
    return {
      worktreePath: existing.path,
      branch: `solus/pr-${detail.number}`,
      baseSha: detail.baseSha,
      headSha: detail.headSha,
    }
  }
  return fetchAndCheckoutPr(repoRoot, detail.number, detail.baseRef)
}

async function prefetchWorktree(repoRoot: string, number: number, headSha: string): Promise<void> {
  const input = repoStates.get(repoRoot)?.latest
  const pr = input?.openPullRequests.find((candidate) => candidate.number === number)
  if (!input || input.ctx.settings.reviewWarmingEnabled !== true || pr?.headSha !== headSha || pr.draft) return
  // Prefetch is creation-only. An existing worktree may back a live review or
  // agent session, so leave all existing checkouts to their foreground owner.
  if (findPrWorktree(repoRoot, number)) return
  const detail = await input.provider.review.getPullRequest(input.repo, number)
  if (detail.state !== 'open' || detail.draft || detail.headSha !== headSha) return
  await fetchAndCheckoutPr(repoRoot, number, detail.baseRef)
}

function findPrWorktree(repoRoot: string, number: number) {
  const branch = `solus/pr-${number}`
  return listProjectWorktrees(repoRoot).find((worktree) => worktree.branch === branch)
}

function scheduleRetry(repoRoot: string, number: number, headSha: string): void {
  const observation = repoStates.get(repoRoot)?.heads.get(number)
  if (!observation || observation.headSha !== headSha || observation.timer) return
  observation.timer = setTimeout(() => {
    observation.timer = null
    enqueueGuide(repoRoot, number, headSha)
  }, HEAD_STABLE_MS)
}

function contextForPr(
  ctx: IpcContext,
  repoRoot: string,
  detail: PullRequestDetail,
  checkout: PrWorktree,
): IpcContext {
  return {
    ...ctx,
    session: {
      ...ctx.session,
      workingDirectory: checkout.worktreePath,
      projectPath: repoRoot,
      gitContext: {
        branch: checkout.branch,
        targetBranch: detail.baseRef,
        worktreePath: checkout.worktreePath,
        repoRoot,
      },
      prReview: {
        host: detail.baseRepo?.host ?? 'github.com',
        owner: detail.baseRepo?.owner ?? '',
        repo: detail.baseRepo?.repo ?? '',
        number: detail.number,
        title: detail.title,
        baseRef: detail.baseRef,
        headRef: detail.headRef,
        headSha: checkout.headSha,
        baseSha: checkout.baseSha,
        headRepo: detail.headRepo,
        worktreePath: checkout.worktreePath,
        branch: checkout.branch,
      },
    },
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
