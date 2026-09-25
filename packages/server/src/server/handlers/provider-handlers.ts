import { createLogger } from '../../logger'
import { getProvider, providerForRepo } from '../../providers/registry'
import { ConnectCancelledError } from '../../providers/github/auth'
import { loadToken } from '../../providers/github/token-store'
import { computeGitState, resolveRepoRef, resolveRepoRoot } from '../../git/git-helpers'
import { repoRootOrScope } from '../../git/ctx-paths'
import type { CheckoutService } from '../../git/checkout-service'
import { computePrInterdiff } from '../../git/interdiff'
import { runAsync } from '../../git/exec'
import { writeReviewCheckpoint } from '../../review/checkpoints'
import { readPrGuidePatch, readPrGuideFileContents } from '../../review/pr-guide-diff'
import { PlaneDisabledError } from '../roles'
import { readPrGuideMetadata, requestPrGuides, scheduleGuideWarming } from '../../review/guide-warmer'
import { publishPrGuideStatus } from '../../review/pr-guide-events'
import type { Provider, RepoRef } from '../../providers/types'
import type { PrFilter, PrListPage, PrProjectListing, PrReviewTarget, DraftReview, PullRequest as PullRequestDetail, PullRequestUpdate } from '@solus/contracts/providers'
import { projectScopeOf, type GithubDelegatedCredential, type IpcContext, type PrCheckoutContext, type PrConflictResolutionResult, type PrMergeResult } from '@solus/contracts/types'
import { LOCAL_DEVICE_LABEL, type HandlerCtx, type SolusServer } from '../server'
import { organizationOf } from '../principal'
import { attachReviewAttention } from './review-attention'
import type { AgentDispatcher } from '../../agents/agent-runner'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import { Task } from '../../tasks/task'
import { completeTasksForMergedPullRequest } from '../../tasks/sync-engine'
import { buildPrReviewTarget } from '../../providers/pr-review-target'
import { emitChanged } from '../../tasks/task-store'
import { prIndex, repoKeyOf } from '../../prs/pr-index'
import { repoForScope } from '../../prs/code-host'
import type { PullRequest } from '../../prs/pull-request'

const log = createLogger('main', 'provider-handlers')
const checkoutRequests = new Map<string, Promise<PrCheckoutContext>>()
/** How many projects one every-project read asks its code hosts about at once.
 *  Each read mostly waits on the network; the bound keeps a large workspace
 *  from opening a burst of code-host requests. */
const PROJECT_LIST_CONCURRENCY = 6

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
  const repo = cwd ? await repoForScope(cwd) : null
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

