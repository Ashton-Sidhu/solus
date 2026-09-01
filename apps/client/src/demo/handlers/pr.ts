import { arg, optionalArg } from './args'
import type { DraftReview } from '@solus/contracts/providers'
import type { PrChecksSnapshot } from '@solus/contracts/checks-rpc-types'
import type { PrInterdiffResult } from '@solus/contracts/git-types'
import { projectScopeOf, type IpcContext, type PrReviewContext } from '@solus/contracts/types'
import type { ReviewState } from '@solus/contracts/review'
import { DEMO_PROJECT, DEMO_VIEWER, type DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerPrHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('prList', (args) => {
    const page = (optionalArg<number>(args, 2)) ?? 1
    const items = page === 1 ? store.prList() : []
    return { items, page, hasMore: false }
  })
  backend.register('prGetEfforts', (args) => {
    const requests = arg<Array<{ number: number; headSha: string }>>(args, 1)
    const byNumber = new Map(store.prList().map((item) => [item.number, item]))
    return requests.map((request) => ({ ...request, effort: byNumber.get(request.number)?.effort }))
  })
  backend.register('prGetOverview', () => store.prOverview())
  backend.register('prGetDetail', () => store.prOverview().pullRequest)
  backend.register('prUpdate', (args) => {
    const patch = arg<{ title?: string; body?: string }>(args, 2)
    const detail = store.prOverview().pullRequest
    if (patch.title !== undefined) detail.title = patch.title
    if (patch.body !== undefined) detail.body = patch.body
    detail.updatedAt = new Date().toISOString()
    const summary = store.prList().find((item) => item.number === detail.number)
    if (summary) {
      summary.title = detail.title
      summary.body = detail.body
      summary.updatedAt = detail.updatedAt
    }
    return detail
  })
  backend.register('prListCommits', () => store.prOverview().commits)
  backend.register('prListReviewers', () => store.prOverview().reviewers)
  backend.register('prListReviewerCandidates', () => [
    { login: 'marisol' },
    { login: 'niko' },
    { login: 'rowan' },
  ])
  backend.register('prRequestReviewers', (args) => {
    const reviewers = store.prOverview().reviewers
    for (const login of arg<string[]>(args, 2)) {
      if (!reviewers.some((reviewer) => reviewer.login === login)) reviewers.push({ login, state: null })
    }
    return reviewers
  })
  backend.register('prRemoveRequestedReviewer', (args) => {
    const login = arg<string>(args, 2)
    const reviewers = store.prOverview().reviewers
    const index = reviewers.findIndex((reviewer) => reviewer.login === login && reviewer.state === null)
    if (index >= 0) reviewers.splice(index, 1)
    return reviewers
  })
  backend.register('prUpdateLifecycle', (args) => {
    const ctx = arg<IpcContext>(args, 0)
    const action = arg<'close' | 'reopen' | 'ready' | 'draft'>(args, 2)
    const detail = store.prOverview().pullRequest
    if (action === 'close') detail.state = 'closed'
    if (action === 'reopen') detail.state = 'open'
    if (action === 'ready') detail.draft = false
    if (action === 'draft') detail.draft = true
    backend.broadcast('pr.lifecycleChanged', { projectRoot: projectCwd(ctx), detail })
    return detail
  })
  backend.register('prChangedFiles', () => store.prChangedFiles())
  backend.register('prListThreads', () => store.prThreads())
  backend.register('providerViewer', () => DEMO_VIEWER)
  // The demo's one pull request is the visitor's own, so the review queue is
  // empty — an inbox that listed your own branch back to you would be a lie.
  backend.register('prNeedsReview', () => [])
  // The capture carries no CI. Reporting an empty run is what keeps the row
  // free of a check chip, rather than a failed load that reads as a red build.
  backend.register('prChecks', (): PrChecksSnapshot => ({
    repo: store.prOverview().pullRequest.baseRepo,
    checks: [],
    loadFailed: false,
  }))
  backend.register('prChecksActivity', () => undefined)
  backend.register('prInvalidate', () => undefined)
  backend.register('prGenerateGuides', () => undefined)
  // Guides are per-pull-request reports an agent writes. The demo ships the one
  // report it has through `readGuide`, and has none of its own to describe.
  backend.register('prGuideMetadata', () => null)
  backend.register('prListComments', () => store.prComments())
  backend.register('prAddIssueComment', (args) => store.addPrComment(arg<string>(args, 2)))
  backend.register('prDeleteIssueComment', (args) => store.deletePrComment(arg<string>(args, 2)))
  // Nothing here was reviewed at an earlier head, so there is no interdiff to
  // show and the Diff tab reads the full patch.
  backend.register('prInterdiff', (args): PrInterdiffResult => {
    const target = arg<PrReviewContext>(args, 1)
    return {
      checkpoint: null,
      state: 'none',
      patch: '',
      isFullDiff: false,
      oldHead: null,
      currentHead: target.headSha,
      currentBase: target.baseSha,
      commentMatches: [],
    }
  })
  backend.register('prReplyThread', (args) => {
    const ctx = arg<IpcContext>(args, 0)
    const threadId = arg<string>(args, 2)
    const body = arg<string>(args, 3)
    const comment = store.replyToPrThread(threadId, body)
    backend.broadcast('prs.invalidated', { projectRoot: projectCwd(ctx) })
    return comment
  })
  backend.register('prResolveThread', (args) => {
    const ctx = arg<IpcContext>(args, 0)
    const threadId = arg<string>(args, 2)
    store.setPrThreadResolved(threadId, true)
    backend.broadcast('prs.invalidated', { projectRoot: projectCwd(ctx) })
  })
  backend.register('prUnresolveThread', (args) => {
    const ctx = arg<IpcContext>(args, 0)
    const threadId = arg<string>(args, 2)
    store.setPrThreadResolved(threadId, false)
    backend.broadcast('prs.invalidated', { projectRoot: projectCwd(ctx) })
  })
  backend.register('prSubmitReview', (args) => {
    const review = arg<DraftReview>(args, 2)
    store.submitPrReview(review)
  })
  backend.register('readReviewState', (args) => store.readReviewState(arg<string>(args, 1)))
  backend.register('writeReviewState', (args) => store.writeReviewState(arg<ReviewState>(args, 1)))
  backend.register('readGuide', () => store.prGuide())
  // The report is written already, so every entry point reports it ready and
  // both request paths just hand the same one back rather than queueing an
  // agent the visitor cannot wait for.
  const guideStatus = (args: unknown[]) =>
    store.reviewGuideStatus(
      arg<IpcContext>(args, 0),
      optionalArg<{ scope?: 'branch' | 'session' }>(args, 1)?.scope ?? 'branch',
    )
  backend.register('reviewGuideStatus', guideStatus)
  backend.register('requestReviewGuide', guideStatus)
  backend.register('generateGuide', (args) => ({
    key: guideStatus(args).key,
    guide: store.prGuide(),
    persisted: true,
  }))
  backend.register('cancelGenerateGuide', () => undefined)
  backend.register('getReviewContext', (args) => store.reviewContext(arg<IpcContext>(args, 0)))
  backend.register('prOpenReview', (args) => store.prReviewContext(arg<number>(args, 1)))
  backend.register('prGetDiff', (args) => {
    const request = arg<{ commitSha?: string }>(args, 1)
    const patch = store.diff(arg<IpcContext>(args, 0), { scope: { kind: 'pr', baseSha: store.prOverview().pullRequest.baseSha } }).patch
    if (!request?.commitSha) return { patch, truncated: false, nextCursor: null }
    // Demo data keeps no per-commit history; serve a stable per-commit slice of
    // the PR patch so the scoped view visibly narrows.
    const files = patch.split(/^(?=diff --git )/m).filter((file) => file.trim().length > 0)
    const index = store.prOverview().commits.findIndex((commit) => commit.sha === request.commitSha)
    return {
      patch: files[index >= 0 ? index % files.length : 0] ?? '',
      truncated: false,
      nextCursor: null,
    }
  })
  backend.register('prGetDiffFileContents', () => ({ oldContents: '', newContents: '' }))
  backend.register('prPrepareCheckout', (args) => {
    const review = store.prReviewContext(arg<{ number: number }>(args, 1).number)
    return {
      worktreePath: review.worktreePath,
      branch: review.branch,
      baseSha: review.baseSha,
      headSha: review.headSha,
    }
  })
  backend.register('prMerge', () => {
    const detail = store.prOverview().pullRequest
    detail.state = 'merged'
    return { merged: true, detail }
  })
  backend.register('prPrepareConflictResolution', (args) => ({
    success: true,
    review: store.prReviewContext(arg<number>(args, 1)),
    conflictFiles: ['src/auth/session.ts'],
    headRef: 'feature/session-hardening',
  }))
}

function projectCwd(ctx: IpcContext): string {
  return projectScopeOf(ctx.session) || DEMO_PROJECT
}
