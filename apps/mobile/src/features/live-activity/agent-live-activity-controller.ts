import type { KeyValueStore } from '../../platform/ports'
import type { AgentActivityProps } from '../../widgets/AgentActivity'
import { deriveAgentActivity, type AgentActivityInput } from './agent-activity-model'

/**
 * Keeps one Live Activity (Lock Screen, Always-On Display and Dynamic Island)
 * in step with the sessions this device knows, as T3 Code keeps its one
 * aggregate card per device.
 *
 * Solus has no push relay, so only the app updates the card: while it runs,
 * every change lands within a moment; once iOS suspends it, the card's stale
 * date (10 minutes, T3's window) marks it "Out of date" rather than letting it
 * claim work it cannot see. A card starts only while the app is in front, as
 * ActivityKit allows and as T3 does; it ends when nothing is left running.
 */

export interface LiveActivityHandle {
  /** The ActivityKit id: each read of the cards answers new handles for the same card. */
  getId(): string
  update(props: AgentActivityProps, staleDate: Date): Promise<void>
  end(policy: 'default' | 'immediate', props?: AgentActivityProps): Promise<void>
}

export interface LiveActivityBridge {
  /** Cards that already exist: from an earlier run of the app, too. */
  instances(): LiveActivityHandle[]
  /** Null where Live Activities are not available or are turned off in iOS Settings. */
  start(props: AgentActivityProps, staleDate: Date): LiveActivityHandle | null
}

export interface AgentLiveActivityDeps {
  readonly bridge: LiveActivityBridge
  /** Every known host has answered its first session read. */
  readonly ready: () => boolean
  readonly read: () => Pick<AgentActivityInput, 'threads' | 'liveStatus' | 'projectTitleOf'>
  readonly enabled: () => boolean
  readonly foreground: () => boolean
  readonly now: () => number
  /** Keeps the card's sessions across a restart, so a card left running can show how its work ended. */
  readonly storage: Pick<KeyValueStore, 'getItem' | 'setItem' | 'removeItem'>
  readonly onError?: (error: unknown) => void
}

export const LIVE_ACTIVITY_STALE_AFTER_MS = 10 * 60_000
const TRACKED_KEY = 'solus.liveActivities.tracked'

export class AgentLiveActivityController {
  private activity: LiveActivityHandle | null = null
  private adopted = false
  private tracked: ReadonlyMap<string, number | null> = new Map()
  /** The last content sent, without its timestamps, so a repeat is not sent again. */
  private sent = ''

  constructor(private readonly deps: AgentLiveActivityDeps) {}

  /** Read the sessions again and start, update or end the card to match. */
  sync(): void {
    if (!this.deps.enabled()) {
      this.endAll('immediate')
      return
    }
    // Before the hosts answer, an empty list would end a card that is still true.
    if (!this.deps.ready()) return
    this.adopt()
    // A card the person swiped away takes no updates: the next one starts fresh.
    if (this.activity && !this.isActive(this.activity)) this.drop(this.activity)
    const state = deriveAgentActivity({ ...this.deps.read(), tracked: this.tracked, now: this.deps.now() })
    this.track(state.tracked)
    if (!state.props) {
      // Nothing this run knows of: a card left from an earlier run cannot be vouched for.
      this.endAll('immediate')
      return
    }
    if (state.activeCount === 0) {
      // All work settled: the card shows the outcome, and iOS keeps it on the
      // Lock Screen for a while before removing it.
      const finished = this.activity
      this.activity = null
      this.track(new Map())
      this.sent = ''
      if (finished) this.guard(finished.end('default', state.props))
      return
    }
    const staleDate = new Date(this.deps.now() + LIVE_ACTIVITY_STALE_AFTER_MS)
    const content = JSON.stringify({ ...state.props, updatedAt: '', activities: state.props.activities.map((row) => ({ ...row, updatedAt: '' })) })
    if (!this.activity) {
      if (!this.deps.foreground()) return
      try {
        this.activity = this.deps.bridge.start(state.props, staleDate)
        this.sent = content
      } catch (error) {
        this.deps.onError?.(error)
      }
      return
    }
    if (content === this.sent) return
    this.sent = content
    const card = this.activity
    card.update(state.props, staleDate).catch((error: unknown) => {
      // The card is gone: the next change starts a new one.
      this.drop(card)
      this.deps.onError?.(error)
    })
  }

  /** Push the stale date out while the app runs, so a quiet card does not read as out of date. */
  refresh(): void {
    this.sent = ''
    this.sync()
  }

  private adopt(): void {
    if (this.adopted) return
    this.adopted = true
    let existing: LiveActivityHandle[] = []
    try {
      existing = this.deps.bridge.instances()
    } catch (error) {
      this.deps.onError?.(error)
    }
    const [first, ...extra] = existing
    // One card per device; extras from a race end now.
    for (const card of extra) this.guard(card.end('immediate'))
    this.activity = first ?? null
    // The sessions the earlier run's card showed: the ones that finished
    // since then stay on it as Done or Failed.
    if (first) this.tracked = new Map(this.savedKeys().map((key) => [key, null]))
    else this.deps.storage.removeItem(TRACKED_KEY)
  }

  private endAll(policy: 'default' | 'immediate'): void {
    this.adopt()
    const card = this.activity
    this.activity = null
    this.track(new Map())
    this.sent = ''
    if (card) this.guard(card.end(policy))
  }

  /** False once the card is gone: the person swiped it away, or iOS ended it. */
  private isActive(card: LiveActivityHandle): boolean {
    try {
      const id = card.getId()
      return this.deps.bridge.instances().some((instance) => instance.getId() === id)
    } catch (error) {
      this.deps.onError?.(error)
      return true
    }
  }

  private drop(card: LiveActivityHandle): void {
    if (this.activity !== card) return
    this.activity = null
    this.sent = ''
  }

  private track(next: ReadonlyMap<string, number | null>): void {
    const changed = next.size !== this.tracked.size || [...next.keys()].some((key) => !this.tracked.has(key))
    this.tracked = next
    if (!changed) return
    if (next.size === 0) this.deps.storage.removeItem(TRACKED_KEY)
    else this.deps.storage.setItem(TRACKED_KEY, JSON.stringify([...next.keys()]))
  }

  private savedKeys(): string[] {
    try {
      const saved: unknown = JSON.parse(this.deps.storage.getItem(TRACKED_KEY) ?? '[]')
      return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === 'string') : []
    } catch {
      return []
    }
  }

  private guard(work: Promise<void>): void {
    work.catch((error: unknown) => this.deps.onError?.(error))
  }
}
