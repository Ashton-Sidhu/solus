import type { IpcContext, PrReviewContext } from '@solus/contracts/types'
import { parseGitHubPullRequestUrl, type PrReviewTarget, type PullRequest } from '@solus/contracts/providers'
import type { Via } from '@solus/contracts/analytics-events'
import { buildConflictResolutionPrompt, buildConflictResolverCard, buildConflictResolverErrorCard } from '../../lib/pr-conflict-resolution'
import type { PrReviewTab } from '../prs/pr-view.svelte'
import { prSurfaceError } from '../../components/prs/lib/pr-surface-error'
import { toasts } from '../../lib/toasts'
import { type NavTarget } from './routing/location'
import { type RouteRef } from './routing/route-registry'
import { SessionDraft } from './session-draft.svelte'
import { nextMsgId } from './session.utils'
import { projectScopeOf, worktreeProjectRoot } from '@solus/contracts/types'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import { prReviewGitCheckout } from './pr-review-checkout'
import type { PullRequestOpenTarget, WorkspaceContext } from './workspace.context.svelte'

/** The workspace members this controller reads or calls, and no others. */
type PrReviewActionsWorkspace = Pick<WorkspaceContext,
  | 'activeSession'
  | 'apiForContext'
  | 'createTab'
  | 'ctx'
  | 'ctxForDirectory'
  | 'dispatch'
  | 'drafts'
  | 'fallbackServerId'
  | 'openPrs'
  | 'pullRequests'
  | 'router'
  | 'serverIdForContext'
  | 'sessionFor'
  | 'sessions'
  | 'showPage'
>

/**
 * Reviewing a pull request from the workspace: opening its review pane,
 * preparing a checkout, stepping between pull requests, its diff, and the
 * session that resolves its conflicts.
 */
export class PrReviewActions {
  constructor(private readonly workspace: PrReviewActionsWorkspace) {}

  async openReviewMode(
    items: Array<Pick<PullRequest, 'number'>>,
    ctx: IpcContext = this.workspace.ctx,
    serverId = this.workspace.serverIdForContext(ctx),
  ): Promise<void> {
    this.workspace.pullRequests.view.beginReviewMode(items.map((item) => item.number), ctx, serverId)
    this.workspace.showPage({ name: 'reviewMode', params: {} }, 'click', 'review')
  }

  /**
   * Resolve a PR's merge conflicts in a fresh agent session. Opens the session
   * tab immediately — the click lands in a new window right away — then prepares
   * the conflict worktree behind a live status card and, once it's ready, sends
   * the resolution prompt. Agents bind their cwd at prompt time (see promptTab),
   * so we can re-point this tab to the worktree before the first message.
   */
  async startConflictResolverSession(
    pr: { number: number; title: string },
    opts: { ctx?: IpcContext } = {},
  ): Promise<void> {
    const actionCtx = opts.ctx ?? this.workspace.ctx
    const placeholderDir = actionCtx.session.projectPath
      ?? actionCtx.session.workingDirectory
      ?? this.workspace.activeSession?.run.gitContext?.repoRoot
      ?? (this.workspace.activeSession?.run.workingDirectory && this.workspace.activeSession.run.workingDirectory !== '~'
        ? worktreeProjectRoot(this.workspace.activeSession.run.workingDirectory)
        : undefined)
    const tabId = await this.workspace.createTab(placeholderDir)
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    if (session) session.title = `Resolve #${pr.number}`
    session.statusCard = buildConflictResolverCard(pr.number, 'worktree')

    const promptMsgId = nextMsgId()
    session.messages.push({
      id: promptMsgId,
      role: 'user',
      content: buildConflictResolutionPrompt({ number: pr.number, title: pr.title }),
      timestamp: Date.now(),
    })
    session.status = 'connecting'
    session.progress = null
    const abandonPrompt = () => {
      const idx = session.messages.findIndex((m) => m.id === promptMsgId)
      if (idx >= 0) session.messages.splice(idx, 1)
      session.status = 'idle'
    }

    session.statusCard = buildConflictResolverCard(pr.number, 'merge')
    const prepared = await this.workspace.apiForContext(actionCtx).prPrepareConflictResolution(actionCtx, pr.number).catch((err) => ({
      success: false as const,
      error: err instanceof Error ? err.message : String(err),
    }))
    if (!prepared.success || !prepared.review) {
      abandonPrompt()
      session.statusCard = buildConflictResolverErrorCard(
        pr.number,
        prepared.error ?? 'The conflict-resolution worktree could not be prepared.',
      )
      return
    }

    const review = prepared.review
    session.run.workingDirectory = worktreeProjectRoot(review.worktreePath)
    session.run.gitContext = prReviewGitCheckout(review)
    session.run.worktree = null
    session.run.permissionMode = 'auto'
    session.prReview = review
    session.statusCard = buildConflictResolverCard(pr.number, 'session')
    const prompt = buildConflictResolutionPrompt({
      number: review.number,
      title: review.title,
      baseRef: review.baseRef,
      headRef: prepared.headRef,
      conflictFiles: prepared.conflictFiles,
    })
    const promptMsg = session.messages.find((m) => m.id === promptMsgId)
    if (promptMsg) promptMsg.content = prompt
    this.workspace.dispatch.promptTab(tabId, { prompt, displayPrompt: prompt })
    requestInputFocus()
  }

