/**
 * One stop for each turn (docs/plans/turn-stop.md). A turn's stop opens when
 * its prompt is admitted and stays open while the turn, or the background work
 * it leaves, runs. Each phase of the turn registers what Stop cancels while
 * that phase runs, and releases it when the phase ends.
 */
export class TurnStop {
  private readonly controller = new AbortController()
  private readonly cancels = new Set<() => boolean>()

  /** Aborted with `Error('Interrupted')` once Stop cancelled this turn's work. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** What Stop cancels while a phase runs. `cancel` answers whether there was
   *  work to cancel. Returns the release for the end of the phase. */
  onStop(cancel: () => boolean): () => void {
    this.cancels.add(cancel)
    return () => { this.cancels.delete(cancel) }
  }

  /** Cancels the work of every open phase. True when there was work to cancel. */
  stop(): boolean {
    if (this.signal.aborted) return false
    let hasStopped = false
    for (const cancel of this.cancels) hasStopped = cancel() || hasStopped
    if (!hasStopped) return false
    this.cancels.clear()
    this.controller.abort(new Error('Interrupted'))
    return true
  }
}

/** The turn stop of each session. A new turn replaces the one before it. */
export class TurnStops {
  private readonly turns = new Map<string, TurnStop>()

  begin(sessionId: string): TurnStop {
    const turn = new TurnStop()
    this.turns.set(sessionId, turn)
    return turn
  }

  get(sessionId: string): TurnStop | undefined {
    return this.turns.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.turns.has(sessionId)
  }

  /** Closes `turn`, unless a later turn of the session replaced it. */
  end(sessionId: string, turn: TurnStop): void {
    if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId)
  }
}
