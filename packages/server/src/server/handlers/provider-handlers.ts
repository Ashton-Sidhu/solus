import { createLogger } from '../../logger'
import { getProvider, providerForRepo } from '../../providers/registry'
import { ConnectCancelledError } from '../../providers/github/auth'
import { loadToken } from '../../providers/github/token-store'
import { computeGitState, resolveRepoRef, resolveRepoRoot } from '../../git/git-helpers'
import { repoRootOrScope } from '../../git/ctx-paths'
import { fetchAndCheckoutPr } from '../../git/worktree-manager'
import { emptyStackGraph, readStackGraph, scheduleStackDetection } from '../../git/stack-detect'
import { computePrInterdiff } from '../../git/interdiff'
import { runAsync } from '../../git/exec'
import { writeReviewCheckpoint } from '../../review/checkpoints'
import { estimateReviewEffort } from '../../review/effort'
import { readPrGuideMetadata, requestPrGuides, scheduleGuideWarming } from '../../review/guide-warmer'
import type { Provider, RepoRef } from '../../providers/types'
import type { PrEffortRequest, PrEffortResult, PrReviewTarget, DraftReview, PullRequestUpdate } from '@solus/contracts/providers'
import { projectScopeOf, type GithubDelegatedCredential, type IpcContext, type PrCheckoutContext, type PrConflictResolutionResult, type PrMergeResult } from '@solus/contracts/types'
import { LOCAL_DEVICE_LABEL, type SolusServer } from '../server'
import { attachReviewAttention } from './review-attention'
import type { AgentDispatcher } from '../../agents/agent-runner'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import { Task } from '../../tasks/task'
import { buildPrReviewTarget } from '../../providers/pr-review-target'

const log = createLogger('main', 'provider-handlers')
const EFFORT_FETCH_CONCURRENCY = 4
type ReviewEffortStats = Pick<PrEffortResult, 'effort' | 'additions' | 'deletions'>
const effortCache = new Map<string, Promise<ReviewEffortStats | undefined>>()
const checkoutRequests = new Map<string, Promise<PrCheckoutContext>>()

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
  const results: R[] = []
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
          log.warn('review_effort_unavailable', { prNumber: request.number, error: err instanceof Error ? err.message : String(err) })
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
  const cwd = projectScopeOf(ctx.session)
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
  const cwd = projectScopeOf(ctx.session)
  const repo = cwd ? await resolveRepoRef(cwd) : null
  if (!repo) throw new Error('This folder has no recognizable git remote to review PRs from.')
  const provider = providerForRepo(repo)
  if (!provider) throw new Error(`PR review isn't supported for ${repo.host} yet.`)
  return { repo, provider }
}

/** Resolve the exact host revision. Reading a PR must not mutate local git state. */
async function openPrReview(ctx: IpcContext, number: number): Promise<PrReviewTarget> {
  const { repo, provider } = await reviewTargetFor(ctx)
  const detail = await provider.review.getPullRequest(repo, number)
  const baseSha = await provider.review.getPullRequestDiffBase(repo, detail)
  const target = buildPrReviewTarget(repo, detail, baseSha)
  log.info('pr_review_opened_host_only', { host: repo.host, owner: repo.owner, repo: repo.repo, prNumber: number, headSha: detail.headSha })
  return target
}