  /** The route for one PR, scoped to the project it was opened from. */
  private prReviewRef(
    number: number,
    title: string | undefined,
    ctx: IpcContext,
    serverId: string,
    expectedRepo?: RouteRef<'prReview'>['params']['expectedRepo'],
  ): RouteRef<'prReview'> {
    return {
      name: 'prReview',
      params: {
        number,
        title,
        cwd: projectScopeOf(ctx.session) || undefined,
        serverId,
        expectedRepo,
      },
    }
  }

  /**
   * Open a PR review as the page. The route is entered before the (slow)
   * host detail request so the click gets a real surface rather than a blank pane;
   * the descriptor's `resolve` fills that same mounted surface in place when the
   * host target lands. Re-entering a PR already in the router's payload cache
   * skips the request entirely. Checkout is a later, action-specific operation.
   *
   * List selection replaces the list in the leading pane. A transcript link can
   * explicitly target the companion pane instead, so reading the conversation
   * remains uninterrupted. The review's own chrome owns later pane changes.
   */
  private async openPrReviewRoute(
    number: number,
    title: string | undefined,
    ctx: IpcContext,
    opts: {
      tab?: PrReviewTab
      via?: Via
      serverId?: string
      target?: NavTarget
      expectedRepo?: RouteRef<'prReview'>['params']['expectedRepo']
      externalFallbackUrl?: string
      preflight?: boolean
    } = {},
  ): Promise<PrReviewTarget | null> {
    // The row's verb picks the tab: an inbox row that says Review lands on the
    // diff, everything else on Activity.
    this.workspace.pullRequests.view.tab = opts.tab ?? 'activity'
    const api = opts.serverId ? serverConnections.apiFor(opts.serverId) : this.workspace.apiForContext(ctx)
    const serverId = opts.serverId ?? this.workspace.serverIdForContext(ctx)
    const ref = this.prReviewRef(number, title, ctx, serverId, opts.expectedRepo)
    const resolve = () => this.workspace.router.resolve(ref, {
      api,
      ipc: (cwd) => (cwd ? this.workspace.ctxForDirectory(cwd) : ctx),
    })

    // A web link can name a PR outside the repositories this client can read.
    // URL-backed navigation probes the exact review target before changing panes.
    // The host request costs seconds, so number-only navigation enters the route
    // immediately and lets the pane fill in place. The router keeps a
    // successful result, so opening the pane does not repeat the request; a
    // failure stays invisible and opens the original URL instead.
    let preflightedPr: PrReviewTarget | null = null
    if (opts.preflight && opts.externalFallbackUrl) {
      const fallbackUrl = opts.externalFallbackUrl
      try {
        preflightedPr = await resolve()
      } catch {
        void localApi.openExternal(fallbackUrl)
        return null
      }
    }
    const pane = this.workspace.router.navigate(ref, {
      target: opts.target ?? this.workspace.router.leadingPane.id,
      via: opts.via,
    })
    track('surface_viewed', { surface: 'pr_review', via: opts.via })
    this.workspace.pullRequests.projects.get(api, serverId, ctx).get(number).prefetch()
    try {
      const pr = preflightedPr ?? await resolve()
      return pr
    } catch (err) {
      if (prSurfaceError(err).kind === 'github-auth') return null
      // Tear down the pending surface so a failed open doesn't strand the user.
      this.workspace.router.dropResolved(ref)
      if (this.workspace.router.params('prReview')?.number === number) {
        if (pane.id === this.workspace.router.leadingPane.id) this.exitPrReview()
        else this.workspace.router.closePane(pane.id)
      }
      // The provider can refuse a PR this client can otherwise see — an
      // organization that never granted the OAuth app, for one. The host still
      // has it, so send the user there instead of reporting a dead end.
      if (opts.externalFallbackUrl) {
        void localApi.openExternal(opts.externalFallbackUrl)
        return null
      }
      toasts.error(`Couldn't open PR #${number}`, {
        description: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  /** Open a PR from any surface. Remote identity is part of the target, so the
   * shared command always tries Solus first and uses the external URL on
   * failure whenever the caller or cached PR record can provide one. */
  async openPullRequest(
    target: PullRequestOpenTarget,
    opts: {
      ctx?: IpcContext
      via?: Via
      serverId?: string
      target?: NavTarget
      tab?: PrReviewTab
      preflight?: boolean
    } = {},
  ): Promise<void> {
    const cachedPr = this.workspace.pullRequests.projects.at(this.workspace.serverIdForContext(this.workspace.ctx), projectScopeOf(this.workspace.ctx.session))?.prFor(target.number) ?? null
    const expectedRepo = target.expectedRepo
      ?? target.baseRepo
      ?? (target.url ? parseGitHubPullRequestUrl(target.url)?.baseRepo : undefined)
      ?? cachedPr?.baseRepo
    // The link the caller arrived with, or the pull request's own page. Nothing
    // is derived from a repository and a number: an external fallback Solus
    // guessed is worse than none, because the caller opens it on failure.
    const externalFallbackUrl = target.url?.trim() || cachedPr?.url
    const title = target.title ?? cachedPr?.title
    const number = target.number
    const ctx = opts.ctx ?? this.workspace.ctx
    await this.openPrReviewRoute(number, title, ctx, {
      tab: opts.tab,
      via: opts.via,
      serverId: opts.serverId,
      target: opts.target,
      expectedRepo,
      externalFallbackUrl,
      preflight: opts.preflight,
    })
  }

  /** Prepare one review without changing pane placement. Review Mode uses this
   * seam to warm the next item in its queue. */
  async preparePrReview(number: number, opts: { ctx?: IpcContext; serverId?: string } = {}): Promise<{ pr: PrReviewTarget }> {
    const ctx = opts.ctx ?? this.workspace.ctx
    const api = opts.serverId ? serverConnections.apiFor(opts.serverId) : this.workspace.apiForContext(ctx)
    const pr = await api.prOpenReview(ctx, number)
    return { pr }
  }

  /** Step to the PR before or after the open one, in the list's own order —
   *  what J / K and the chrome band's stepper walk. */
  stepPrReview(delta: number, ctx: IpcContext = this.workspace.ctx): void {
    const open = this.workspace.router.params('prReview')?.number
    const order = this.workspace.pullRequests.view.listOrder
    if (open === undefined || order.length === 0) return
    const index = order.indexOf(open)
    if (index === -1) return
    const next = order[(index + delta + order.length) % order.length]
    if (next === open) return
    void this.openPullRequest(
      this.workspace.pullRequests.projects.at(this.workspace.serverIdForContext(ctx), projectScopeOf(ctx.session))?.prFor(next) ?? { number: next },
      {
        ctx,
        tab: this.workspace.pullRequests.view.tab,
        serverId: this.workspace.router.params('prReview')?.serverId,
      },
    )
  }

  /** Route prepared PR work to a real session composer. No tab or session exists
   *  until Send; the checkout, PR context, prompt, and task choice stay on the
   *  draft and cross that boundary together. */
  openPrReviewDraft(
    pr: PrReviewContext,
    opts: {
      prompt?: string
      serverId?: string
      target?: NavTarget
      task: 'new' | 'none'
    },
  ): SessionDraft {
    const serverId = opts.serverId ?? this.workspace.router.params('prReview')?.serverId ?? this.workspace.fallbackServerId
    const workingDirectory = worktreeProjectRoot(pr.worktreePath)
    const gitContext = prReviewGitCheckout(pr)
    const draft = this.workspace.drafts.openSessionDraft(
      {
        target: opts.target,
        freshTask: opts.task === 'new',
        withoutTask: opts.task === 'none',
        gitContext,
        serverId,
        via: 'click',
      },
      workingDirectory,
    )
    // `freshTask` starts from clean defaults before the explicit checkout is
    // applied, while taskless drafts can inherit a source run. Set both here so
    // the two PR composer kinds finish with the same prepared destination.
    draft.run.workingDirectory = workingDirectory
    draft.run.gitContext = gitContext
    draft.run.serverId = serverId
    draft.run.taskServerId = serverId
    draft.run.projectGroupPath = null
    draft.run.worktree = null
    draft.run.permissionMode = 'auto'
    draft.prReview = pr
    if (opts.prompt) draft.prompt.text = opts.prompt
    return draft
  }

  /** Pop the open review's diff out beside it, so the activity feed and the
   *  change read together. Closing it returns the review to Activity. */
  openPrDiff(number: number, ctx: IpcContext = this.workspace.ctx): void {
    const pane = this.workspace.router.navigate(
      {
        name: 'prDiff',
        params: {
          number,
          cwd: projectScopeOf(ctx.session) || undefined,
          serverId: this.workspace.sessions.byId[ctx.session.sessionId]?.run.serverId,
        },
      },
      { target: 'aside' },
    )
    pane.defaultSize = 50
  }

  closePrDiff(): void {
    this.workspace.router.close('prDiff')
  }

  /** Leave the review for the list it was opened from. Any session already
   *  started from its composer remains an ordinary workspace tab. */
  exitPrReview(): void {
    this.workspace.router.close('prDiff')
    this.workspace.openPrs(this.workspace.router.params('prReview')?.cwd ?? null)
  }
}
