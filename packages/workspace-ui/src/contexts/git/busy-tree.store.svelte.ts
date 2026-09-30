/**
 * The question a git action or a new session asks when the host answers that
 * another session runs in the same working tree (plan 004 item 7). The host
 * does not lock the tree; the person chooses. One question is open at a time.
 */
class BusyTreeQuestion {
  /** The host's words for the question on screen; null when no question is open. */
  message = $state<string | null>(null)
  private answer: ((proceed: boolean) => void) | null = null

  /** Asks the person. True when they continue. A new question cancels an open one. */
  ask(message: string): Promise<boolean> {
    this.answer?.(false)
    this.message = message
    return new Promise((resolve) => {
      this.answer = resolve
    })
  }

  settle(proceed: boolean): void {
    const answer = this.answer
    this.answer = null
    this.message = null
    answer?.(proceed)
  }
}

export const busyTreeQuestion = new BusyTreeQuestion()
