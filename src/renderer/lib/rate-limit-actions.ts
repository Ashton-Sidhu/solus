import type { IpcContext, EnrichedError, RateLimitDecisionAction } from '../../shared/types'

function makeErrorStub(message: string): EnrichedError {
  return { message, stderrTail: [], exitCode: null, elapsedMs: 0, toolCallCount: 0 }
}

function dispatch(ctx: IpcContext, action: RateLimitDecisionAction, onError: (err: EnrichedError) => void): Promise<boolean> {
  return window.solus.rateLimitDecision(ctx, action).catch((err: Error) => {
    onError(makeErrorStub(err.message))
    return false
  })
}

export function sendRateLimitedNow(ctx: IpcContext, rateLimited: boolean, onError: (err: EnrichedError) => void): Promise<boolean> {
  if (!rateLimited) return Promise.resolve(false)
  return dispatch(ctx, 'send_now', onError)
}

export function cancelRateLimitedMessages(ctx: IpcContext, onError: (err: EnrichedError) => void): void {
  dispatch(ctx, 'stop', onError)
}

export function queueRateLimitedWait(ctx: IpcContext, rateLimited: boolean, onError: (err: EnrichedError) => void): Promise<boolean> {
  if (!rateLimited) return Promise.resolve(false)
  return dispatch(ctx, 'wait', onError)
}
