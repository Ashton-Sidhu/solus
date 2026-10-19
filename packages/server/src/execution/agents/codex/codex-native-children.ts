import type { NormalizedEvent } from '@solus/contracts/types'
import type { CodexAppServerClient } from './codex-agent'
import type { CodexTurnNormalizer } from './codex-event-normalizer'
import type { CodexServerNotification } from './codex-protocol'
import { codexSpawnedThreadLinks } from './codex-utils'
import type { Turn } from './generated/v2/Turn'
import type { TurnStatus } from './generated/v2/TurnStatus'

/** The root run a native child reports to. */
export interface NativeChildOwner {
  /** The root thread whose sub-agent card the child reports to. */
  sessionId: string
  client: CodexAppServerClient
  /** The root run's normalizer: it maps the child's thread to its card. */
  normalizer: CodexTurnNormalizer
}

type BackgroundTaskStatus = Extract<NormalizedEvent, { type: 'background_task_settled' }>['status']

/** A child's background task settled; the backend decides what follows. */
export interface SettledChild {
  sessionId: string
  client: CodexAppServerClient
  status: BackgroundTaskStatus
}

/** A child turn for Stop to interrupt. */
export interface ChildTurn {
  sessionId: string
  threadId: string
  turnId: string
  client: CodexAppServerClient
}

/** A detached child Stop was asked for. Its turn id is null when Codex never
 *  reported the turn to this host, so Stop must ask for it. */
export type ChildStop = Omit<ChildTurn, 'turnId'> & { turnId: string | null }

interface NativeChild extends NativeChildOwner {
  /** The spawn card the child reports to. */
  toolUseId: string
  /** The child's turn in progress, which Stop interrupts. Null until Codex names it. */
  turnId: string | null
  /** Spawned or in a turn: the child has work in progress. */
  isWorking: boolean
  /** The root turn ended while the child worked: it is the session's background task. */
  isDetached: boolean
  /** A person stopped it, so its end settles as stopped. */
  isStopping: boolean
}

/** Only what belongs to a sub-agent card. A child must never settle, plan for,
 *  or change the usage of the root turn it outlived. */
function isCardEvent(event: NormalizedEvent): boolean {
  if (event.type === 'subagent_running') return true
  return 'parentToolUseId' in event && !!event.parentToolUseId
}

function threadIdOf(message: CodexServerNotification): string | null {
  return 'threadId' in message.params ? message.params.threadId ?? null : null
}

/** How a child's turn end settles its background task. */
function settledStatus(child: NativeChild, turnStatus: TurnStatus): BackgroundTaskStatus {
  if (child.isStopping || turnStatus === 'interrupted') return 'stopped'
  return turnStatus === 'completed' ? 'completed' : 'failed'
}

/** A turn end Codex will not send: the child was stopped, or its app-server is gone. */
function turnEnd(threadId: string, turnId: string | null, status: TurnStatus, error: string | null): CodexServerNotification {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: {
        id: turnId ?? '',
        items: [],
        itemsView: 'notLoaded',
        status,
        error: error === null ? null : { message: error, codexErrorInfo: null, additionalDetails: null },
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    },
  }
}

/**
 * Native Codex sub-agents work on their own threads, so one can outlive the
 * root turn that started it: a failed root, or one that ended without waiting.
 * The root run settles at once and frees its queue. Each child that still
 * works becomes a background task of the session (`background_task_started`,
 * keyed by its thread), keeps the root's normalizer, and reports to its card.
 * It settles once: when its turn ends, when Stop interrupts it, when a later
 * root run links it again, or when its app-server exits. Shutdown drops all.
 */
export class CodexNativeChildren {
  private readonly children = new Map<string, NativeChild>()

  constructor(private readonly hooks: {
    emit: (sessionId: string, event: NormalizedEvent) => void
    settled: (child: SettledChild) => void
    /** A child stopped before its turn started has started it now. */
    interrupt: (turn: ChildTurn) => void
  }) {}

