import type { SessionMeta } from '@solus/contracts/types'

/**
 * What one host holds of one session's session repository
 * (docs/plans/portable-sessions.md §9): its local head and how many turns it
 * has. A session that ran on two hosts has one of these for each.
 */
export interface SessionHostTurn {
  serverId: string
  head: string | null
  syncedTurn: number
}

/**
 * The facts one host answered for a session, or null when the host keeps no
 * session repository (an older host, or a Solus API, which reports no count).
 */
export function sessionHostTurnOf(
  serverId: string,
  meta: Pick<SessionMeta, 'head' | 'syncedTurn'> | null | undefined,
): SessionHostTurn | null {
  if (!meta || meta.syncedTurn === undefined) return null
  return { serverId, head: meta.head ?? null, syncedTurn: meta.syncedTurn }
}

/** The facts with one host's answer in place of its older one. Equal facts
 *  return the same array, so a reader that compares by reference sees no change. */
export function withSessionHostTurn(
  turns: readonly SessionHostTurn[],
  turn: SessionHostTurn,
): readonly SessionHostTurn[] {
  const index = turns.findIndex((entry) => entry.serverId === turn.serverId)
  const known = index === -1 ? undefined : turns[index]
  if (known && known.head === turn.head && known.syncedTurn === turn.syncedTurn) return turns
  if (index === -1) return [...turns, turn]
  return turns.map((entry, position) => (position === index ? turn : entry))
}

/**
 * A turn ended on `serverId`, as this client saw it. The host writes its turn
 * commit in the background after the turn, so its count is not read yet: it now
 * has the newest turn, one more than any host this client knows. Its head stays
 * the last one read until a read gives the new one.
 */
export function afterTurnSettled(
  turns: readonly SessionHostTurn[],
  serverId: string,
): readonly SessionHostTurn[] {
  const newest = Math.max(0, ...turns.map((entry) => entry.syncedTurn))
  const known = turns.find((entry) => entry.serverId === serverId)
  return withSessionHostTurn(turns, { serverId, head: known?.head ?? null, syncedTurn: newest + 1 })
}

/**
 * The host that has the newest turn of a session: the most turns. A tie goes to
 * `preferServerId` (the run host), because its copy is as new and needs no
 * sync; then to the host this client heard from first. Null when no host
 * reported any turn.
 */
export function newestSessionHost(
  turns: readonly SessionHostTurn[],
  preferServerId?: string | null,
): SessionHostTurn | null {
  let newest: SessionHostTurn | null = null
  for (const entry of turns) {
    if (entry.syncedTurn <= 0) continue
    if (!newest || entry.syncedTurn > newest.syncedTurn) newest = entry
    else if (entry.syncedTurn === newest.syncedTurn && entry.serverId === preferServerId) newest = entry
  }
  return newest
}

/** Where `runServerId` must sync the session from before its next turn. */
export interface SessionSyncSource {
  /** The newest head this client knows. The run host syncs when its own head differs. */
  knownHead: string
  /** The host that has that head. */
  sourceServerId: string
}

/**
 * What a prompt or a prepare to `runServerId` carries (plan §7.1): the newest
 * head and the host that has it, or null when the run host has the newest
 * turn this client knows. Null sends no head, so the host starts the turn at
 * once (a head that is only stale would start a sync for nothing).
 */
export function sessionSyncSource(
  turns: readonly SessionHostTurn[],
  runServerId: string,
): SessionSyncSource | null {
  const newest = newestSessionHost(turns, runServerId)
  if (!newest || newest.serverId === runServerId || !newest.head) return null
  const run = turns.find((entry) => entry.serverId === runServerId)
  // A run host with the same head is current, though its count was read earlier.
  if (run?.head === newest.head) return null
  return { knownHead: newest.head, sourceServerId: newest.serverId }
}

/**
 * Which of the hosts that list one session shows it (plan §9): the host with
 * the higher `syncedTurn`. A host with no facts yet loses to one that has
 * them. With no difference, the row stays where it is (`currentServerId`), so
 * a list read does not move it; else the first host that listed it.
 */
export function listedSessionHost(
  candidateServerIds: readonly string[],
  turns: readonly SessionHostTurn[],
  currentServerId: string | null,
): string | null {
  if (candidateServerIds.length === 0) return null
  const countOf = (serverId: string) => turns.find((entry) => entry.serverId === serverId)?.syncedTurn ?? -1
  let chosen = currentServerId && candidateServerIds.includes(currentServerId) ? currentServerId : candidateServerIds[0]!
  for (const serverId of candidateServerIds) {
    if (countOf(serverId) > countOf(chosen)) chosen = serverId
  }
  return chosen
}
