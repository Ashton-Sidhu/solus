import type { SessionMeta } from '@solus/contracts/types'
import type { SessionRepositoryFacts } from '@solus/contracts/session-repositories'

/**
 * What one host holds of one session's session repository
 * (docs/plans/portable-sessions.md §9): its local head and how many turns it
 * has. A session that ran on two hosts has one of these for each.
 */
export interface SessionHostTurn {
  serverId: string
  head: string | null
  syncedTurn: number
  /** The cloud refused this host's push: its turns are not in the session any
   *  more (docs/plans/portable-sessions-cloud.md answer 3.4). */
  pushRefused?: boolean
}

/** The session info property a host sets when the cloud refused its push. The
 *  contract does not declare it yet, so it is read as optional. */
type WithPushRefusal = { pushRefusedHead?: string | null }

/**
 * The facts one host answered for a session, or null when the host keeps no
 * session repository (an older host, or a Solus API, which reports no count).
 */
export function sessionHostTurnOf(
  serverId: string,
  meta: (Pick<SessionMeta, 'head' | 'syncedTurn'> & WithPushRefusal) | null | undefined,
): SessionHostTurn | null {
  if (!meta || meta.syncedTurn === undefined) return null
  const turn: SessionHostTurn = { serverId, head: meta.head ?? null, syncedTurn: meta.syncedTurn }
  if (meta.pushRefusedHead) turn.pushRefused = true
  return turn
}

/** The facts with one host's answer in place of its older one. Equal facts
 *  return the same array, so a reader that compares by reference sees no change. */
export function withSessionHostTurn(
  turns: readonly SessionHostTurn[],
  turn: SessionHostTurn,
): readonly SessionHostTurn[] {
  const index = turns.findIndex((entry) => entry.serverId === turn.serverId)
  const known = index === -1 ? undefined : turns[index]
  if (known && known.head === turn.head && known.syncedTurn === turn.syncedTurn && !!known.pushRefused === !!turn.pushRefused) return turns
  if (index === -1) return [...turns, turn]
  return turns.map((entry, position) => (position === index ? turn : entry))
}

/**
 * A turn ended on `serverId`, as this client saw it. The host writes its turn
 * commit in the background after the turn, so its count is not read yet: it now
 * has the newest turn, one more than any host this client knows, and one more
 * than the cloud (`cloudTurn`), because the host synced to the cloud head
 * before the turn. Its head stays the last one read until a read gives the
 * new one.
 */
export function afterTurnSettled(
  turns: readonly SessionHostTurn[],
  serverId: string,
  cloudTurn = 0,
): readonly SessionHostTurn[] {
  const newest = Math.max(0, cloudTurn, ...turns.map((entry) => entry.syncedTurn))
  const known = turns.find((entry) => entry.serverId === serverId)
  const settled: SessionHostTurn = { serverId, head: known?.head ?? null, syncedTurn: newest + 1 }
  if (known?.pushRefused) settled.pushRefused = true
  return withSessionHostTurn(turns, settled)
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

/**
 * What the cloud knows of one session (docs/plans/portable-sessions-cloud.md
 * §5.4), with the host that ran its last turn as this client names it. The
 * cloud names hosts by their account host id; `lastRunServerId` is the saved
 * server with that id, or null when this client keeps none.
 */
export interface SessionCloudHead extends SessionRepositoryFacts {
  lastRunServerId: string | null
}

/** Where a run host syncs a session from, with the cloud in the choice. */
export interface SessionSyncOrigin {
  /** The newest head of the session. The run host syncs when its own head differs. */
  knownHead: string
  /** The host that has that head, as this client names it; null when it keeps none. */
  sourceServerId: string | null
  /** The host that has that head, as the cloud names it. Set when the head is the cloud's. */
  sourceHostId: string | null
}

/** Whether the cloud has a newer turn than every host this client read. A tie
 *  goes to the hosts: their copy is as new and is read directly. */
function cloudIsNewest(turns: readonly SessionHostTurn[], cloud: SessionCloudHead | null | undefined): cloud is SessionCloudHead & { head: string } {
  if (!cloud?.head || cloud.syncedTurn <= 0) return false
  return cloud.syncedTurn > Math.max(0, ...turns.map((entry) => entry.syncedTurn))
}

/**
 * The source rule with the cloud (portable-sessions-cloud §5.4 item 5): the
 * newest head is the larger `syncedTurn` among the connected hosts and the
 * cloud. When it is the cloud's, the source is the host that ran the last
 * turn, though this client may not reach it: the run host fetches from the
 * cloud first. Null when the run host has that head already, so the prompt
 * starts its turn at once.
 */
export function sessionSyncOrigin(
  turns: readonly SessionHostTurn[],
  runServerId: string,
  cloud: SessionCloudHead | null | undefined,
): SessionSyncOrigin | null {
  if (cloudIsNewest(turns, cloud)) {
    const run = turns.find((entry) => entry.serverId === runServerId)
    if (run?.head === cloud.head || cloud.lastRunServerId === runServerId) return null
    return { knownHead: cloud.head, sourceServerId: cloud.lastRunServerId, sourceHostId: cloud.lastRunHostId }
  }
  const source = sessionSyncSource(turns, runServerId)
  return source ? { knownHead: source.knownHead, sourceServerId: source.sourceServerId, sourceHostId: null } : null
}

/**
 * The host that has the newest turn, with the cloud in the choice: the host
 * that ran the last turn when the cloud is newer than every host read, else
 * `newestSessionHost`. Null when that host is not one this client keeps.
 */
export function newestSessionServer(
  turns: readonly SessionHostTurn[],
  preferServerId: string | null | undefined,
  cloud: SessionCloudHead | null | undefined,
): string | null {
  if (cloudIsNewest(turns, cloud)) return cloud.lastRunServerId
  return newestSessionHost(turns, preferServerId)?.serverId ?? null
}
