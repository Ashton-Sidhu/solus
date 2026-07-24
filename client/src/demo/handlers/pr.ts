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
  backend.register('prListCommits', () => store.prOverview().commits)
  backend.register('prListReviewers', () => store.prOverview().reviewers)
  backend.register('prChangedFiles', () => store.prChangedFiles())
  backend.register('prListThreads', () => store.prThreads())
  backend.register('prReplyThread', (args) => {
    const [ctx, , threadId, body] = args as [IpcContext, number, string, string]
    const comment = store.replyToPrThread(threadId, body)
    backend.broadcast('prs-changed', projectCwd(ctx))
    return comment
  })
  backend.register('prResolveThread', (args) => {
    const [ctx, , threadId] = args as [IpcContext, number, string]
    store.setPrThreadResolved(threadId, true)
    backend.broadcast('prs-changed', projectCwd(ctx))
  })
  backend.register('prUnresolveThread', (args) => {
    const [ctx, , threadId] = args as [IpcContext, number, string]
    store.setPrThreadResolved(threadId, false)
    backend.broadcast('prs-changed', projectCwd(ctx))
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
  backend.register('prMerge', () => ({ merged: true }))
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
