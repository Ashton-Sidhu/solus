import { createLogger } from '../../logger'
import { getProvider, providerForRepo } from '../../providers/registry'
import { ConnectCancelledError } from '../../providers/github/auth'
import { computeGitState, resolveRepoRef, resolveRepoRoot } from '../../git/git-helpers'
import { fetchAndCheckoutPr } from '../../git/worktree-manager'
import { readStackGraph, scheduleStackDetection } from '../../git/stack-detect'
import { computePrInterdiff } from '../../git/interdiff'
import { runAsync } from '../../git/exec'
import { writeReviewCheckpoint } from '../../review/checkpoints'
import { estimateReviewEffort } from '../../review/effort'
import { readPrGuideMetadata, requestPrGuides, scheduleGuideWarming } from '../../review/guide-warmer'
import type { Provider, RepoRef } from '../../providers/types'
import type { PrEffortRequest, PrEffortResult, PrFilter, DraftReview } from '../../../shared/providers'
import type { ReviewEffort } from '../../../shared/effort-types'
import type { PrGuideMetadataRequest } from '../../../shared/review'
import type { IpcContext, MergeMethod, PrConflictResolutionResult, PrMergeResult, PrReviewContext } from '../../../shared/types'
import type { SolusServer } from '../server'
import { attachReviewAttention } from './review-attention'

const log = createLogger('main', 'provider-handlers')
const EFFORT_FETCH_CONCURRENCY = 4
type ReviewEffortStats = Pick<PrEffortResult, 'effort' | 'additions' | 'deletions'>
const effortCache = new Map<string, Promise<ReviewEffortStats | undefined>>()

const GENERATED_PATH_PATTERNS = [
  /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|gemfile\.lock|poetry\.lock|composer\.lock|go\.sum)$/i,
  /\.(min\.(js|css)|map)$/i,
  /(^|\/)(dist|build|generated|vendor|third_party|node_modules)(\/|$)/i,
  /(^|\/).*\.(generated|g)\.[^/]+$/i,
]

