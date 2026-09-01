import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * The user-input stream for one Claude turn, held open for the turn's duration
 * (streaming input mode). A message pushed while the turn is live lands in the
 * SDK's running agent loop, so the model picks it up at its next decision point
 * and keeps working in the *same* turn — that is what separates steering from
 * queueing, which can only start a fresh run once the turn is over.
 *
 * Closing the stream is what lets the SDK query drain and exit, so a turn that
 * is never closed never ends.
 */
export class TurnInputChannel {
  private buffered: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private isClosed = false
  private isSealed = false

  /** @param previewText the opening message's text, for the git turn snapshot. */
  constructor(opening: SDKUserMessage, readonly previewText: string) {
    this.buffered.push(opening)
  }

  get closed(): boolean {
    return this.isClosed
  }

  /**
   * Stop accepting steered messages, without ending the stream — the turn has
   * produced its result and is settling, so anything pushed from here on would
   * never be read. Separate from `close()`, which can lag the result by the
   * length of a git snapshot and by any backgrounded sub-agent.
   */
  seal(): void {
    this.isSealed = true
  }

  /** @returns false when the message was refused because the turn is already
   *  settling or over, so the caller can queue it for the next run instead. */
  push(message: SDKUserMessage): boolean {
    if (this.isSealed || this.isClosed) return false
    const waiting = this.waiting
    if (waiting) {
      this.waiting = null
      waiting({ value: message, done: false })
    } else {
      this.buffered.push(message)
    }
    return true
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    const waiting = this.waiting
    if (waiting) {
      this.waiting = null
      waiting({ value: undefined as never, done: true })
    }
  }

  get stream(): AsyncIterable<SDKUserMessage> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<SDKUserMessage>> => {
          const buffered = this.buffered.shift()
          if (buffered) return Promise.resolve({ value: buffered, done: false })
          if (this.isClosed) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve) => { this.waiting = resolve })
        },
      }),
    }
  }
}
