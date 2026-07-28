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

  /** @param previewText the opening message's text, for the git turn snapshot. */
  constructor(opening: SDKUserMessage, readonly previewText: string) {
    this.buffered.push(opening)
  }

  get closed(): boolean {
    return this.isClosed
  }

  push(message: SDKUserMessage): void {
    if (this.isClosed) return
    const waiting = this.waiting
    if (waiting) {
      this.waiting = null
      waiting({ value: message, done: false })
    } else {
      this.buffered.push(message)
    }
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