export async function preparePrCheckout(ctx: IpcContext, target: PrReviewTarget, checkouts: CheckoutService): Promise<PrCheckoutContext> {
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
    const checkout = await checkouts.preparePullRequest(repoRoot, target.number, detail.baseRef, {
      headRef: detail.headRef,
      isFork: detail.headRepo.isFork,
      diffBaseSha: target.baseSha,
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

export { prepareReviewGuidePrContext } from '../../review/pr-guide-context'

/**
 * The viewer's own pull requests and the ones waiting on their review, read on
 * their own rather than found in the first page.
 *
 * The list's Authored and Review requested sections are drawn from the rows it
 * holds, and a first page holds only the most recently updated pull requests.
 * In a busy repository that page is other people's work, so an older pull
 * request of the viewer's own never reached its section. These reads find them
 * wherever they sit in the listing.
 *
 * A search, an author or a branch lookup is not the sectioned list, so it gets
 * nothing extra. A failed read costs only its rows: the page still answers.
 */
async function priorityPullRequests(
  repo: RepoRef,
  provider: Provider,
  viewer: string,
  filter: PrFilter | undefined,
): Promise<PullRequestDetail[]> {
  if (filter?.query?.trim() || filter?.author || filter?.head) return []
  const state = filter?.state ?? 'open'
  const reads = [prIndex.list(repo, provider, viewer, { state, query: `author:${viewer}` }, 1).then((page) => page.items)]
  // A review request only stands on an open pull request.
  if (state !== 'closed') reads.push(prIndex.listNeedsReview(repo, provider, viewer))
  const settled = await Promise.allSettled(reads)
  return settled.flatMap((read) => {
    if (read.status === 'fulfilled') return read.value
    log.warn('pr_priority_read_failed', {
      host: repo.host,
      owner: repo.owner,
      repo: repo.repo,
      error: read.reason instanceof Error ? read.reason.message : String(read.reason),
    })
    return []
  })
}

/** The page's rows, then each priority row the page does not already hold. */
function withPriorityRows(items: PullRequestDetail[], priority: PullRequestDetail[]): PullRequestDetail[] {
  const held = new Set(items.map((item) => item.number))
  const rows = [...items]
  for (const pullRequest of priority) {
    if (held.has(pullRequest.number)) continue
    held.add(pullRequest.number)
    rows.push(pullRequest)
  }
  return rows
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
  checkouts: CheckoutService
  isWorktreeInUse: (path: string) => boolean
  /** Whether a Solus session is still mid-turn; a merge does not finish a task under one. */
  isSessionBusy: (sessionId: string) => boolean
  dispatcher: AgentDispatcher
  events: HostEventPublisher
}

export function registerProviderHandlers(server: SolusServer, deps: ProviderHandlerDeps): void {
  const { checkouts } = deps
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
    await provider?.auth.disconnect()
  })

  // The desktop renderer is itself a WS-paired device, so without this gate any
  // paired phone or laptop could pull the user's GitHub token off their machine.
  server.register('githubExportCredential', async (_args, ctx): Promise<GithubDelegatedCredential> => {
    if (ctx.deviceLabel !== LOCAL_DEVICE_LABEL) {
      throw new Error('Only this device can export its GitHub credential.')
    }

    const token = await loadToken()
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
    return provider.review.getViewerProfile()
  })

  // A board's project picker on a host with no checkouts — the organization's
  // workspace service — lists repositories instead; `prList` reads a
  // `host/owner/repo` scope without one (docs/plans/cloud-console-native-pages.md §9).
  server.register('providerRepositories', async (args) => {
    const [providerId] = args
    const provider = getProvider(providerId)
    if (!provider) throw new Error(`No ${providerId} provider is available on this host.`)
    return provider.review.listRepositories()
  })

  // ─── PR review mode ─────────────────────────────────────────────────────────

  async function listPullRequests(
    ctx: IpcContext,
    filter: PrFilter | undefined,
    page: number,
    handlerCtx: HandlerCtx,
    options: { withPriority?: boolean } = {},
  ): Promise<PrListPage> {
    const { repo, provider } = await reviewTargetFor(ctx)
    const viewer = await provider.review.getViewer(repo)
    const [page1, priority] = await Promise.all([
      prIndex.list(repo, provider, viewer, filter, page),
      options.withPriority ? priorityPullRequests(repo, provider, viewer, filter) : [],
    ])
    // Copied rather than assigned into: `page1` is the index's own object, and
    // decorating it in place would write this viewer's attention flags onto the
    // answer every other reader shares.
    const result: PrListPage = { ...page1, items: attachReviewAttention(withPriorityRows(page1.items, priority), viewer) }
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
      const task = await Task.forSession(organizationOf(handlerCtx.principal), sessionId)
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
    // Guide warming is advisory: even resolving the local repo root happens
    // after the PR response is ready, so it cannot delay it.
    if (cwd) void resolveRepoRoot(cwd).then((repoRoot) => {
      if (!repoRoot) return
      const isOpenPage = (!filter?.state || filter.state === 'open') && !filter?.author
      if (!isOpenPage || page !== 1 || result.hasMore) return
      scheduleGuideWarming({
        dispatcher: deps.dispatcher,
        checkouts,
        ctx,
        repoRoot,
        repo,
        provider,
        openPullRequests: result.items,
        isWorktreeInUse: deps.isWorktreeInUse,
        onStatus: (event) => publishPrGuideStatus(deps.events, event),
      })
    }).catch((err) => log.warn('guide_warming_trigger_failed', { error: err instanceof Error ? err.message : String(err) }))
    return result
  }

  server.register('prList', async (args, handlerCtx) => {
    const [ctx, filter, page = 1] = args
    return listPullRequests(ctx, filter, page, handlerCtx)
  })

  // The every-project list asks once per host. The host reads its projects
  // side by side and answers with all of them, so the client lays the rows out
  // once instead of reordering them as each project arrives.
  server.register('prListProjects', async (args, handlerCtx) => {
    const [ctx, projectRoots, filter] = args
    // Filled by index, so the answer keeps the order the projects were named in.
    const listings: PrProjectListing[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < projectRoots.length) {
        const index = next++
        const projectRoot = projectRoots[index]
        // The project's own scope, with no checkout of its own: a list read is
        // an observation of the repository, not of any one session's branch.
        const projectCtx: IpcContext = {
          ...ctx,
          session: { ...ctx.session, projectPath: projectRoot, workingDirectory: projectRoot, gitContext: null },
        }
        try {
          listings[index] = {
            projectRoot,
            page: await listPullRequests(projectCtx, filter, 1, handlerCtx, { withPriority: true }),
          }
        } catch (error) {
          listings[index] = { projectRoot, error: error instanceof Error ? error.message : String(error) }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PROJECT_LIST_CONCURRENCY, projectRoots.length) }, worker))
    return listings
  })

  server.register('prNeedsReview', async (args) => {
    const [ctx] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const viewer = await provider.review.getViewer(repo)
    return attachReviewAttention(
      await prIndex.listNeedsReview(repo, provider, viewer),
      viewer,
    ).filter((pr) => pr.needsMyReview)
  })

  server.register('prGuideMetadata', async (args) => {
    const [ctx, request] = args
    const { repo } = await reviewTargetFor(ctx)
    return readPrGuideMetadata(ctx, repo, request)
  })

  server.register('prOpenReview', async (args) => {
    const [ctx, number] = args
    return openPrReview(ctx, number)
  })

  server.register('prGetDiff', async (args) => {
    const [ctx, request] = args
    // A guide's diff is read out of a guide checkout with Git: execution work,
    // even though the pull request itself is read from its code host.
    if (request.repo) {
      if (!server.servesExecution()) throw new PlaneDisabledError('prGetDiff', 'execution')
      return readPrGuidePatch(request.repo, request)
    }
    const { repo, provider } = await reviewTargetFor(ctx)
    // Remembered, not fresh: the guard inside compares against the `headSha`
    // the client got from `prOpenReview`, which forced this same field moments
    // ago. A push since then surfaces on the next open, not on every diff page.
    const detail = await prIndex.pullRequest(repo, provider, request.number).read()
    return provider.review.getPullRequestDiff(repo, detail, request)
  })

  server.register('prGetDiffFileContents', async (args) => {
    const [ctx, request] = args
    if (request.repo) {
      if (!server.servesExecution()) throw new PlaneDisabledError('prGetDiffFileContents', 'execution')
      return readPrGuideFileContents(request.repo, request)
    }
    const { repo, provider } = await reviewTargetFor(ctx)
    const detail = await prIndex.pullRequest(repo, provider, request.number).read()
    return provider.review.getPullRequestDiffFileContents(repo, detail, request)
  })

  server.register('prPrepareCheckout', async (args) => {
    const [ctx, target] = args
    return preparePrCheckout(ctx, target, checkouts)
  })

  server.register('prMerge', async (args, handlerCtx): Promise<PrMergeResult> => {
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
      const detailAfterMerge = await pullRequest.readFresh()
      await completeTasksForMergedPullRequest(organizationOf(handlerCtx.principal), repoKeyOf(repo).toLowerCase(), number, {
        mergedAt: detailAfterMerge.updatedAt,
        isSessionBusy: deps.isSessionBusy,
      })
      emitChanged()
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
      const worktree = await checkouts.preparePullRequest(repoRoot, number, detail.baseRef, {
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
    const detail = await prIndex.pullRequest(repo, provider, number).read()
    emitChanged()
    return detail
  })

  server.register('prUpdate', async (args, handlerCtx) => {
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
      await Task.linkArtifactForSession(organizationOf(handlerCtx.principal), sessionId, {
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
    const [ctx, number, requestedReviewerId, kind = 'user'] = args
    const reviewerId = requestedReviewerId.trim()
    if (!reviewerId) throw new Error('A reviewer is required.')
    if (kind !== 'user' && kind !== 'team') throw new Error('Invalid reviewer kind.')
    return writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const detail = await pullRequest.readFresh()
      if (!detail.viewerPermissions.requestReviewers) throw new Error('You do not have permission to remove requested reviewers.')
      return provider.review.removeRequestedReviewer(repo, number, reviewerId, kind)
    })
  })

  server.register('prListLabelCandidates', async (args) => {
    const [ctx, number] = args
    const { repo, provider } = await reviewTargetFor(ctx)
    const detail = await prIndex.pullRequest(repo, provider, number).readFresh()
    if (!detail.viewerPermissions.manageLabels) throw new Error('You do not have permission to manage labels.')
    return provider.review.listLabelCandidates(repo)
  })

  server.register('prSetLabels', async (args) => {
    const [ctx, number, requestedNames] = args
    const names = [...new Set(requestedNames.map((name) => name.trim()).filter(Boolean))]
    return writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const detail = await pullRequest.readFresh()
      if (!detail.viewerPermissions.manageLabels) throw new Error('You do not have permission to manage labels.')
      await provider.review.setLabels(repo, number, names)
      // Announced like a lifecycle change, with the whole pull request: the
      // list row and every other client draw labels too.
      const detailAfterWrite = await pullRequest.readFresh()
      emitChanged()
      const projectRoot = projectScopeOf(ctx.session)
      if (projectRoot) deps.events.broadcast('pr.lifecycleChanged', { projectRoot, detail: detailAfterWrite })
      return detailAfterWrite
    })
  })

  server.register('prUpdateLifecycle', async (args) => {
    const [ctx, number, action, expectedHeadSha] = args
    if (!['close', 'reopen', 'ready', 'draft'].includes(action)) throw new Error('Unsupported pull request action.')
    const detail = await writePullRequest(ctx, number, ({ repo, provider }) =>
      provider.review.updatePullRequestLifecycle(repo, number, action, expectedHeadSha))
    emitChanged()
    const projectRoot = projectScopeOf(ctx.session)
    if (projectRoot) deps.events.broadcast('pr.lifecycleChanged', { projectRoot, detail })
    return detail
  })

  // Auto-merge is announced the same way as any lifecycle change: the armed
  // badge belongs on every surface drawing this pull request, not only on the
  // one that armed it.
  function announceLifecycle(ctx: IpcContext, detail: PullRequestDetail): PullRequestDetail {
    emitChanged()
    const projectRoot = projectScopeOf(ctx.session)
    if (projectRoot) deps.events.broadcast('pr.lifecycleChanged', { projectRoot, detail })
    return detail
  }

  server.register('prEnableAutoMerge', async (args) => {
    const [ctx, number, method, expectedHeadSha] = args
    const detail = await writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const current = await pullRequest.readFresh()
      if (current.headSha !== expectedHeadSha) {
        throw new Error('This pull request changed. Refresh it before turning on auto-merge.')
      }
      if (current.state !== 'open' || current.draft) throw new Error('Only an open pull request that is ready for review can merge on its own.')
      if (!current.viewerPermissions.actions.includes('enable-auto-merge')) {
        throw new Error('You do not have permission to turn on auto-merge for this pull request.')
      }
      if (!current.capabilities.mergeMethods.includes(method)) throw new Error(`The repository does not allow ${method} merges.`)
      return provider.review.enablePullRequestAutoMerge(repo, number, method, expectedHeadSha)
    })
    return announceLifecycle(ctx, detail)
  })

  server.register('prDisableAutoMerge', async (args) => {
    const [ctx, number] = args
    const detail = await writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const current = await pullRequest.readFresh()
      if (!current.viewerPermissions.actions.includes('disable-auto-merge')) {
        throw new Error('You do not have permission to turn off auto-merge for this pull request.')
      }
      return provider.review.disablePullRequestAutoMerge(repo, number)
    })
    return announceLifecycle(ctx, detail)
  })

  server.register('prRevert', async (args) => {
    const [ctx, number] = args
    const opened = await writePullRequest(ctx, number, async ({ repo, provider, pullRequest }) => {
      const current = await pullRequest.readFresh()
      if (current.state !== 'merged') throw new Error('Only a merged pull request can be reverted.')
      if (!current.viewerPermissions.actions.includes('revert')) {
        throw new Error('You do not have permission to revert this pull request.')
      }
      return provider.review.revertPullRequest(repo, number)
    })
    // The revert is a new pull request in this repository's list.
    emitChanged()
    return opened
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
        const viewer = await provider.review.getViewer(repo)
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
      checkouts,
      ctx,
      repoRoot,
      repo,
      provider,
      isWorktreeInUse: deps.isWorktreeInUse,
      onStatus: (event) => publishPrGuideStatus(deps.events, event),
    }, numbers)
  })
}
