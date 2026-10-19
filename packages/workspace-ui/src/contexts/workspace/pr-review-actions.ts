import type { IpcContext, PrReviewContext, RunConfig } from '@solus/contracts/types'
import { parseGitHubPullRequestUrl, type PrReviewTarget, type PullRequest } from '@solus/contracts/providers'
import type { Via } from '@solus/contracts/analytics-events'
import { buildConflictResolutionPrompt, buildConflictResolverCard, buildConflictResolverErrorCard } from '../../lib/pr-conflict-resolution'
import { buildPrCheckoutCard } from '../../lib/pr-checkout-card'
import type { PrReviewTab } from '../prs/pr-view.svelte'
import { prSurfaceError } from '../../components/prs/lib/pr-surface-error'
import { toasts } from '../../lib/toasts'
import { type OpenTarget } from './routing/location'
import { type RouteRef } from './routing/route-registry'
import { SessionDraft } from './session-draft.svelte'
import { nextMsgId } from './session.utils'
import { projectScopeOf, worktreeProjectRoot } from '@solus/contracts/types'
import { repositoryKeyOf } from '@solus/contracts/repository-key'
import { track } from '../../lib/analytics'
import { requestInputFocus } from '../../lib/inputFocus'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import { prReviewGitCheckout } from './pr-review-checkout'
import type { PullRequestOpenTarget, WorkspaceContext } from './workspace.context.svelte'
import { checkoutGit, checkoutPlace, folderLocation, runHost } from './run-location'

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
    const activeFolder = checkoutPlace(this.workspace.activeSession?.run)?.path
    const placeholderDir = actionCtx.session.projectPath
      ?? actionCtx.session.workingDirectory
      ?? checkoutGit(this.workspace.activeSession?.run)?.repoRoot
      ?? (activeFolder && activeFolder !== '~' ? worktreeProjectRoot(activeFolder) : undefined)
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
    session.run.location = folderLocation(
      { serverId: runHost(session.run), path: worktreeProjectRoot(review.worktreePath) },
      { git: prReviewGitCheckout(review) },
    )
    session.run.permissionMode = 'full-access'
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
   * Where a pull request opens, decided only from what this client already
   * holds: the route, the host it reads from, and the external page to fall
   * back to. Null when the target names a repository this project does not
   * read; the caller sends that link to the browser without asking the host.
   */
  private prReviewPlan(
    target: PullRequestOpenTarget,
    opts: { ctx?: IpcContext; serverId?: string },
  ) {
    const ctx = opts.ctx ?? this.workspace.ctx
    const serverId = opts.serverId ?? this.workspace.serverIdForContext(ctx)
    const api = opts.serverId ? serverConnections.apiFor(opts.serverId) : this.workspace.apiForContext(ctx)
    const cachedPr = this.workspace.pullRequests.projects.at(this.workspace.serverIdForContext(this.workspace.ctx), projectScopeOf(this.workspace.ctx.session))?.prFor(target.number) ?? null
    const expectedRepo = target.expectedRepo
      ?? target.baseRepo
      ?? (target.url ? parseGitHubPullRequestUrl(target.url)?.baseRepo : undefined)
      ?? cachedPr?.baseRepo
    // The link the caller arrived with, or the pull request's own page. Nothing
    // is derived from a repository and a number: an external fallback Solus
    // guessed is worse than none, because the caller opens it on failure.
    const externalFallbackUrl = target.url?.trim() || cachedPr?.url
    // A project learns its repository from the first pull request it sees.
    // Until then the host decides, and a refusal still falls back below.
    const projectRepository = this.workspace.pullRequests.projects.at(serverId, projectScopeOf(ctx.session))?.repositoryKey
    const isOtherRepository = !!expectedRepo && !!projectRepository && repositoryKeyOf(expectedRepo) !== projectRepository
    return {
      ctx,
      serverId,
      api,
      externalFallbackUrl,
      isOtherRepository,
      ref: this.prReviewRef(target.number, target.title ?? cachedPr?.title, ctx, serverId, expectedRepo),
    }
  }

  /** Open a PR from any surface. The surface opens at once, before any host
   * request, and fills in place when the review target lands; the router
   * keeps that target, so reopening a PR skips the request. A PR the host
   * refuses closes again and opens its external page whenever the caller or
   * the cached PR record can provide one. Checkout is a later,
   * action-specific operation. */
  async openPullRequest(
    target: PullRequestOpenTarget,
    opts: {
      ctx?: IpcContext
      via?: Via
      serverId?: string
      tab?: PrReviewTab
    } = {},
  ): Promise<void> {
    const plan = this.prReviewPlan(target, opts)
    const { ctx, serverId, api, ref, externalFallbackUrl } = plan
    if (plan.isOtherRepository && externalFallbackUrl) {
      void localApi.openExternal(externalFallbackUrl)
      return
    }
    const number = target.number
    // The row's verb picks the tab: an inbox row that says Review lands on the
    // diff, everything else on Activity.
    this.workspace.pullRequests.view.tab = opts.tab ?? 'activity'
    this.workspace.router.navigate(ref, { via: opts.via })
    track('surface_viewed', { surface: 'pr_review', via: opts.via })
    this.workspace.pullRequests.projects.get(api, serverId, ctx).get(number).prefetch()
    try {
      await this.workspace.router.resolve(ref, {
        api,
        ipc: (cwd) => (cwd ? this.workspace.ctxForDirectory(cwd) : ctx),
      })
    } catch (err) {
      if (prSurfaceError(err).kind === 'github-auth') return
      // Tear down the pending surface so a failed open doesn't strand the user.
      this.workspace.router.dropResolved(ref)
      this.workspace.router.closeSurfacesWhere((surface) => surface.name === 'prReview' && surface.params.number === number)
      // A web link can name a PR this host cannot read — an organization that
      // never granted the OAuth app, for one. The code host still has it, so
      // send the user there instead of reporting a dead end.
      if (externalFallbackUrl) {
        void localApi.openExternal(externalFallbackUrl)
        return
      }
      toasts.error(`Couldn't open PR #${number}`, {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Read a pull request a pointer is resting on, so the click that follows
   * finds its review target and Activity already loaded. Both reads land in
   * the same caches the open uses. Failures stay silent: the open reports
   * its own. */
  warmPullRequest(target: PullRequestOpenTarget, opts: { ctx?: IpcContext; serverId?: string } = {}): void {
    const { ctx, serverId, api, ref, isOtherRepository } = this.prReviewPlan(target, opts)
    if (isOtherRepository) return
    void this.workspace.router.resolve(ref, {
      api,
      ipc: (cwd) => (cwd ? this.workspace.ctxForDirectory(cwd) : ctx),
    }).catch(() => {})
    this.workspace.pullRequests.projects.get(api, serverId, ctx).get(target.number).prefetch()
  }

  /** Prepare one review without changing pane placement. Review Mode uses this
   * seam to warm the next item in its queue. */
  async preparePrReview(number: number, opts: { ctx?: IpcContext; serverId?: string } = {}): Promise<{ pr: PrReviewTarget }> {
    const ctx = opts.ctx ?? this.workspace.ctx
    const api = opts.serverId ? serverConnections.apiFor(opts.serverId) : this.workspace.apiForContext(ctx)
    const pr = await api.prOpenReview(ctx, number)
    return { pr }
  }

  /** Route prepared PR work to a real session composer. No tab or session exists
   *  until Send; the checkout, PR context, prompt, and task choice stay on the
   *  draft and cross that boundary together. */
  openPrReviewDraft(
    pr: PrReviewContext,
    opts: {
      prompt?: string
      serverId?: string
      target?: OpenTarget
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
    this.aimAtPrCheckout(draft, pr, serverId)
    if (opts.prompt) draft.prompt.text = opts.prompt
    return draft
  }

  /** Point a draft, or a session that has not sent yet, at the pull request's
   *  prepared checkout. `freshTask` starts from clean defaults before the
   *  checkout is applied, taskless drafts can inherit a source run, and a
   *  session started from the PR page exists before its checkout does. Every
   *  PR session starts from this same destination. */
  aimAtPrCheckout(target: { run: RunConfig; prReview: PrReviewContext | null }, pr: PrReviewContext, serverId: string): void {
    target.run.location = folderLocation(
      { serverId, path: worktreeProjectRoot(pr.worktreePath) },
      { git: prReviewGitCheckout(pr) },
    )
    target.run.permissionMode = 'full-access'
    target.prReview = pr
  }

  /**
   * Send a session's first prompt once the pull request's worktree exists. The
   * conversation is already on screen, so the checkout runs behind a setup card
   * in it, and the prompt goes the moment the session points at the checkout.
   * Stop withdraws the send; a failure stays on the card. Either way the words
   * go back into the session's composer, so nothing typed is lost.
   */
  async sendAfterPrCheckout(
    tabId: string,
    prompt: string,
    pr: { number: number; serverId: string; prepare: () => Promise<PrReviewContext> },
  ): Promise<void> {
    const session = this.workspace.sessionFor(tabId)
    if (!session) return
    session.status = 'connecting'
    session.currentTurnStartedAt = Date.now()
    session.statusCard = buildPrCheckoutCard(pr.number, 'checkout')
    const returnPrompt = () => {
      if (!session.prompt.text) session.prompt.text = prompt
    }
    try {
      const review = await pr.prepare()
      if (this.workspace.sessionFor(tabId) !== session) return
      if (session.status !== 'connecting') {
        session.statusCard = null
        returnPrompt()
        return
      }
      this.aimAtPrCheckout(session, review, pr.serverId)
      session.statusCard = buildPrCheckoutCard(pr.number, 'ready')
      // `sendMessage` refuses a connecting session; the wait is over.
      session.status = 'idle'
      if (!this.workspace.dispatch.sendMessage(prompt, undefined, tabId)) returnPrompt()
    } catch (error) {
      if (this.workspace.sessionFor(tabId) !== session) return
      session.status = 'idle'
      session.currentTurnStartedAt = null
      session.statusCard = buildPrCheckoutCard(
        pr.number,
        'checkout',
        error instanceof Error ? error.message : String(error),
      )
      returnPrompt()
      requestInputFocus({ tabId })
    }
  }

  /** Pop the open review's diff out beside it, so the activity feed and the
   *  change read together. Closing it returns the review to Activity. */
  openPrDiff(number: number, ctx: IpcContext = this.workspace.ctx): void {
    this.workspace.router.navigate({
      name: 'prDiff',
      params: {
        number,
        cwd: projectScopeOf(ctx.session) || undefined,
        serverId: runHost(this.workspace.sessions.byId[ctx.session.sessionId]?.run),
      },
    })
  }

  closePrDiff(): void {
    this.workspace.router.close('prDiff')
  }

  /** Close the review and its diff. The destination it was opened beside —
   *  the list or a conversation — is still there. Any session already started
   *  from its composer remains an ordinary workspace tab. */
  exitPrReview(): void {
    this.workspace.router.close('prDiff')
    this.workspace.router.close('prReview')
  }
}
