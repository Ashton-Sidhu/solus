import type { SessionPrepareResult } from '@solus/contracts/rpc'
import type { PromptOptions, SessionMeta } from '@solus/contracts/types'
import {
  afterTurnSettled,
  newestSessionHost,
  sessionHostTurnOf,
  sessionSyncSource,
  withSessionHostTurn,
  type SessionHostTurn,
} from '@solus/client-core/session-heads'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

/**
 * Where a started session runs its next turn, on the phone
 * (docs/plans/portable-sessions.md §10). No host owns a session: this keeps
 * what each host holds of each session's repository (its head and turn count),
 * says what a prompt carries, and starts a sync on a host. The facts come from
 * reads that already happen and from turns this device saw end.
 */

/** What a prompt carries for the run host to sync before its turn (plan §7.1). */
export type SessionSyncFields = Pick<PromptOptions, 'knownHead' | 'sourceHostId'>

export interface SessionRunHostsDeps {
  /** The host's connection when it is ready now; null never dials and never waits. */
  readyConnection(hostId: string): HostConnection | null
}

const NO_TURNS: readonly SessionHostTurn[] = []

export class SessionRunHosts {
  readonly changes = new Listeners()
  private readonly turnsBySession = new Map<string, readonly SessionHostTurn[]>()
  /** `<hostId> <sessionId>` pairs asked for their facts once. */
  private readonly asked = new Set<string>()

  constructor(private readonly deps: SessionRunHostsDeps) {}

  /** What each host that answered holds of this session's repository. */
  turnsFor = (sessionId: string): readonly SessionHostTurn[] => this.turnsBySession.get(sessionId) ?? NO_TURNS

  /** The host that has the newest turn of a session; a tie goes to `preferHostId`. */
  newestHostOf(sessionId: string, preferHostId?: string | null): string | null {
    return newestSessionHost(this.turnsFor(sessionId), preferHostId)?.serverId ?? null
  }

  /** A host answered a session's info: keep its head and turn count. */
  noteMeta(hostId: string, meta: Pick<SessionMeta, 'sessionId' | 'head' | 'syncedTurn'> | null | undefined): void {
    const turn = sessionHostTurnOf(hostId, meta)
    if (!turn || !meta) return
    this.write(meta.sessionId, withSessionHostTurn(this.turnsFor(meta.sessionId), turn))
  }

  /** A turn of this session ended on `hostId`: that host has its newest turn now. */
  noteTurnSettled(hostId: string, sessionId: string): void {
    this.write(sessionId, afterTurnSettled(this.turnsFor(sessionId), hostId))
  }

  /** The newest head and the host that has it, when another host is ahead of
   *  `runHostId`; else nothing, so the host starts the turn at once. No request. */
  promptFields(sessionId: string, runHostId: string): SessionSyncFields {
    const source = sessionSyncSource(this.turnsFor(sessionId), runHostId)
    return source ? { knownHead: source.knownHead, sourceHostId: this.hostRef(source.sourceServerId) } : {}
  }

  /**
   * Reads the facts of sessions that this device sees on more than one host,
   * once for each host and session, in one batched read for each host. The
   * answers change `changes`, and the list draws each row again.
   */
  readOnce(hostId: string, sessionIds: readonly string[]): void {
    const missing = sessionIds.filter((sessionId) =>
      !this.asked.has(`${hostId} ${sessionId}`) && !this.turnsFor(sessionId).some((turn) => turn.serverId === hostId))
    if (missing.length === 0) return
    const connection = this.deps.readyConnection(hostId)
    if (!connection) return
    for (const sessionId of missing) this.asked.add(`${hostId} ${sessionId}`)
    void connection.api.getSessionInfos([...missing]).then(
      (metas) => { for (const meta of metas) this.noteMeta(hostId, meta) },
      () => undefined,
    )
  }

  /**
   * The conversation opened on `runHostId`: start a sync there when a host is
   * ahead (plan §10). `previousHostId` is the host the conversation was on
   * before a pick; it has the session when no fact says so yet. With neither,
   * nothing is asked.
   */
  opened(sessionId: string, runHostId: string, previousHostId: string | null): Promise<SessionPrepareResult | null> {
    if (!previousHostId && !sessionSyncSource(this.turnsFor(sessionId), runHostId)) return Promise.resolve(null)
    return this.prepare(sessionId, runHostId, previousHostId)
  }

  /**
   * Starts a sync of the session on `runHostId` when another host has a newer
   * turn. The newest host is read once first: its head changes with each turn,
   * and this device learns a new head only by a read. Answers `current` when
   * the facts say the run host has the newest turn, the host's answer when it
   * was asked, and null when nothing is known or the host cannot answer.
   */
  async prepare(sessionId: string, runHostId: string, previousHostId: string | null = null): Promise<SessionPrepareResult | null> {
    const newest = this.newestHostOf(sessionId, runHostId) ?? previousHostId
    if (newest && newest !== runHostId) {
      const answer = await this.deps.readyConnection(newest)?.api.getSessionInfos([sessionId]).catch(() => null)
      this.noteMeta(newest, answer?.[0])
    }
    const turns = this.turnsFor(sessionId)
    const source = sessionSyncSource(turns, runHostId)
    if (!source) {
      const run = turns.find((turn) => turn.serverId === runHostId)
      return run && this.newestHostOf(sessionId, runHostId) === runHostId ? { state: 'current', head: run.head } : null
    }
    const connection = this.deps.readyConnection(runHostId)
    if (!connection) return null
    // An older host has no prepare; the prompt still carries the head and syncs there.
    return connection.api.sessionPrepare({ sessionId, knownHead: source.knownHead, sourceHostId: this.hostRef(source.sourceServerId) })
      .catch(() => null)
  }

  forgetHost(hostId: string): void {
    for (const [sessionId, turns] of this.turnsBySession) {
      const kept = turns.filter((turn) => turn.serverId !== hostId)
      if (kept.length !== turns.length) this.turnsBySession.set(sessionId, kept)
    }
    for (const key of this.asked) if (key.startsWith(`${hostId} `)) this.asked.delete(key)
    this.changes.notify()
  }

  /**
   * The id a run host knows another host by: its installation id, which
   * `RemoteHosts.find` matches. A phone keeps a host under its installation id
   * already; the host's own answer wins when the phone has one.
   */
  private hostRef(hostId: string): string {
    return this.deps.readyConnection(hostId)?.facts.value('serverInfo')?.installationId ?? hostId
  }

  private write(sessionId: string, turns: readonly SessionHostTurn[]): void {
    if (turns === this.turnsFor(sessionId)) return
    this.turnsBySession.set(sessionId, turns)
    this.changes.notify()
  }
}
