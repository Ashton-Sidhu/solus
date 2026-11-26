import type { RunHandle } from '../agents/agent-backend'
import type { TurnOutcome, TurnPhase } from './derived-status'

/**
 * One turn of a session (plans/037-turn-owned-session-status.md): its id, its
 * phase, and its stop. The phase moves only forward, from starting to running
 * to settled, so a settled turn never opens again.
 *
 * The stop opens when the turn begins and stays open while the turn, or the
 * background work it leaves, runs. Each phase of the work registers what Stop
 * cancels while that phase runs, and releases it when the phase ends.
 */
export class Turn {
  private readonly controller = new AbortController()
  private readonly cancels = new Set<() => boolean>()
  private isStopOpen = true
  private settledOutcome: TurnOutcome | null = null
  private isSettlementSent = false
  private isParkedOnLimit = false
  private isHandedToQueue = false

  constructor(readonly id: string, private current: 'starting' | 'running') {}

  get phase(): TurnPhase {
    return this.settledOutcome ? { phase: 'settled', outcome: this.settledOutcome } : { phase: this.current }
  }

  get outcome(): TurnOutcome | null {
    return this.settledOutcome
  }

  get isSettled(): boolean {
    return this.settledOutcome !== null
  }

  /** A person stopped the turn, or a rejected plan ended it. Its run never opens a turn again. */
  get wasStopped(): boolean {
    return this.signal.aborted || this.settledOutcome === 'interrupted'
  }

  /** A rate limit parked the turn. It never settles: its prompt waits in the
   *  queue and runs again as a new turn, or the park is released. */
  get isParked(): boolean {
    return this.isParkedOnLimit
  }

  /** The turn has settled, and a queued prompt takes the session over. */
  get isTakenOverByQueue(): boolean {
    return this.isHandedToQueue
  }

  /** The provider reports work. A starting turn now runs; any other phase stays. */
  markRunning(): void {
    this.current = 'running'
  }

  /** Settles the turn. The phase stays settled. A later outcome replaces an
   *  earlier one: Stop on the background work of a completed turn ends it as
   *  stopped, and a failed exit after a result ends it as failed. True the first time. */
  settle(outcome: TurnOutcome): boolean {
    const isFirst = this.settledOutcome === null
    this.settledOutcome = outcome
    return isFirst
  }

  park(): void {
    this.isParkedOnLimit = true
  }

  /** `isTakingOver` false: the queued prompt left before it could start, so the turn shows its outcome. */
  handOverToQueue(isTakingOver: boolean): void {
    this.isHandedToQueue = isTakingOver
  }

  /** True the first time only: a turn's `turn_settled` goes out once. A turn
   *  that waits on background work has settled, but its settlement goes out
   *  when the wait ends, and never if the agent wakes into a new turn. */
  claimSettlement(): boolean {
    if (this.isSettlementSent) return false
    this.isSettlementSent = true
    return true
  }

  /** Aborted with `Error('Interrupted')` once Stop cancelled this turn's work. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** True until the turn's work and the background work it left have ended. */
  get isStoppable(): boolean {
    return this.isStopOpen
  }

  /** What Stop cancels while a phase runs. `cancel` answers whether there was
   *  work to cancel. Returns the release for the end of the phase. */
  onStop(cancel: () => boolean): () => void {
    this.cancels.add(cancel)
    return () => { this.cancels.delete(cancel) }
  }

  /** Cancels the work of every open phase. True when there was work to cancel.
   *  A phase stays registered until it ends, so a second Stop on work that
   *  ignored the first reaches it again: a provider makes that a force stop. */
  stop(): boolean {
    let hasStopped = false
    for (const cancel of this.cancels) hasStopped = cancel() || hasStopped
    if (!hasStopped) return false
    if (!this.signal.aborted) this.controller.abort(new Error('Interrupted'))
    return true
  }

  /** The turn's work has ended: Stop has nothing more to reach. */
  closeStop(): void {
    this.isStopOpen = false
    this.cancels.clear()
  }
}

/**
 * The newest turn of each session, and the turn each run belongs to. A run
 * acts on its own turn, so an event of an older run cannot change a newer turn.
 */
export class Turns {
  private readonly newest = new Map<string, Turn>()
  private readonly runs = new WeakMap<RunHandle, Turn>()

  /** A new turn replaces the one before it as the session's newest turn. */
  begin(sessionId: string, options: { id?: string; phase?: 'starting' | 'running' } = {}): Turn {
    const turn = new Turn(options.id ?? crypto.randomUUID(), options.phase ?? 'starting')
    this.newest.set(sessionId, turn)
    return turn
  }

  /** The session's newest turn, settled or not. */
  current(sessionId: string): Turn | undefined {
    return this.newest.get(sessionId)
  }

  /** The newest turn while Stop can still reach its work. */
  stoppable(sessionId: string): Turn | undefined {
    const turn = this.newest.get(sessionId)
    return turn?.isStoppable ? turn : undefined
  }

  /** The run belongs to `turn` from now on. A run that opens a new turn binds to it again. */
  bindRun(handle: RunHandle, turn: Turn): void {
    this.runs.set(handle, turn)
  }

  ofRun(handle: RunHandle): Turn | undefined {
    return this.runs.get(handle)
  }

  /** The session has no turn: it is idle. */
  clear(sessionId: string): void {
    this.newest.delete(sessionId)
  }
}
