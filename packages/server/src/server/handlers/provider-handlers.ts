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
import type { PrEffortRequest, PrEffortResult, PrListPage, PrReviewTarget, DraftReview, PullRequestUpdate } from '@solus/contracts/providers'
import { projectScopeOf, type GithubDelegatedCredential, type IpcContext, type PrCheckoutContext, type PrConflictResolutionResult, type PrMergeResult } from '@solus/contracts/types'
import { LOCAL_DEVICE_LABEL, type SolusServer } from '../server'
import { attachReviewAttention } from './review-attention'
import type { AgentDispatcher } from '../../agents/agent-runner'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import { Task } from '../../tasks/task'
import { buildPrReviewTarget } from '../../providers/pr-review-target'
import type { ReviewTarget } from '@solus/contracts/review'
import { ensureManagedPrCheckout } from '../../review/managed-pr-checkout'
import { prIndex } from '../../prs/pr-index'
import type { PullRequest } from '../../prs/pull-request'

const log = createLogger('main', 'provider-handlers')
const EFFORT_FETCH_CONCURRENCY = 4
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

/**
 * Review effort is a reading of the changed-file counts, not a separate fact, so
 * it keeps no cache of its own: it asks the pull request for the counts it
 * already holds. The request names the revision it is asking about, which is
 * what makes a push produce a new answer rather than the size of the diff it
 * replaced.
 *
 * A pull request whose counts cannot be read is returned unchanged: a listing
 * missing one row's effort is a smaller answer, not a broken page.
 */
