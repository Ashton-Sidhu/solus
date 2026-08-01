import type { IpcContext, EnrichedError, RateLimitDecisionAction } from '../../shared/types'

function makeErrorStub(message: string): EnrichedError {
  return { message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 }
}

function dispatch(api: typeof window.solus, ctx: IpcContext, action: RateLimitDecisionAction, onError: (err: EnrichedError) => void): Promise<boolean> {
  return api.rateLimitDecision(ctx, action).catch((err: Error) => {
    onError(makeErrorStub(err.message))
    return false
  })
}

export function sendRateLimitedNow(api: typeof window.solus, ctx: IpcContext, rateLimited: boolean, onError: (err: EnrichedError) => void): Promise<boolean> {
  if (!rateLimited) return Promise.resolve(false)
  return dispatch(api, ctx, 'send_now', onError)
}

export function cancelRateLimitedMessages(api: typeof window.solus, ctx: IpcContext, onError: (err: EnrichedError) => void): void {
  dispatch(api, ctx, 'stop', onError)
}

export function queueRateLimitedWait(api: typeof window.solus, ctx: IpcContext, rateLimited: boolean, onError: (err: EnrichedError) => void): Promise<boolean> {
  if (!rateLimited) return Promise.resolve(false)
  return dispatch(api, ctx, 'wait', onError)
}
