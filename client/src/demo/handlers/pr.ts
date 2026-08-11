import type { DraftReview } from '../../../../src/shared/providers'
import type { IpcContext } from '../../../../src/shared/types'
import type { ReviewState } from '../../../../src/shared/review'
import { DEMO_PROJECT, type DemoServer } from '../fixtures/types'
import type { DemoStore } from '../store'

export function registerPrHandlers(backend: DemoServer, store: DemoStore): void {
  backend.register('prList', (args) => {
    const page = (args[2] as number | undefined) ?? 1
    const items = page === 1 ? store.prList() : []
    return { items, page, hasMore: false }
  })
  backend.register('prGetEfforts', (args) => {
    const requests = args[1] as Array<{ number: number; headSha: string }>
    const byNumber = new Map(store.prList().map((item) => [item.number, item]))
    return requests.map((request) => ({ ...request, effort: byNumber.get(request.number)?.effort }))
  })
  backend.register('prGetOverview', () => store.prOverview())
  backend.register('prGetDetail', () => store.prOverview().detail)
  backend.register('prUpdate', (args) => {
    const patch = args[2] as { title?: string; body?: string }
    const detail = store.prOverview().detail
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
    for (const login of args[2] as string[]) {
      if (!reviewers.some((reviewer) => reviewer.login === login)) reviewers.push({ login, state: null })
    }
    return reviewers
  })
  backend.register('prRemoveRequestedReviewer', (args) => {
    const login = args[2] as string
    const reviewers = store.prOverview().reviewers
    const index = reviewers.findIndex((reviewer) => reviewer.login === login && reviewer.state === null)
    if (index >= 0) reviewers.splice(index, 1)
    return reviewers
  })
  backend.register('prUpdateLifecycle', (args) => {
    const action = args[2] as 'close' | 'reopen' | 'ready' | 'draft'
    const detail = store.prOverview().detail
    if (action === 'close') detail.state = 'closed'
    if (action === 'reopen') detail.state = 'open'
    if (action === 'ready') detail.draft = false
    if (action === 'draft') detail.draft = true
    return detail
  })
  backend.register('prChangedFiles', () => store.prChangedFiles())
  backend.register('prListThreads', () => store.prThreads())
  backend.register('prReplyThread', (args) => {
    const [ctx, , threadId, body] = args as [IpcContext, number, string, string]
    const comment = store.replyToPrThread(threadId, body)
    backend.broadcast('prs.invalidated', { projectRoot: projectCwd(ctx) })
    return comment
  })
  backend.register('prResolveThread', (args) => {
    const [ctx, , threadId] = args as [IpcContext, number, string]
    store.setPrThreadResolved(threadId, true)
    backend.broadcast('prs.invalidated', { projectRoot: projectCwd(ctx) })
  })
  backend.register('prUnresolveThread', (args) => {
    const [ctx, , threadId] = args as [IpcContext, number, string]
    store.setPrThreadResolved(threadId, false)
    backend.broadcast('prs.invalidated', { projectRoot: projectCwd(ctx) })
  })
  backend.register('prSubmitReview', (args) => {
    const [, , review] = args as [IpcContext, number, DraftReview]
    store.submitPrReview(review)
  })
  backend.register('readReviewState', (args) => store.readReviewState(args[1] as string))
  backend.register('writeReviewState', (args) => store.writeReviewState(args[1] as ReviewState))
  backend.register('readGuide', () => store.prGuide())
  backend.register('getReviewContext', (args) => store.reviewContext(args[0] as IpcContext))
  backend.register('prOpenReview', (args) => store.prReviewContext(args[1] as number))
  backend.register('prGetDiff', (args) => ({
    patch: store.diff(args[0] as IpcContext, { scope: { kind: 'pr', baseSha: store.prOverview().detail.baseSha } }).patch,
    truncated: false,
    nextCursor: null,
  }))
  backend.register('prGetDiffFileContents', () => ({ oldContents: '', newContents: '' }))
  backend.register('prPrepareCheckout', (args) => {
    const review = store.prReviewContext((args[1] as { number: number }).number)
    return {
      worktreePath: review.worktreePath,
      branch: review.branch,
      baseSha: review.baseSha,
      headSha: review.headSha,
    }
  })
  backend.register('prMerge', () => {
    const detail = store.prOverview().detail
    detail.state = 'merged'
    return { merged: true, detail }
  })
  backend.register('prPrepareConflictResolution', (args) => ({
    success: true,
    review: store.prReviewContext(args[1] as number),
    conflictFiles: ['src/auth/session.ts'],
    headRef: 'feature/session-hardening',
  }))
}

function projectCwd(ctx: IpcContext): string {
  return ctx.session.projectPath || ctx.session.workingDirectory || DEMO_PROJECT
}