  /** Follow the children an active root run links, starts and settles. Only
   *  events the run's routing gave to this session arrive here, so a thread
   *  other than the root is one of its children. */
  observeRootRunEvent(message: CodexServerNotification, owner: NativeChildOwner, rootThreadId: string | null): void {
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = message.params.item
      for (const link of codexSpawnedThreadLinks(item)) this.link(link.threadId, link.toolId, owner)
      if (item.type === 'subAgentActivity' && item.kind === 'interrupted') this.stopWorking(item.agentThreadId, owner)
      return
    }
    const threadId = threadIdOf(message)
    if (!threadId || threadId === rootThreadId) return
    const child = this.children.get(threadId)
    if (child?.normalizer !== owner.normalizer) return
    // A child is reusable: a follow-up turn makes it work again.
    if (message.method === 'turn/started') {
      child.isWorking = true
      child.turnId = message.params.turn.id
    }
    if (message.method === 'turn/completed') this.stopWorking(threadId, owner)
  }

  private link(threadId: string, toolUseId: string, owner: NativeChildOwner): void {
    const child = this.children.get(threadId)
    // A repeated or replayed spawn record is no new work: only the child's
    // next turn/started makes an ended child work again.
    if (child?.normalizer === owner.normalizer) return
    // A later root run that links the child again owns it from now on; the
    // old card's background task ends here, once.
    if (child?.isDetached) {
      this.children.delete(threadId)
      this.reportSettled(threadId, child, 'completed')
    }
    this.children.set(threadId, { ...owner, toolUseId, turnId: null, isWorking: true, isDetached: false, isStopping: false })
  }

  private stopWorking(threadId: string, owner: NativeChildOwner): void {
    const child = this.children.get(threadId)
    if (child?.normalizer !== owner.normalizer || child.isDetached) return
    child.isWorking = false
    child.turnId = null
  }

  /**
   * The root turn completed or failed. Its children that still work become
   * background tasks of the session, announced before the turn's result;
   * the rest are forgotten.
   */
  detach(sessionId: string): string[] {
    const detached: string[] = []
    for (const [threadId, child] of this.children) {
      if (child.sessionId !== sessionId || child.isDetached) continue
      if (!child.isWorking) {
        this.children.delete(threadId)
        continue
      }
      child.isDetached = true
      detached.push(threadId)
      this.hooks.emit(sessionId, { type: 'background_task_started', taskId: threadId, toolUseId: child.toolUseId })
    }
    return detached
  }

  /** The root turn was interrupted, or its events never reach a session: its
   *  normalizer reports nothing more, so its children are let go. */
  release(sessionId: string): void {
    for (const [threadId, child] of this.children) {
      if (child.sessionId === sessionId && !child.isDetached) this.children.delete(threadId)
    }
  }

  /** Deliver one event from a child whose root turn ended. False when no
   *  detached child owns the event's thread. */
  deliver(message: CodexServerNotification): boolean {
    const threadId = threadIdOf(message)
    const child = threadId ? this.children.get(threadId) : undefined
    if (!threadId || !child?.isDetached) return false
    if (message.method === 'turn/started') {
      // Stop came before Codex named the turn: the turn is interrupted now.
      const isStopPending = child.isStopping && !child.turnId
      child.turnId = message.params.turn.id
      if (isStopPending) this.hooks.interrupt({ sessionId: child.sessionId, threadId, turnId: child.turnId, client: child.client })
    }
    // Removed before the report, so a repeated end reports nothing.
    if (message.method === 'turn/completed') this.children.delete(threadId)
    for (const event of child.normalizer.push(message)) {
      if (isCardEvent(event)) this.hooks.emit(child.sessionId, event)
    }
    if (message.method === 'turn/completed') this.reportSettled(threadId, child, settledStatus(child, message.params.turn.status))
    return true
  }

  private reportSettled(threadId: string, child: NativeChild, status: BackgroundTaskStatus): void {
    this.hooks.emit(child.sessionId, { type: 'background_task_settled', taskId: threadId, toolUseId: child.toolUseId, status })
    this.hooks.settled({ sessionId: child.sessionId, client: child.client, status })
  }

  /** Whether a child of the session is a background task. */
  hasDetached(sessionId: string): boolean {
    for (const child of this.children.values()) {
      if (child.sessionId === sessionId && child.isDetached) return true
    }
    return false
  }

  /** The turns of the active root run's children, for a Stop during that run. */
  runningTurnsOf(sessionId: string): ChildTurn[] {
    const turns: ChildTurn[] = []
    for (const [threadId, child] of this.children) {
      if (child.sessionId === sessionId && !child.isDetached && child.turnId) turns.push({ sessionId, threadId, turnId: child.turnId, client: child.client })
    }
    return turns
  }

  /** Every background task of the session, marked as stopping, for Stop on the session. */
  stopsOf(sessionId: string): ChildStop[] {
    const stops: ChildStop[] = []
    for (const threadId of this.children.keys()) {
      const stop = this.taskToStop(sessionId, threadId)
      if (stop) stops.push(stop)
    }
    return stops
  }

  /** The background task `taskId` of the session, marked as stopping. Null
   *  when it is not one. */
  taskToStop(sessionId: string, taskId: string): ChildStop | null {
    const child = this.children.get(taskId)
    if (!child?.isDetached || child.sessionId !== sessionId) return null
    child.isStopping = true
    return { sessionId, threadId: taskId, turnId: child.turnId, client: child.client }
  }

  /** Stop did not reach the child: its end settles as it really ends. */
  abandonStop(threadId: string): void {
    const child = this.children.get(threadId)
    if (child?.isDetached) child.isStopping = false
  }

  /**
   * Apply what Codex says the child's thread holds, read for a Stop. A turn in
   * progress is the one to interrupt. With none, the last turn's end settles
   * the task as it really ended. With no turn yet, the stop waits for the
   * child's turn/started.
   */
  resolveStop(threadId: string, turns: Turn[]): ChildTurn | null {
    const child = this.children.get(threadId)
    if (!child?.isDetached) return null
    const running = turns.findLast((turn) => turn.status === 'inProgress')
    if (running) {
      child.turnId = running.id
      return { sessionId: child.sessionId, threadId, turnId: running.id, client: child.client }
    }
    const ended = turns.at(-1)
    if (!ended) return null
    child.isStopping = false
    this.deliver({ method: 'turn/completed', params: { threadId, turn: ended } })
    return null
  }

  /** The app-server exited and took its threads with it. */
  releaseClient(client: CodexAppServerClient): void {
    for (const [threadId, child] of this.children) {
      if (child.client !== client) continue
      this.children.delete(threadId)
      if (!child.isDetached) continue
      for (const event of child.normalizer.push(turnEnd(threadId, child.turnId, 'failed', 'Codex app-server exited'))) {
        if (isCardEvent(event)) this.hooks.emit(child.sessionId, event)
      }
      this.reportSettled(threadId, child, 'killed')
    }
  }

  clear(): void {
    this.children.clear()
  }
}
