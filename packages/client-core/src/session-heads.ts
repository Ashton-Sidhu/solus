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

/**
 * The facts one host answered for a session, or null when the host keeps no
 * session repository (an older host, or a Solus API, which reports no count).
 */
export function sessionHostTurnOf(
  serverId: string,
  meta: Pick<SessionMeta, 'head' | 'syncedTurn' | 'pushRefused'> | null | undefined,
): SessionHostTurn | null {
  if (!meta || meta.syncedTurn === undefined) return null
  const turn: SessionHostTurn = { serverId, head: meta.head ?? null, syncedTurn: meta.syncedTurn }
  if (meta.pushRefused) turn.pushRefused = true
  return turn
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

/** Where `runServerId` must sync the session from before its next turn. */
export interface SessionSyncSource {
  /** The newest head this client knows. The run host syncs when its own head differs. */
  knownHead: string
  /** The host that has that head. */
  sourceServerId: string
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

/**
 * What every host that answered holds of one session's repository. A value:
 * a change gives a new one, and equal facts give the same one, so a reader
 * that compares by reference sees no change.
 */
export class SessionHostTurns {
  /** No host answered. */
  static readonly none = new SessionHostTurns([])

  constructor(readonly entries: readonly SessionHostTurn[]) {}

  /** What `serverId` holds, when it answered. */
  of(serverId: string): SessionHostTurn | undefined {
    return this.entries.find((entry) => entry.serverId === serverId)
  }

  /** The most turns that one host holds; 0 when no host reported a turn. */
  get newestTurn(): number {
    return Math.max(0, ...this.entries.map((entry) => entry.syncedTurn))
  }

  /** The facts with one host's answer in place of its older one. */
  with(turn: SessionHostTurn): SessionHostTurns {
    const index = this.entries.findIndex((entry) => entry.serverId === turn.serverId)
    const known = index === -1 ? undefined : this.entries[index]
    if (known && known.head === turn.head && known.syncedTurn === turn.syncedTurn && !!known.pushRefused === !!turn.pushRefused) return this
    if (index === -1) return new SessionHostTurns([...this.entries, turn])
    return new SessionHostTurns(this.entries.map((entry, position) => (position === index ? turn : entry)))
  }

  /** The facts with nothing from `serverId`: this client keeps that host no more. */
  without(serverId: string): SessionHostTurns {
    const kept = this.entries.filter((entry) => entry.serverId !== serverId)
    return kept.length === this.entries.length ? this : new SessionHostTurns(kept)
  }

  /**
   * A turn ended on `serverId`, as this client saw it. The host writes its turn
   * commit in the background after the turn, so its count is not read yet: it now
   * has the newest turn, one more than any host this client knows, and one more
   * than the cloud (`cloudTurn`), because the host synced to the cloud head
   * before the turn. Its head stays the last one read until a read gives the
   * new one.
   */
  afterTurnSettled(serverId: string, cloudTurn = 0): SessionHostTurns {
    const known = this.of(serverId)
    const settled: SessionHostTurn = { serverId, head: known?.head ?? null, syncedTurn: Math.max(cloudTurn, this.newestTurn) + 1 }
    if (known?.pushRefused) settled.pushRefused = true
    return this.with(settled)
  }

  /**
   * The host that has the newest turn of the session: the most turns. A tie goes
   * to `preferServerId` (the run host), because its copy is as new and needs no
   * sync; then to the host this client heard from first. Null when no host
   * reported any turn.
   */
  newestHost(preferServerId?: string | null): SessionHostTurn | null {
    let newest: SessionHostTurn | null = null
    for (const entry of this.entries) {
      if (entry.syncedTurn <= 0) continue
      if (!newest || entry.syncedTurn > newest.syncedTurn) newest = entry
      else if (entry.syncedTurn === newest.syncedTurn && entry.serverId === preferServerId) newest = entry
    }
    return newest
  }

  /**
   * What a prompt or a prepare to `runServerId` carries (plan §7.1): the newest
   * head and the host that has it, or null when the run host has the newest
   * turn this client knows. Null sends no head, so the host starts the turn at
   * once (a head that is only stale would start a sync for nothing).
   */
  syncSource(runServerId: string): SessionSyncSource | null {
    const newest = this.newestHost(runServerId)
    if (!newest || newest.serverId === runServerId || !newest.head) return null
    // A run host with the same head is current, though its count was read earlier.
    if (this.of(runServerId)?.head === newest.head) return null
    return { knownHead: newest.head, sourceServerId: newest.serverId }
  }

  /**
   * Which of the hosts that list the session shows it (plan §9): the host with
   * the higher `syncedTurn`. A host with no facts yet loses to one that has
   * them. With no difference, the row stays where it is (`currentServerId`), so
   * a list read does not move it; else the first host that listed it.
   */
  listedHost(candidateServerIds: readonly string[], currentServerId: string | null): string | null {
    if (candidateServerIds.length === 0) return null
    const countOf = (serverId: string) => this.of(serverId)?.syncedTurn ?? -1
    let chosen = currentServerId && candidateServerIds.includes(currentServerId) ? currentServerId : candidateServerIds[0]!
    for (const serverId of candidateServerIds) {
      if (countOf(serverId) > countOf(chosen)) chosen = serverId
    }
    return chosen
  }

  /** Whether the cloud has a newer turn than every host this client read. A tie
   *  goes to the hosts: their copy is as new and is read directly. */
  private isBehind(cloud: SessionCloudHead | null | undefined): cloud is SessionCloudHead & { head: string } {
    return !!cloud?.head && cloud.syncedTurn > 0 && cloud.syncedTurn > this.newestTurn
  }

  /**
   * The source rule with the cloud (portable-sessions-cloud §5.4 item 5): the
   * newest head is the larger `syncedTurn` among the connected hosts and the
   * cloud. When it is the cloud's, the source is the host that ran the last
   * turn, though this client may not reach it: the run host fetches from the
   * cloud first. Null when the run host has that head already, so the prompt
   * starts its turn at once.
   */
  syncOrigin(runServerId: string, cloud: SessionCloudHead | null | undefined): SessionSyncOrigin | null {
    if (this.isBehind(cloud)) {
      if (this.of(runServerId)?.head === cloud.head || cloud.lastRunServerId === runServerId) return null
      return { knownHead: cloud.head, sourceServerId: cloud.lastRunServerId, sourceHostId: cloud.lastRunHostId }
    }
    const source = this.syncSource(runServerId)
    return source ? { knownHead: source.knownHead, sourceServerId: source.sourceServerId, sourceHostId: null } : null
  }

  /**
   * The host that has the newest turn, with the cloud in the choice: the host
   * that ran the last turn when the cloud is newer than every host read, else
   * `newestHost`. Null when that host is not one this client keeps.
   */
  newestServer(preferServerId: string | null | undefined, cloud: SessionCloudHead | null | undefined): string | null {
    if (this.isBehind(cloud)) return cloud.lastRunServerId
    return this.newestHost(preferServerId)?.serverId ?? null
  }
}

/** The host turns of each session this client has heard about. The caller owns
 * the map so its UI can observe each changed session in its own way. */
export class SessionHostTurnsBook {
  constructor(private readonly turnsBySession: Map<string, SessionHostTurns>) {}

  forSession(sessionId: string): SessionHostTurns {
    return this.turnsBySession.get(sessionId) ?? SessionHostTurns.none
  }

  noteMeta(serverId: string, meta: Pick<SessionMeta, 'sessionId' | 'head' | 'syncedTurn' | 'pushRefused'> | null | undefined): boolean {
    const turn = sessionHostTurnOf(serverId, meta)
    return turn && meta ? this.write(meta.sessionId, this.forSession(meta.sessionId).with(turn)) : false
  }

  noteTurnSettled(serverId: string, sessionId: string, cloudTurn = 0): boolean {
    return this.write(sessionId, this.forSession(sessionId).afterTurnSettled(serverId, cloudTurn))
  }

  notePushRefused(serverId: string, sessionId: string, isRefused: boolean): boolean {
    const turns = this.forSession(sessionId)
    const known = turns.of(serverId)
    if (!!known?.pushRefused === isRefused) return false
    const turn: SessionHostTurn = { serverId, head: known?.head ?? null, syncedTurn: known?.syncedTurn ?? 0 }
    if (isRefused) turn.pushRefused = true
    return this.write(sessionId, turns.with(turn))
  }

  forgetHost(serverId: string): boolean {
    let changed = false
    for (const [sessionId, turns] of this.turnsBySession) {
      changed = this.write(sessionId, turns.without(serverId)) || changed
    }
    return changed
  }

  private write(sessionId: string, turns: SessionHostTurns): boolean {
    if (turns === this.forSession(sessionId)) return false
    this.turnsBySession.set(sessionId, turns)
    return true
  }
}
