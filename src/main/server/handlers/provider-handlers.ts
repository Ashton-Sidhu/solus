import { createLogger } from '../../logger'
import { getProvider, providerForRepo } from '../../providers/registry'
import { ConnectCancelledError } from '../../providers/github/auth'
import { resolveRepoRef, resolveRepoRoot } from '../../git/git-helpers'
import { fetchAndCheckoutPr } from '../../git/worktree-manager'
import type { Provider, RepoRef } from '../../providers/types'
import type { PrFilter, DraftReview } from '../../../shared/providers'
import type { IpcContext, PrReviewContext } from '../../../shared/types'
import type { SolusServer } from '../server'

const log = createLogger('main', 'provider-handlers')

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
    // Anchor comments to the head we actually checked out and rendered.
    headSha: wt.headSha,
    baseSha: wt.baseSha,
    headRepo: detail.headRepo,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
  }
}

export function registerProviderHandlers(server: SolusServer): void {
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

  // ─── PR review mode ─────────────────────────────────────────────────────────

  server.register('prList', async (args) => {
    const [ctx, filter] = args as [IpcContext, PrFilter | undefined]
    const { repo, provider } = await reviewTargetFor(ctx)
    return provider.review.listPullRequests(repo, filter)
  })

  server.register('prOpenReview', async (args) => {
    const [ctx, number] = args as [IpcContext, number]
    return openPrReview(ctx, number)
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

  server.register('prSubmitReview', async (args) => {
    const [ctx, number, review] = args as [IpcContext, number, DraftReview]
    const { repo, provider } = await reviewTargetFor(ctx)
    await provider.review.createReview(repo, number, review)
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
}