function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  transform: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await transform(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

async function loadReviewEfforts(
  requests: PrEffortRequest[],
  repo: RepoRef,
  provider: Provider,
): Promise<PrEffortResult[]> {
  return mapWithConcurrency(requests, EFFORT_FETCH_CONCURRENCY, async (request) => {
    const prefix = `${repo.host}/${repo.owner}/${repo.repo}::${request.number}::`
    const cacheKey = `${prefix}${request.headSha}`
    let effort = effortCache.get(cacheKey)
    if (!effort) {
      effort = provider.review.listPullRequestFileStats(repo, request.number)
        .then((fileStats) => ({
          effort: estimateReviewEffort({
            fileStats,
            generatedPaths: fileStats.filter((file) => isGeneratedPath(file.path)).map((file) => file.path),
            renamedPaths: [],
          }),
          additions: fileStats.reduce((total, file) => total + file.additions, 0),
          deletions: fileStats.reduce((total, file) => total + file.deletions, 0),
        }))
        .catch((err) => {
          effortCache.delete(cacheKey)
          log.warn(`review effort unavailable for PR #${request.number}: ${err instanceof Error ? err.message : String(err)}`)
          return undefined
        })
      for (const key of effortCache.keys()) if (key.startsWith(prefix)) effortCache.delete(key)
      effortCache.set(cacheKey, effort)
    }
    const resolved = await effort
    return resolved ? { ...request, ...resolved } : request
  })
}

/**
 * Resolve the provider for the current repo. Auth (token) is per-host and
 * global, so when the repo's host is unknown we fall back to GitHub — the only
 * host in v1 — so Settings can always offer a connect affordance.
 */
async function providerForContext(ctx: IpcContext): Promise<Provider | null> {
  const cwd = ctx.session.projectPath || ctx.session.workingDirectory
  if (cwd) {
    const repo = await resolveRepoRef(cwd)
    if (repo) {
      const provider = providerForRepo(repo)
      if (provider) return provider
    }
  }
  return getProvider('github') ?? null
}

/** Resolve the `{ repo, provider }` pair PR-review handlers need. Throws with a
 *  user-facing message when the repo host isn't supported or auth is missing. */
export async function reviewTargetFor(ctx: IpcContext): Promise<{ repo: RepoRef; provider: Provider }> {
  const cwd = ctx.session.projectPath || ctx.session.workingDirectory
  const repo = cwd ? await resolveRepoRef(cwd) : null
  if (!repo) throw new Error('This folder has no recognizable git remote to review PRs from.')
  const provider = providerForRepo(repo)
  if (!provider) throw new Error(`PR review isn't supported for ${repo.host} yet.`)
  return { repo, provider }
}

/** Fetch the PR, check out its worktree, and assemble the review context. */
async function openPrReview(ctx: IpcContext, number: number): Promise<PrReviewContext> {
  const { repo, provider } = await reviewTargetFor(ctx)
  const detail = await provider.review.getPullRequest(repo, number)
  const base = ctx.session.projectPath || ctx.session.workingDirectory
  const repoRoot = (await resolveRepoRoot(base)) ?? base
  const wt = await fetchAndCheckoutPr(repoRoot, number, detail.baseRef)
  return {
    host: repo.host,
    owner: repo.owner,
    repo: repo.repo,
    number,
    title: detail.title,
    baseRef: detail.baseRef,
    headRef: detail.headRef,
    // Anchor comments to the head we actually checked out and rendered.
    headSha: wt.headSha,
    baseSha: wt.baseSha,
    headRepo: detail.headRepo,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
  }
}

async function repoRootForContext(ctx: IpcContext): Promise<string> {
  const cwd = ctx.session.projectPath || ctx.session.workingDirectory
  return (await resolveRepoRoot(cwd)) ?? cwd
}

async function persistReviewCheckpoint(
  ctx: IpcContext,
  repo: RepoRef,
  provider: Provider,
  number: number,
  review: DraftReview,
): Promise<void> {
  const repoRoot = await repoRootForContext(ctx)
  let checkpointBase = review.baseSha ?? null
  if (!checkpointBase) {
    try {
      // General comments can originate outside the worktree-backed pane. Fetch
      // both refs so even those successful reviews receive a mechanical base.
      const detail = await provider.review.getPullRequest(repo, number)
      await runAsync('git', ['fetch', 'origin', detail.baseRef], repoRoot)
      await runAsync('git', ['fetch', 'origin', `pull/${number}/head`], repoRoot)
      checkpointBase = await runAsync('git', ['merge-base', review.commitId, detail.baseSha], repoRoot)
    } catch {
      log.warn(`review submitted for PR #${number}, but its merge-base could not be resolved`)
      return
    }
  }
  const saved = await writeReviewCheckpoint(repoRoot, {
    prNumber: number,
    headSha: review.commitId,
    base: checkpointBase,
    reviewedAt: new Date().toISOString(),
  })
  if (!saved) log.warn(`review submitted for PR #${number}, but its checkpoint could not be saved`)
}

export interface ProviderHandlerDeps {
  isWorktreeInUse: (path: string) => boolean
}

export function registerProviderHandlers(server: SolusServer, deps: ProviderHandlerDeps): void {
  server.register('providerStatus', async (args) => {
    const [ctx] = args as [IpcContext]
    const provider = await providerForContext(ctx)
    if (!provider) return { connected: false }
    return provider.auth.status()
  })

  server.register('providerConnect', async (args) => {
    const [ctx] = args as [IpcContext]
    const provider = await providerForContext(ctx)
    if (!provider) throw new Error('No git provider is available for this repository.')
    try {
      // Stream the device/user code to the renderer without blocking the
      // promise — the modal shows the code while connect() keeps polling.
      return await provider.auth.connect((prompt) => {
        server.broadcast('provider-device-code', prompt)
      })
    } catch (err) {
      // User-initiated cancellation isn't a failure; surface it without log noise.
      if (err instanceof ConnectCancelledError) throw err
      const message = err instanceof Error ? err.message : String(err)
      log.error(`providerConnect failed: ${message}`)
      throw err
    }
  })

  server.register('providerCancelConnect', async (args) => {
    const [ctx] = args as [IpcContext]
    const provider = await providerForContext(ctx)
    provider?.auth.cancelConnect()
  })

  server.register('providerDisconnect', async (args) => {
    const [ctx] = args as [IpcContext]
    const provider = await providerForContext(ctx)
    provider?.auth.disconnect()
  })

  server.register('providerViewer', async (args) => {
    const [ctx] = args as [IpcContext]
    const provider = await providerForContext(ctx)
    if (!provider) throw new Error('No git provider is available for this repository.')
    return provider.review.getViewer()
  })

  // ─── PR review mode ─────────────────────────────────────────────────────────

  server.register('prList', async (args) => {
    const [ctx, filter, page = 1] = args as [IpcContext, PrFilter | undefined, number | undefined]
    const { repo, provider } = await reviewTargetFor(ctx)
    const [result, viewer] = await Promise.all([
      provider.review.listPullRequestsPage(repo, filter, page),
      provider.review.getViewer(),
    ])
    result.items = attachReviewAttention(result.items, viewer)
    const cwd = ctx.session.projectPath || ctx.session.workingDirectory
    // Stack inference is advisory: even resolving the local repo root happens
    // after the PR response is ready, so a slow/failing heuristic cannot delay it.
    if (cwd) void resolveRepoRoot(cwd).then((repoRoot) => {
      if (!repoRoot) return
      const isOpenPage = (!filter?.state || filter.state === 'open') && !filter?.author
      if (!isOpenPage) return
      const isCompleteOpenList = page === 1 && !result.hasMore
      scheduleStackDetection({
        repoRoot,
        repo,
        provider,
        openPullRequests: result.items,
        openPullRequestsComplete: isCompleteOpenList,
        onUpdate: (graph) => {
          server.broadcast('stack-graph-update', repoRoot, graph)
          if (isCompleteOpenList) {
            scheduleGuideWarming({
              ctx,
              repoRoot,
              repo,
              provider,
              openPullRequests: result.items,
              graph,
              isWorktreeInUse: deps.isWorktreeInUse,
            })
          }
        },
      })
    }).catch((err) => log.warn(`stack detection trigger failed: ${err instanceof Error ? err.message : String(err)}`))
    return result
  })

  server.register('prGetEfforts', async (args) => {
    const [ctx, requests] = args as [IpcContext, PrEffortRequest[]]
    const { repo, provider } = await reviewTargetFor(ctx)
    return loadReviewEfforts(requests.slice(0, 30), repo, provider)
  })

  server.register('prGuideMetadata', async (args) => {
    const [ctx, requests] = args as [IpcContext, PrGuideMetadataRequest[]]
    const repoRoot = await repoRootForContext(ctx)
    return readPrGuideMetadata(repoRoot, await readStackGraph(repoRoot), requests)
  })

  server.register('prOpenReview', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    return openPrReview(ctx, number)
  })

  server.register('prMerge', async (args): Promise<PrMergeResult> => {
    const [ctx, number, method] = args as [IpcContext, number, MergeMethod]
    const { repo, provider } = await reviewTargetFor(ctx)
    const result = await provider.review.mergePullRequest(repo, number, method)
    if (result.merged) {
      const cwd = ctx.session.projectPath || ctx.session.workingDirectory
      if (cwd) server.broadcast('prs-changed', cwd)
    }
    return result
  })

  server.register('prPrepareConflictResolution', async (args): Promise<PrConflictResolutionResult> => {
    const [ctx, number] = args as [IpcContext, number]
    try {
      const { repo, provider } = await reviewTargetFor(ctx)
      const detail = await provider.review.getPullRequest(repo, number)
      if (detail.headRepo.isFork) {
        return { success: false, error: 'This pull request comes from a fork. Resolve conflicts on the contributor branch.' }
      }

      const base = ctx.session.projectPath || ctx.session.workingDirectory
      const repoRoot = (await resolveRepoRoot(base)) ?? base
      const worktree = await fetchAndCheckoutPr(repoRoot, number, detail.baseRef)
      let state = await computeGitState(worktree.worktreePath)
      const hasActiveMerge = state?.uncommittedChanges.mergeInProgress
        || state?.uncommittedChanges.files.some((file) => file.conflicted)

      if (!hasActiveMerge) {
        await runAsync('git', ['fetch', 'origin', detail.baseRef], worktree.worktreePath)
        let mergeError = ''
        await runAsync(
          'git',
          ['merge', '--no-commit', '--no-ff', `origin/${detail.baseRef}`],
          worktree.worktreePath,
        ).catch((err) => {
          mergeError = err?.message ?? String(err)
        })
        state = await computeGitState(worktree.worktreePath)
        const mergeStarted = state?.uncommittedChanges.mergeInProgress
          || state?.uncommittedChanges.files.some((file) => file.conflicted)
        if (!mergeStarted) {
          return {
            success: false,
            error: mergeError || 'The pull request no longer has conflicts with its base branch.',
          }
        }
      }

      return {
        success: true,
        review: {
          host: repo.host,
          owner: repo.owner,
          repo: repo.repo,
          number,
          title: detail.title,
          baseRef: detail.baseRef,
          headRef: detail.headRef,
          headSha: worktree.headSha,
          baseSha: worktree.baseSha,
          headRepo: detail.headRepo,
          worktreePath: worktree.worktreePath,
          branch: worktree.branch,
        },
        conflictFiles: state?.uncommittedChanges.files.filter((file) => file.conflicted).map((file) => file.path) ?? [],
        headRef: detail.headRef,
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  server.register('prGetDetail', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.getPullRequest(repo, number)
  })

  server.register('prGetOverview', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.getPullRequestOverview(repo, number)
  })

  server.register('prListThreads', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listReviewThreads(repo, number)
  })

  server.register('prListComments', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listComments(repo, number)
  })

  server.register('prListCommits', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listCommits(repo, number)
  })

  server.register('prListReviewers', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listReviewers(repo, number)
  })

  server.register('prChangedFiles', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listPullRequestFileStats(repo, number)
  })

  server.register('prSubmitReview', async (args) => {
    const [ctx, number, review] = args as [IpcContext, number, DraftReview]
    const { repo, provider } = await reviewTargetFor(ctx)
    if (review.event === 'APPROVE') {
      const [pullRequest, viewer] = await Promise.all([
        provider.review.getPullRequest(repo, number),
        provider.review.getViewer(),
      ])
      if (pullRequest.author.toLowerCase() === viewer.toLowerCase()) {
        throw new Error("GitHub doesn't allow you to approve your own pull request")
      }
    }
    await provider.review.createReview(repo, number, review)
    // The provider response is the user-visible completion boundary. Persisting
    // the local interdiff checkpoint must not hold the submitted modal open.
    void persistReviewCheckpoint(ctx, repo, provider, number, review).catch((err) => {
      log.warn(`review submitted for PR #${number}, but its checkpoint failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  })

  server.register('prAddIssueComment', async (args) => {
    const [ctx, number, body] = args as [IpcContext, number, string]
    const { repo, provider } = await reviewTargetFor(ctx)
    await provider.review.addIssueComment(repo, number, body)
  })

  server.register('prInterdiff', async (args) => {
    const [ctx, pr] = args as [IpcContext, PrReviewContext]
    const { repo, provider } = await reviewTargetFor(ctx)
    const [threads, auth] = await Promise.all([
      provider.review.listReviewThreads(repo, pr.number),
      provider.auth.status(),
    ])
    // Anchor this reviewer's feedback, not every participant's conversation.
    // Older stored credentials may lack login; falling back preserves comments.
    const reviewerThreads = auth.login
      ? threads.filter((thread) => thread.comments[0]?.author.toLowerCase() === auth.login?.toLowerCase())
      : threads
    return computePrInterdiff({
      repoRoot: await repoRootForContext(ctx),
      gitCwd: pr.worktreePath,
      prNumber: pr.number,
      currentHead: pr.headSha,
      currentBase: pr.baseSha,
      threads: reviewerThreads,
    })
  })

  server.register('prReplyThread', async (args) => {
    const [ctx, , threadId, body] = args as [IpcContext, number, string, string]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.replyToThread(repo, threadId, body)
  })

  server.register('prResolveThread', async (args) => {
    const [ctx, , threadId] = args as [IpcContext, number, string]
    const { repo, provider } = await reviewTargetFor(ctx)
    await provider.review.resolveThread(repo, threadId)
  })

  server.register('prUnresolveThread', async (args) => {
    const [ctx, , threadId] = args as [IpcContext, number, string]
    const { repo, provider } = await reviewTargetFor(ctx)
    await provider.review.unresolveThread(repo, threadId)
  })

  // Explicit opt-in guide generation: queue the PRs and return immediately;
  // progress streams back over `pr-guide-status`.
  server.register('prGenerateGuides', async (args) => {
    const [ctx, numbers] = args as [IpcContext, number[]]
    const { repo, provider } = await reviewTargetFor(ctx)
    const repoRoot = await repoRootForContext(ctx)
    requestPrGuides({
      ctx,
      repoRoot,
      repo,
      provider,
      graph: await readStackGraph(repoRoot),
      isWorktreeInUse: deps.isWorktreeInUse,
      onStatus: (number, status, metadata) => server.broadcast('pr-guide-status', {
        repoRoot,
        number,
        status,
        ...(metadata ? { metadata } : {}),
      }),
    }, numbers)
  })
}