async function preparePrCheckout(ctx: IpcContext, target: PrReviewTarget): Promise<PrCheckoutContext> {
  const { repo, provider } = await reviewTargetFor(ctx)
  if (repo.host !== target.host || repo.owner !== target.owner || repo.repo !== target.repo) {
    throw new Error('The pull request does not belong to this project.')
  }
  const key = `${repo.host}/${repo.owner}/${repo.repo}:${target.number}:${target.baseSha}:${target.headSha}`
  const existing = checkoutRequests.get(key)
  if (existing) return existing
  log.info('pr_checkout_requested', { host: repo.host, owner: repo.owner, repo: repo.repo, prNumber: target.number, headSha: target.headSha })
  const operation = (async (): Promise<PrCheckoutContext> => {
    const detail = await provider.review.getPullRequest(repo, target.number)
    if (detail.headSha !== target.headSha) {
      throw new Error('This pull request changed. Refresh it before preparing a checkout.')
    }
    const repoRoot = await repoRootOrScope(ctx)
    const checkout = await fetchAndCheckoutPr(repoRoot, target.number, detail.baseRef, {
      headRef: detail.headRef,
      isFork: detail.headRepo.isFork,
    })
    if (checkout.headSha !== target.headSha || checkout.baseSha !== target.baseSha) {
      throw new Error('The prepared checkout does not match the pull request revision. Refresh it and try again.')
    }
    log.info(checkout.reused ? 'pr_checkout_reused' : 'pr_checkout_created', { host: repo.host, owner: repo.owner, repo: repo.repo, prNumber: target.number, headSha: checkout.headSha, worktreePath: checkout.worktreePath })
    return checkout
  })().catch((error) => {
    log.warn('pr_checkout_failed', { host: repo.host, owner: repo.owner, repo: repo.repo, prNumber: target.number, headSha: target.headSha, error: error instanceof Error ? error.message : String(error) })
    throw error
  }).finally(() => {
    if (checkoutRequests.get(key) === operation) checkoutRequests.delete(key)
  })
  checkoutRequests.set(key, operation)
  return operation
}

async function persistReviewCheckpoint(
  ctx: IpcContext,
  repo: RepoRef,
  provider: Provider,
  number: number,
  review: DraftReview,
): Promise<void> {
  const repoRoot = await repoRootOrScope(ctx)
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
      log.warn('review_checkpoint_merge_base_unresolved', { prNumber: number })
      return
    }
  }
  const saved = await writeReviewCheckpoint(repoRoot, {
    prNumber: number,
    headSha: review.commitId,
    base: checkpointBase,
    reviewedAt: new Date().toISOString(),
  })
  if (!saved) log.warn('review_checkpoint_save_failed', { prNumber: number })
}

export interface ProviderHandlerDeps {
  isWorktreeInUse: (path: string) => boolean
  dispatcher: AgentDispatcher
  events: HostEventPublisher
}