async function loadReviewEfforts(
  requests: PrEffortRequest[],
  repo: RepoRef,
  provider: Provider,
): Promise<PrEffortResult[]> {
  return mapWithConcurrency(requests, EFFORT_FETCH_CONCURRENCY, async (request) => {
    try {
      const pullRequest = prIndex.pullRequest(repo, provider, request.number)
      const fileStats = await pullRequest.changedFiles(request.headSha)
      return {
        ...request,
        effort: estimateReviewEffort({
          fileStats,
          generatedPaths: fileStats.filter((file) => isGeneratedPath(file.path)).map((file) => file.path),
          renamedPaths: [],
        }),
        additions: fileStats.reduce((total, file) => total + file.additions, 0),
        deletions: fileStats.reduce((total, file) => total + file.deletions, 0),
      }
    } catch (err) {
      log.warn('review_effort_unavailable', { prNumber: request.number, error: err instanceof Error ? err.message : String(err) })
      return request
    }
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

/**
 * Run a write against a pull request, and forget what the write invalidates.
 *
 * The forgetting belongs here rather than in each handler. A write changes the
 * pull request it touched and reorders every listing that pull request appears
 * on, so the client that made it *and* every other client must see the action on
 * their next read without asking for it. Doing that at each call site made it
 * something thirteen handlers had to remember; doing it here makes it something
 * they cannot skip.
 *
 * A write only forgets; it never seeds what it just wrote. The host's state
 * after a write is the host's to report — a merge closes a pull request, a
 * lifecycle change moves it between listings — so the next read goes and asks.
 */
async function writePullRequest<T>(
  ctx: IpcContext,
  number: number,
  write: (target: { repo: RepoRef; provider: Provider; pullRequest: PullRequest }) => Promise<T>,
): Promise<T> {
  const { repo, provider } = await reviewTargetFor(ctx)
  const pullRequest = prIndex.pullRequest(repo, provider, number)
  const result = await write({ repo, provider, pullRequest })
  prIndex.invalidate(repo)
  return result
}

/** Resolve the exact host revision. Reading a PR must not mutate local git state. */
export async function openPrReview(ctx: IpcContext, number: number): Promise<PrReviewTarget> {
  const { repo, provider } = await reviewTargetFor(ctx)
  // Fresh, not remembered: the `headSha` on the target this returns becomes the
  // revision every later write is checked against, so it has to be the host's.
  const detail = await prIndex.pullRequest(repo, provider, number).readFresh()
  const baseSha = await provider.review.getPullRequestDiffBase(repo, detail)
  const target = buildPrReviewTarget(repo, detail, baseSha)
  log.info('pr_review_opened_host_only', { host: repo.host, owner: repo.owner, repo: repo.repo, prNumber: number, headSha: detail.headSha })
  return target
}

export async function preparePrCheckout(ctx: IpcContext, target: PrReviewTarget): Promise<PrCheckoutContext> {
  const { repo, provider } = await reviewTargetFor(ctx)
  if (repo.host !== target.host || repo.owner !== target.owner || repo.repo !== target.repo) {
    throw new Error('The pull request does not belong to this project.')
  }
  const key = `${repo.host}/${repo.owner}/${repo.repo}:${target.number}:${target.baseSha}:${target.headSha}`
  const existing = checkoutRequests.get(key)
  if (existing) return existing
  log.info('pr_checkout_requested', { host: repo.host, owner: repo.owner, repo: repo.repo, prNumber: target.number, headSha: target.headSha })
  const operation = (async (): Promise<PrCheckoutContext> => {
    // A guard: the point is to learn whether the pull request moved since the
    // client read it, which a remembered answer cannot say.
    const detail = await prIndex.pullRequest(repo, provider, target.number).readFresh()
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

export async function prepareReviewGuidePrContext(
  ctx: IpcContext,
  requested: Extract<ReviewTarget, { kind: 'pr' }>,
): Promise<{ ctx: IpcContext; target: Extract<ReviewTarget, { kind: 'pr' }> }> {
  const repo: RepoRef = {
    host: requested.host,
    owner: requested.owner,
    repo: requested.repo,
  }
  const provider = providerForRepo(repo)
  if (!provider) throw new Error(`PR review isn't supported for ${repo.host} yet.`)

  // Resolve the host revision from the URL's repository, not from the active
  // project. A review command is allowed to target any accessible pull request.
  const detail = await provider.review.getPullRequest(repo, requested.number)
  const current = buildPrReviewTarget(
    repo,
    detail,
    await provider.review.getPullRequestDiffBase(repo, detail),
  )
  const target = requested.baseSha && requested.headSha
    ? { ...requested, baseSha: requested.baseSha, headSha: requested.headSha }
    : {
        ...requested,
        baseSha: current.baseSha,
        headSha: current.headSha,
      }

  const cwd = projectScopeOf(ctx.session)
  const activeRepo = cwd ? await resolveRepoRef(cwd) : null
  const isActiveRepo = activeRepo
    && activeRepo.host.toLowerCase() === repo.host.toLowerCase()
    && activeRepo.owner.toLowerCase() === repo.owner.toLowerCase()
    && activeRepo.repo.toLowerCase() === repo.repo.toLowerCase()
  const isCurrentRevision = target.baseSha === current.baseSha && target.headSha === current.headSha
  const checkout = isActiveRepo && isCurrentRevision
    ? await preparePrCheckout(ctx, current)
    : await ensureManagedPrCheckout(repo, target)
  return {
    ctx: {
      ...ctx,
      session: {
        ...ctx.session,
        workingDirectory: checkout.worktreePath,
        gitContext: {
          branch: checkout.branch,
          targetBranch: current.baseRef,
          worktreePath: checkout.worktreePath,
        },
        prReview: { ...current, ...checkout },
      },
    },
    target,
  }
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
    const [page1, viewer] = await Promise.all([
      prIndex.list(repo, provider, filter, page),
      provider.review.getViewer(),
    ])
    // Copied rather than assigned into: `page1` is the index's own object, and
    // decorating it in place would write this viewer's attention flags onto the
    // answer every other reader shares.
    const result: PrListPage = { ...page1, items: attachReviewAttention(page1.items, viewer) }
    const cwd = projectScopeOf(ctx.session)
    const sessionId = ctx.session.agentSessionId
    const branch = ctx.session.gitContext?.branch
    const sessionPullRequest = branch
      ? result.items.find((pullRequest) => pullRequest.headRef === branch)
      : undefined
    // A shared clone's branch is whatever the developer last checked out, so
    // every session reading this list from the project root would record the
    // same pull request. Only a session's own worktree speaks for its branch.
    const isolatedCheckout = !!ctx.session.gitContext?.worktreePath
    if (cwd && sessionId && sessionPullRequest && isolatedCheckout) {
      const task = await Task.forSession(sessionId)
      await task?.linkPullRequest({
        number: sessionPullRequest.number,
        title: `#${sessionPullRequest.number} ${sessionPullRequest.title}`,
        url: sessionPullRequest.url,
        targetScope: cwd,
        originSessionId: sessionId,
        // Listing is observation, not an agent-authored relationship. Keep its
        // provenance automatic so a mounted checkout can replace stale state.
        createdBy: 'system',
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
      await prIndex.listNeedsReview(repo, provider, viewer),
      viewer,
    ).filter((pr) => pr.needsMyReview)
  })

  server.register('prGetEfforts', async (args) => {
    const [ctx, requests] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return loadReviewEfforts(requests.slice(0, 30), repo, provider)
  })

  server.register('prGuideMetadata', async (args) => {
    const [ctx, request] = args
    const repoRoot = await repoRootOrScope(ctx)
    const graph = ctx.settings.stackedPrsEnabled ? await readStackGraph(repoRoot) : null
    return readPrGuideMetadata(repoRoot, graph, request)
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
    return writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const detail = await pullRequest.readFresh()
      if (detail.headSha !== expectedHeadSha) {
        throw new Error('This pull request changed. Refresh it before merging.')
      }
      if (!detail.viewerPermissions.actions.includes('merge')) throw new Error('You do not have permission to merge this pull request.')
      if (!detail.capabilities.mergeMethods.includes(method)) throw new Error(`The repository does not allow ${method} merges.`)
      const result = await provider.review.mergePullRequest(repo, number, method)
      if (!result.merged) return result
      const projectPath = projectScopeOf(ctx.session)
      const { completeTasksForMergedPullRequest } = await import('../../tasks/sync-engine')
      await completeTasksForMergedPullRequest(projectPath, number)
      const detailAfterMerge = await pullRequest.readFresh()
      // A merge is a lifecycle change like any other, so it is announced the
      // same way. Without this, only the surface that ran the merge learned
      // about it: the sidebar chip, the git rail and every other client kept
      // drawing the pull request open until something re-read it by hand.
      if (projectPath) deps.events.broadcast('pr.lifecycleChanged', { projectRoot: projectPath, detail: detailAfterMerge })
      return { ...result, detail: detailAfterMerge }
    })
  })

  server.register('prPrepareConflictResolution', async (args): Promise<PrConflictResolutionResult> => {
    const [ctx, number] = args
    try {
      const { repo, provider } = await reviewTargetFor(ctx)
      // Fresh: this is about to move local git to the pull request's revision.
      const detail = await prIndex.pullRequest(repo, provider, number).readFresh()
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

  server.register('prInvalidate', async (args) => {
    const [ctx] = args
    const { repo } = await reviewTargetFor(ctx)
    prIndex.invalidate(repo)
  })

  server.register('prGetDetail', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return prIndex.pullRequest(repo, provider, number).read()
  })

  server.register('prUpdate', async (args) => {
    const [ctx, number, patch] = args
    const title = patch.title?.trim()
    if (patch.title !== undefined && !title) throw new Error('A pull request title cannot be empty.')
    const updates: PullRequestUpdate = {}
    if (title !== undefined) updates.title = title
    if (patch.body !== undefined) updates.body = patch.body
    const updated = await writePullRequest(ctx, number, ({ repo, provider }) =>
      provider.review.updatePullRequest(repo, number, updates))
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
    return prIndex.pullRequest(repo, provider, number).overview()
  })

  server.register('prListThreads', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return prIndex.pullRequest(repo, provider, number).threads()
  })

  server.register('prListComments', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return prIndex.pullRequest(repo, provider, number).comments()
  })

  server.register('prListCommits', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return prIndex.pullRequest(repo, provider, number).commits()
  })

  server.register('prListReviewers', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return prIndex.pullRequest(repo, provider, number).reviewers()
  })

  server.register('prListReviewerCandidates', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    // Fresh: access taken away since the page loaded is what this guards.
    const detail = await prIndex.pullRequest(repo, provider, number).readFresh()
    if (!detail.viewerPermissions.requestReviewers) throw new Error('You do not have permission to request reviewers.')
    // Hand the detail on rather than the number: the candidate list only needs
    // the author, and re-reading by number made this one handler fetch the same
    // pull request twice.
    return provider.review.listReviewerCandidates(repo, detail)
  })

  server.register('prRequestReviewers', async (args) => {
    const [ctx, number, requestedLogins] = args
    const logins = [...new Set(requestedLogins.map((login) => login.trim()).filter(Boolean))]
    if (logins.length === 0) throw new Error('Select at least one reviewer.')
    return writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const detail = await pullRequest.readFresh()
      if (!detail.viewerPermissions.requestReviewers) throw new Error('You do not have permission to request reviewers.')
      return provider.review.requestReviewers(repo, number, logins)
    })
  })

  server.register('prRemoveRequestedReviewer', async (args) => {
    const [ctx, number, requestedLogin] = args
    const login = requestedLogin.trim()
    if (!login) throw new Error('A reviewer login is required.')
    return writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const detail = await pullRequest.readFresh()
      if (!detail.viewerPermissions.requestReviewers) throw new Error('You do not have permission to remove requested reviewers.')
      return provider.review.removeRequestedReviewer(repo, number, login)
    })
  })

  server.register('prUpdateLifecycle', async (args) => {
    const [ctx, number, action, expectedHeadSha] = args
    if (!['close', 'reopen', 'ready', 'draft'].includes(action)) throw new Error('Unsupported pull request action.')
    const detail = await writePullRequest(ctx, number, ({ repo, provider }) =>
      provider.review.updatePullRequestLifecycle(repo, number, action, expectedHeadSha))
    const projectRoot = projectScopeOf(ctx.session)
    if (projectRoot) deps.events.broadcast('pr.lifecycleChanged', { projectRoot, detail })
    return detail
  })

  server.register('prChangedFiles', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    return prIndex.pullRequest(repo, provider, number).changedFiles()
  })

  server.register('prSubmitReview', async (args) => {
    const [ctx, number, review] = args
    await writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const detail = await pullRequest.readFresh()
      if (detail.headSha !== review.commitId) {
        throw new Error('This pull request changed. Refresh the diff before submitting your review.')
      }
      const verdict = review.event === 'APPROVE'
        ? 'approve'
        : review.event === 'REQUEST_CHANGES'
          ? 'request-changes'
          : 'comment'
      if (!detail.viewerPermissions.reviewVerdicts.includes(verdict)) {
        throw new Error('You do not have permission to submit this review verdict.')
      }
      if (review.event === 'APPROVE') {
        const viewer = await provider.review.getViewer()
        if (detail.author.toLowerCase() === viewer.toLowerCase()) {
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
  })

  server.register('prAddIssueComment', async (args) => {
    const [ctx, number, body] = args
    await writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const detail = await pullRequest.readFresh()
      if (!detail.viewerPermissions.comment) throw new Error('You do not have permission to comment on this pull request.')
      await provider.review.addIssueComment(repo, number, body)
    })
  })

  server.register('prDeleteIssueComment', async (args) => {
    const [ctx, number, commentId] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const [comments, viewer] = await Promise.all([
      prIndex.pullRequest(repo, provider, number).comments(),
      provider.auth.status(),
    ])
    const comment = comments.find((item) => item.id === commentId)
    if (!comment || comment.kind !== 'comment') throw new Error('This pull request comment no longer exists.')
    if (!viewer.login || comment.author.toLowerCase() !== viewer.login.toLowerCase()) {
      throw new Error('You can only delete your own pull request comments.')
    }
    await writePullRequest(ctx, number, ({ repo: writeRepo, provider: writeProvider }) =>
      writeProvider.review.deleteIssueComment(writeRepo, commentId))
  })

  server.register('prInterdiff', async (args) => {
    const [ctx, pr] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const [threads, auth] = await Promise.all([
      prIndex.pullRequest(repo, provider, pr.number).threads(),
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
    const [ctx, number, threadId, body] = args
    return writePullRequest(ctx, number, ({ repo, provider }) =>
      provider.review.replyToThread(repo, threadId, body))
  })

  server.register('prResolveThread', async (args) => {
    const [ctx, number, threadId] = args
    await writePullRequest(ctx, number, ({ repo, provider }) =>
      provider.review.resolveThread(repo, threadId))
  })

  server.register('prUnresolveThread', async (args) => {
    const [ctx, number, threadId] = args
    await writePullRequest(ctx, number, ({ repo, provider }) =>
      provider.review.unresolveThread(repo, threadId))
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
