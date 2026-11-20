import type { SessionCloudHead, SessionHostTurn } from './session-heads'

/**
 * The cloud state of one session on the host that runs its tab
 * (docs/plans/portable-sessions.md §10, portable-sessions-cloud.md §8.1 E).
 * At most one shows; the first that applies wins.
 *
 * - `push-refused`: another host pushed first. The turns on this host are not
 *   in the session (design answer 3.4). `continuedOn*` names that host.
 * - `running-elsewhere`: another connected host runs a turn now (plan §4
 *   decision 5). Run on stays locked, and a prompt goes to that host.
 * - `not-synced`: the newest turn of the session is not in the cloud yet.
 */
export type SessionCloudState =
  | { kind: 'push-refused'; continuedOnServerId: string | null; continuedOnHostId: string | null }
  | { kind: 'running-elsewhere'; runningServerId: string }
  | { kind: 'not-synced' }

export interface SessionCloudStateInput {
  runServerId: string
  /** What each host this client read holds of the session. */
  turns: readonly SessionHostTurn[]
  /** What the cloud knows; null when this client has no cloud facts (signed out). */
  cloud: SessionCloudHead | null | undefined
  /** The connected host that `cloud.runningHostId` names. A running host this
   *  client cannot reach is not counted (design §5.4): its fact can be stale. */
  runningServerId: string | null
  /** The run host refused a prompt with `SESSION_DIVERGED`. */
  wasPromptRefused?: boolean
}

export function sessionCloudState(input: SessionCloudStateInput): SessionCloudState | null {
  const { runServerId, turns, cloud, runningServerId } = input
  const run = turns.find((entry) => entry.serverId === runServerId)
  if (run?.pushRefused || input.wasPromptRefused) {
    return { kind: 'push-refused', continuedOnServerId: cloud?.lastRunServerId ?? null, continuedOnHostId: cloud?.lastRunHostId ?? null }
  }
  if (runningServerId && runningServerId !== runServerId) return { kind: 'running-elsewhere', runningServerId }
  // Only a session the cloud knows can be behind it: with sync off, or before
  // the first push, there is no cloud copy to be behind.
  if (!cloud || cloud.syncedTurn <= 0) return null
  const newest = Math.max(0, ...turns.map((entry) => entry.syncedTurn))
  return newest > cloud.syncedTurn ? { kind: 'not-synced' } : null
}

/** The words of a cloud state. `hostLabel` names a host id the state carries. */
export function sessionCloudStateText(state: SessionCloudState, hostLabel: (serverId: string | null) => string): string {
  switch (state.kind) {
    case 'push-refused': return `This session continued on ${hostLabel(state.continuedOnServerId)}. The turns on this machine are not in it.`
    case 'running-elsewhere': return `Running on ${hostLabel(state.runningServerId)}`
    case 'not-synced': return 'Not synced yet'
  }
}

/**
 * Whether a started conversation has no host to show it from yet: the cloud
 * lists the session, the run host has no copy this client read, and nothing
 * loads or syncs. The client shows a calm empty state, and the conversation
 * shows when a machine that has it is selected (design §5.5; the cloud read of
 * the transcript is phase 5).
 */
export function conversationAwaitsMachine(input: {
  hasStarted: boolean
  messageCount: number
  isLoadingHistory: boolean
  /** A setup or sync card shows: the conversation view draws it. */
  hasStatusCard: boolean
  runServerId: string
  isRunHostAway: boolean
  runTurn: SessionHostTurn | undefined
  cloud: SessionCloudHead | null | undefined
}): boolean {
  if (!input.hasStarted || input.messageCount > 0 || input.isLoadingHistory || input.hasStatusCard) return false
  if (!input.cloud || input.cloud.syncedTurn <= 0) return false
  // The reachable host that ran the last turn has the conversation; it loads from there.
  if (input.cloud.lastRunServerId === input.runServerId && !input.isRunHostAway) return false
  return !input.runTurn || input.runTurn.syncedTurn <= 0
}