export function registerProviderHandlers(server: SolusServer, deps: ProviderHandlerDeps): void {
  server.register('providerStatus', async (args) => {
    const [ctx] = args
    const provider = await providerForContext(ctx)
    if (!provider) return { connected: false }
    return provider.auth.status()
  })

  server.register('providerConnect', async (args, handlerCtx) => {
    const [ctx] = args
    const provider = await providerForContext(ctx)
    if (!provider) throw new Error('No git provider is available for this repository.')
    try {
      // Stream the device/user code to the renderer without blocking the
      // promise — the modal shows the code while connect() keeps polling.
      return await provider.auth.connect((prompt) => {
        if (handlerCtx.clientId) deps.events.publish(handlerCtx.clientId, 'provider.deviceCodeReceived', prompt)
      })
    } catch (err) {
      // User-initiated cancellation isn't a failure; surface it without log noise.
      if (err instanceof ConnectCancelledError) throw err
      const message = err instanceof Error ? err.message : String(err)
      log.error('provider_connect_failed', { error: message })
      throw err
    }
  })

  server.register('providerCancelConnect', async (args) => {
    const [ctx] = args
    const provider = await providerForContext(ctx)
    provider?.auth.cancelConnect()
  })

  server.register('providerDisconnect', async (args) => {
    const [ctx] = args
    const provider = await providerForContext(ctx)
    provider?.auth.disconnect()
  })

  // The desktop renderer is itself a WS-paired device, so without this gate any
  // paired phone or laptop could pull the user's GitHub token off their machine.
  server.register('githubExportCredential', async (_args, ctx): Promise<GithubDelegatedCredential> => {
    if (ctx.deviceLabel !== LOCAL_DEVICE_LABEL) {
      throw new Error('Only this device can export its GitHub credential.')
    }

    const token = loadToken()
    if (!token) throw new Error('Connect GitHub on this device first.')

    const login = token.login ?? await getProvider('github')?.review.getViewer()
    if (!login) throw new Error('Connect GitHub on this device first.')

    log.info('github_credential_exported')
    return { accessToken: token.accessToken, login }
  })

  server.register('providerViewer', async (args) => {
    const [ctx] = args
    const provider = await providerForContext(ctx)
    if (!provider) throw new Error('No git provider is available for this repository.')
    return provider.review.getViewer()
  })

  // ─── PR review mode ─────────────────────────────────────────────────────────

  server.register('prList', async (args) => {
    const [ctx, filter, page = 1] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const [result, viewer] = await Promise.all([
      provider.review.listPullRequestsPage(repo, filter, page),
      provider.review.getViewer(),
    ])
    result.items = attachReviewAttention(result.items, viewer)
    const cwd = projectScopeOf(ctx.session)
    const sessionId = ctx.session.agentSessionId
    const branch = ctx.session.gitContext?.branch
    const sessionPullRequest = branch
      ? result.items.find((pullRequest) => pullRequest.headRef === branch)
      : undefined
    if (cwd && sessionId && sessionPullRequest) {
      const url = `https://${repo.host}/${repo.owner}/${repo.repo}/pull/${sessionPullRequest.number}`
      const task = await Task.forSession(sessionId)
      await task?.linkPullRequest({
        number: sessionPullRequest.number,
        title: `#${sessionPullRequest.number} ${sessionPullRequest.title}`,
        url,
        targetScope: cwd,
        originSessionId: sessionId,
        createdBy: 'agent',
      }).catch((error) => {
        log.warn('task_pr_link_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    // Stack inference is experimental and advisory: even resolving the local
    // repo root happens after the PR response is ready, so it cannot delay it.
    if (cwd) void resolveRepoRoot(cwd).then((repoRoot) => {
      if (!repoRoot) return
      const isOpenPage = (!filter?.state || filter.state === 'open') && !filter?.author
      if (!isOpenPage) return
      const isCompleteOpenList = page === 1 && !result.hasMore
      if (!ctx.settings.stackedPrsEnabled) {
        if (isCompleteOpenList) {
          scheduleGuideWarming({
            dispatcher: deps.dispatcher,
            ctx,
            repoRoot,
            repo,
            provider,
            openPullRequests: result.items,
            graph: emptyStackGraph(),
            isWorktreeInUse: deps.isWorktreeInUse,
          })
        }
        return
      }
      scheduleStackDetection({
        repoRoot,
        repo,
        provider,
        openPullRequests: result.items,
        openPullRequestsComplete: isCompleteOpenList,
        onUpdate: (graph) => {
          deps.events.broadcast('stack.graphChanged', { repoRoot, graph })
          if (isCompleteOpenList) {
            scheduleGuideWarming({
              dispatcher: deps.dispatcher,
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
    }).catch((err) => log.warn('stack_detection_trigger_failed', { error: err instanceof Error ? err.message : String(err) }))
    return result
  })

  server.register('prNeedsReview', async (args) => {
    const [ctx] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const viewer = await provider.review.getViewer()
    return attachReviewAttention(
      await provider.review.listPullRequestsNeedingReview(repo, viewer),
      viewer,
    ).filter((pr) => pr.needsMyReview)
  })

  server.register('prGetEfforts', async (args) => {
    const [ctx, requests] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return loadReviewEfforts(requests.slice(0, 30), repo, provider)
  })

  server.register('prGuideMetadata', async (args) => {
    const [ctx, requests] = args
    const repoRoot = await repoRootOrScope(ctx)
    const graph = ctx.settings.stackedPrsEnabled ? await readStackGraph(repoRoot) : null
    return readPrGuideMetadata(repoRoot, graph, requests)
  })

  server.register('prOpenReview', async (args) => {
    const [ctx, number] = args
    return openPrReview(ctx, number)
  })

  server.register('prGetDiff', async (args) => {
    const [ctx, request] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.getPullRequestDiff(repo, request)
  })

  server.register('prGetDiffFileContents', async (args) => {
    const [ctx, request] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.getPullRequestDiffFileContents(repo, request)
  })

  server.register('prPrepareCheckout', async (args) => {
    const [ctx, target] = args
    return preparePrCheckout(ctx, target)
  })

  server.register('prMerge', async (args): Promise<PrMergeResult> => {
    const [ctx, number, method, expectedHeadSha] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const detail = await provider.review.getPullRequest(repo, number)
    if (detail.headSha !== expectedHeadSha) {
      throw new Error('This pull request changed. Refresh it before merging.')
    }
    if (!detail.viewerPermissions.actions.includes('merge')) throw new Error('You do not have permission to merge this pull request.')
    if (!detail.capabilities.mergeMethods.includes(method)) throw new Error(`The repository does not allow ${method} merges.`)
    const result = await provider.review.mergePullRequest(repo, number, method)
    if (result.merged) {
      const projectPath = projectScopeOf(ctx.session)
      const { completeTasksForMergedPullRequest } = await import('../../tasks/sync-engine')
      await completeTasksForMergedPullRequest(projectPath, number)
      const updated = await provider.review.getPullRequest(repo, number)
      return { ...result, detail: updated }
    }
    return result
  })

  server.register('prPrepareConflictResolution', async (args): Promise<PrConflictResolutionResult> => {
    const [ctx, number] = args
    try {
      const { repo, provider } = await reviewTargetFor(ctx)
      const detail = await provider.review.getPullRequest(repo, number)
      if (detail.headRepo.isFork) {
        return { success: false, error: 'This pull request comes from a fork. Resolve conflicts on the contributor branch.' }
      }

      const repoRoot = await repoRootOrScope(ctx)
      const worktree = await fetchAndCheckoutPr(repoRoot, number, detail.baseRef, {
        headRef: detail.headRef,
        isFork: detail.headRepo.isFork,
      })
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
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.getPullRequest(repo, number)
  })

  server.register('prUpdate', async (args) => {
    const [ctx, number, patch] = args
    const title = patch.title?.trim()
    if (patch.title !== undefined && !title) throw new Error('A pull request title cannot be empty.')
    const { repo, provider } = await reviewTargetFor(ctx)
    const updates: PullRequestUpdate = {}
    if (title !== undefined) updates.title = title
    if (patch.body !== undefined) updates.body = patch.body
    const updated = await provider.review.updatePullRequest(repo, number, updates)
    const sessionId = ctx.session.agentSessionId
    if (sessionId) {
      await Task.linkArtifactForSession(sessionId, {
        kind: 'pr',
        targetScope: projectScopeOf(ctx.session),
        targetKey: String(number),
        title: updated.title,
      }).catch((error) => {
        log.warn('task_pr_link_failed', {
          sessionId,
          number,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    const cwd = projectScopeOf(ctx.session)
    if (cwd) deps.events.broadcast('prs.invalidated', { projectRoot: cwd })
    return updated
  })

  server.register('prGetOverview', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.getPullRequestOverview(repo, number)
  })

  server.register('prListThreads', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listReviewThreads(repo, number)
  })

  server.register('prListComments', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listComments(repo, number)
  })

  server.register('prListCommits', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listCommits(repo, number)
  })

  server.register('prListReviewers', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listReviewers(repo, number)
  })

  server.register('prListReviewerCandidates', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const detail = await provider.review.getPullRequest(repo, number)
    if (!detail.viewerPermissions.requestReviewers) throw new Error('You do not have permission to request reviewers.')
    return provider.review.listReviewerCandidates(repo, number)
  })

  server.register('prRequestReviewers', async (args) => {
    const [ctx, number, requestedLogins] = args
    const logins = [...new Set(requestedLogins.map((login) => login.trim()).filter(Boolean))]
    if (logins.length === 0) throw new Error('Select at least one reviewer.')
    const { repo, provider } = await reviewTargetFor(ctx)
    const detail = await provider.review.getPullRequest(repo, number)
    if (!detail.viewerPermissions.requestReviewers) throw new Error('You do not have permission to request reviewers.')
    const reviewers = await provider.review.requestReviewers(repo, number, logins)
    return reviewers
  })

  server.register('prRemoveRequestedReviewer', async (args) => {
    const [ctx, number, requestedLogin] = args
    const login = requestedLogin.trim()
    if (!login) throw new Error('A reviewer login is required.')
    const { repo, provider } = await reviewTargetFor(ctx)
    const detail = await provider.review.getPullRequest(repo, number)
    if (!detail.viewerPermissions.requestReviewers) throw new Error('You do not have permission to remove requested reviewers.')
    const reviewers = await provider.review.removeRequestedReviewer(repo, number, login)
    return reviewers
  })

  server.register('prUpdateLifecycle', async (args) => {
    const [ctx, number, action, expectedHeadSha] = args
    if (!['close', 'reopen', 'ready', 'draft'].includes(action)) throw new Error('Unsupported pull request action.')
    const { repo, provider } = await reviewTargetFor(ctx)
    const detail = await provider.review.updatePullRequestLifecycle(repo, number, action, expectedHeadSha)
    const projectRoot = projectScopeOf(ctx.session)
    if (projectRoot) deps.events.broadcast('pr.lifecycleChanged', { projectRoot, detail })
    return detail
  })

  server.register('prChangedFiles', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listPullRequestFileStats(repo, number)
  })

  server.register('prSubmitReview', async (args) => {
    const [ctx, number, review] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const pullRequest = await provider.review.getPullRequest(repo, number)
    if (pullRequest.headSha !== review.commitId) {
      throw new Error('This pull request changed. Refresh the diff before submitting your review.')
    }
    const verdict = review.event === 'APPROVE'
      ? 'approve'
      : review.event === 'REQUEST_CHANGES'
        ? 'request-changes'
        : 'comment'
    if (!pullRequest.viewerPermissions.reviewVerdicts.includes(verdict)) {
      throw new Error('You do not have permission to submit this review verdict.')
    }
    if (review.event === 'APPROVE') {
      const viewer = await provider.review.getViewer()
      if (pullRequest.author.toLowerCase() === viewer.toLowerCase()) {
        throw new Error("GitHub doesn't allow you to approve your own pull request")
      }
    }
    await provider.review.createReview(repo, number, review)
    // The provider response is the user-visible completion boundary. Persisting
    // the local interdiff checkpoint must not hold the submitted modal open.
    void persistReviewCheckpoint(ctx, repo, provider, number, review).catch((err) => {
      log.warn('review_checkpoint_failed', { prNumber: number, error: err instanceof Error ? err.message : String(err) })
    })
  })

  server.register('prAddIssueComment', async (args) => {
    const [ctx, number, body] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const pullRequest = await provider.review.getPullRequest(repo, number)
    if (!pullRequest.viewerPermissions.comment) throw new Error('You do not have permission to comment on this pull request.')
    await provider.review.addIssueComment(repo, number, body)
  })

  server.register('prDeleteIssueComment', async (args) => {
    const [ctx, number, commentId] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const [comments, viewer] = await Promise.all([
      provider.review.listComments(repo, number),
      provider.auth.status(),
    ])
    const comment = comments.find((item) => item.id === commentId)
    if (!comment || comment.kind !== 'comment') throw new Error('This pull request comment no longer exists.')
    if (!viewer.login || comment.author.toLowerCase() !== viewer.login.toLowerCase()) {
      throw new Error('You can only delete your own pull request comments.')
    }
    await provider.review.deleteIssueComment(repo, commentId)
  })

  server.register('prInterdiff', async (args) => {
    const [ctx, pr] = args
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
      repoRoot: await repoRootOrScope(ctx),
      gitCwd: pr.worktreePath,
      prNumber: pr.number,
      currentHead: pr.headSha,
      currentBase: pr.baseSha,
      threads: reviewerThreads,
    })
  })

  server.register('prReplyThread', async (args) => {
    const [ctx, , threadId, body] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.replyToThread(repo, threadId, body)
  })

  server.register('prResolveThread', async (args) => {
    const [ctx, , threadId] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    await provider.review.resolveThread(repo, threadId)
  })

  server.register('prUnresolveThread', async (args) => {
    const [ctx, , threadId] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    await provider.review.unresolveThread(repo, threadId)
  })

  // Explicit opt-in guide generation: queue the PRs and return immediately;
  // progress is published as typed host events.
  server.register('prGenerateGuides', async (args) => {
    const [ctx, numbers] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const repoRoot = await repoRootOrScope(ctx)
    requestPrGuides({
      dispatcher: deps.dispatcher,
      ctx,
      repoRoot,
      repo,
      provider,
      graph: ctx.settings.stackedPrsEnabled ? await readStackGraph(repoRoot) : null,
      isWorktreeInUse: deps.isWorktreeInUse,
      onStatus: (number, status, metadata) => {
        const event = { repoRoot, number, status }
        if (metadata) Object.assign(event, { metadata })
        deps.events.broadcast('pr.guideStatusChanged', event)
      },
    }, numbers)
  })
}
