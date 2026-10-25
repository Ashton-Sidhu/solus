import {
  hostReadinessCopy,
  isWaitingForHost,
  type HostReadinessAction,
  type HostReadinessState,
} from '@solus/client-core/host-readiness'

/**
 * What a thread shows for its host's readiness (docs/plans/host-readiness.md).
 * Inside the grace a drop is short: the composer stays and one whisper over it
 * says the host is reconnecting. Once the host is away, the thread goes to
 * sleep: it dims and takes no touch under one statement of what happened, and
 * nothing that needs the host shows. The queue pill stays: it shows what waits
 * to send.
 */
export interface ThreadHostChrome {
  showsComposer: boolean
  /** "Reconnecting to Raiders…" over the composer, inside the grace. */
  showsGraceWhisper: boolean
  /** Approval, question, plan, and usage-limit cards: each one waits on an answer the host takes. */
  showsRequestCards: boolean
  /** The Agents pill opens agents that only the host can stop or follow. */
  showsAgentsPill: boolean
  /**
   * The thread dims under the asleep veil. An empty thread shows only the veil:
   * no loading spinner and no "No conversation yet", which the host must answer.
   */
  isAsleep: boolean
}

export function threadHostChrome(state: Pick<HostReadinessState, 'readiness' | 'away'>): ThreadHostChrome {
  return {
    showsComposer: !state.away,
    showsGraceWhisper: !state.away && isWaitingForHost(state.readiness),
    showsRequestCards: !state.away,
    showsAgentsPill: !state.away,
    isAsleep: state.away,
  }
}

/** The statement over a sleeping thread. Details is always there; the rest follows the dial. */
export interface HostAsleepVeilCopy {
  /** "Raiders is offline." or "Trying Raiders again…". */
  heading: string
  /** "Last seen 4 min ago. Solus keeps trying."; none while a dial runs. */
  detail: string | null
  /** A retry or a start dials now: the heading shows a spinner. */
  isDialing: boolean
  /** The one thing to do, as the primary button; none while a dial runs. */
  action: HostReadinessAction | null
}

/**
 * `isStarting` is true while this client asked a managed host to start and
 * has no answer yet: that is a dial too, so the Start button does not show twice.
 */
export function hostAsleepVeilCopy(
  state: HostReadinessState,
  hostLabel: string,
  isStarting: boolean,
  now = Date.now(),
): HostAsleepVeilCopy {
  const isDialing = isStarting || isWaitingForHost(state.readiness)
  if (isDialing) return { heading: `Trying ${hostLabel} again…`, detail: null, isDialing, action: null }
  const copy = hostReadinessCopy(state, hostLabel, now)
  return { heading: `${copy.headline}.`, detail: copy.detail, isDialing, action: copy.action }
}
