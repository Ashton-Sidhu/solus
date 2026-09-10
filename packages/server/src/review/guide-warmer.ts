import path from 'path'
import type { PullRequest } from '@solus/contracts/providers'
import {
  type PrGuideMetadata,
  type PrGuideMetadataRequest,
  type ReviewGuideStatusEvent,
} from '@solus/contracts/review'
import { type StackGraph } from '@solus/contracts/stack-types'
import { SOLUS_WORKTREE_DIR, type IpcContext } from '@solus/contracts/types'
import { fetchAndCheckoutPr, listProjectWorktrees } from '../git/worktree-manager'
import { createLogger } from '../logger'
import type { Provider, RepoRef } from '../providers/types'
import { prGuideJobs } from './pr-guide-jobs'
import { readPrGuide } from './pr-guide-store'
import { currentPrGuideTarget } from './pr-guide-context'
import type { AgentDispatcher } from '../agents/agent-runner'

const log = createLogger('review', 'guide-warmer.ts')
const HEAD_STABLE_MS = 60_000
const PREFETCH_COUNT = 3

interface GuideWarmerInput {
  dispatcher: AgentDispatcher
  ctx: IpcContext
  repoRoot: string
  repo: RepoRef
  provider: Provider
  openPullRequests: PullRequest[]
  graph: StackGraph
  isWorktreeInUse: (path: string) => boolean
  onStatus: (event: ReviewGuideStatusEvent) => void
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
const queuedPrefetches = new Set<string>()
let prefetchTail = Promise.resolve()

export interface PrGuideRequest {
  dispatcher: AgentDispatcher
  ctx: IpcContext
  repoRoot: string
  repo: RepoRef
  provider: Provider
  graph: StackGraph | null
  isWorktreeInUse: (path: string) => boolean
  onStatus: (event: ReviewGuideStatusEvent) => void
}

/**
 * Explicit user request: generate guides for these PRs now, regardless of the
 * background-warming opt-in or an existing cached guide. Shares the warmer's
 * serialized queue so only one guide generates at a time.
 */
export function requestPrGuides(request: PrGuideRequest, numbers: number[]): void {
  for (const number of new Set(numbers)) {
    prGuideJobs.request({
      dispatcher: request.dispatcher,
      ctx: request.ctx,
      opts: {
        target: { kind: 'pr', ...request.repo, number },
        agent: request.ctx.settings.reviewAgent ?? request.ctx.settings.activeAgent,
        model: request.ctx.settings.reviewModel,
        reasoningEffort: request.ctx.settings.reviewReasoning ?? 'medium',
      },
      onStatus: request.onStatus,
    })
  }
}

/** Metadata reads use the same PR identity and both provider revisions as the
 * pane. No checkout is required to read an existing guide. */
export async function readPrGuideMetadata(
  ctx: IpcContext,
  repo: RepoRef,
  request: PrGuideMetadataRequest,
): Promise<PrGuideMetadata | null> {
  const target = { kind: 'pr' as const, ...repo, number: request.number }
  const current = await currentPrGuideTarget(target)
  const guide = await readPrGuide(ctx, current)
  if (!guide) return null
  return {
    number: request.number,
    headSha: guide.headSha,
    generatedAt: guide.generatedAt ?? null,
    current: guide.headSha === current.headSha && guide.baseSha === current.baseSha,
  }
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

function comparePrefetchPriority(a: PullRequest, b: PullRequest): number {
  if (a.effort && b.effort) return a.effort.minutes - b.effort.minutes || b.updatedAt.localeCompare(a.updatedAt)
  if (a.effort) return -1
  if (b.effort) return 1
  return b.updatedAt.localeCompare(a.updatedAt)
}

function enqueueGuide(repoRoot: string, number: number, headSha: string): void {
  const key = `${repoRoot}::${number}::${headSha}`
  if (queuedGuides.has(key)) return
  queuedGuides.add(key)
  void warmGuide(repoRoot, number, headSha)
    .catch((err) => {
      log.warn('guide_warm_failed', { prNumber: number, error: errorMessage(err) })
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
    .catch((err) => log.warn('worktree_prefetch_failed', { prNumber: number, error: errorMessage(err) }))
    .finally(() => queuedPrefetches.delete(key))
}

async function warmGuide(repoRoot: string, number: number, headSha: string): Promise<void> {
  const state = repoStates.get(repoRoot)
  const input = state?.latest
  const pr = input?.openPullRequests.find((candidate) => candidate.number === number)
  if (!input || input.ctx.settings.reviewWarmingEnabled !== true || pr?.headSha !== headSha || pr.draft) return

  const target = { kind: 'pr' as const, ...input.repo, number }
  const status = await prGuideJobs.status(input.ctx, target)
  if (status && ['queued', 'generating', 'ready'].includes(status.status)) return
  const result = await prGuideJobs.request({
    dispatcher: input.dispatcher,
    ctx: input.ctx,
    opts: {
      target,
      agent: input.ctx.settings.reviewAgent ?? input.ctx.settings.activeAgent,
      model: input.ctx.settings.reviewModel,
      reasoningEffort: input.ctx.settings.reviewReasoning ?? 'medium',
    },
    onStatus: input.onStatus,
  }).completion
  if (!result?.persisted) scheduleRetry(repoRoot, number, headSha)
}

async function prefetchWorktree(repoRoot: string, number: number, headSha: string): Promise<void> {
  const input = repoStates.get(repoRoot)?.latest
  const pr = input?.openPullRequests.find((candidate) => candidate.number === number)
  if (!input || input.ctx.settings.reviewWarmingEnabled !== true || pr?.headSha !== headSha || pr.draft) return
  // Prefetch is creation-only. An existing worktree may back a live review or
  // agent session, so leave all existing checkouts to their foreground owner.
  const detail = await input.provider.review.getPullRequest(input.repo, number)
  if (detail.state !== 'open' || detail.draft || detail.headSha !== headSha) return
  if (findPrWorktree(repoRoot, detail)) return
  await fetchAndCheckoutPr(repoRoot, number, detail.baseRef, {
    headRef: detail.headRef,
    isFork: detail.headRepo.isFork,
  })
}

function findPrWorktree(repoRoot: string, detail: PullRequest) {
  const branch = detail.headRepo.isFork ? `solus/pr-${detail.number}` : detail.headRef
  const worktreePath = path.join(repoRoot, SOLUS_WORKTREE_DIR, `pr-${detail.number}`)
  return listProjectWorktrees(repoRoot).find(
    (worktree) => worktree.branch === branch || worktree.path === worktreePath,
  )
}

function scheduleRetry(repoRoot: string, number: number, headSha: string): void {
  const observation = repoStates.get(repoRoot)?.heads.get(number)
  if (!observation || observation.headSha !== headSha || observation.timer) return
  observation.timer = setTimeout(() => {
    observation.timer = null
    enqueueGuide(repoRoot, number, headSha)
  }, HEAD_STABLE_MS)
}

function errorMessage(err: Parameters<typeof String>[0]): string {
  return err instanceof Error ? err.message : String(err)
}
