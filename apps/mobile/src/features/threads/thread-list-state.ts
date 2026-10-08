import { SessionPullRequestReader } from '@solus/client-core/session-pull-request-reader';
import type { HostApi } from "@solus/client-core/host-api";
import type { HostEventSubscriber } from "@solus/client-core/host-event-subscriber";
import type { SessionPullRequestLink, SessionPullRequestWatchOutcome } from "@solus/contracts/session-pull-requests";
import type { SessionState } from "@solus/contracts/session-state";
import type { SessionStatus } from "@solus/contracts/types";

import { Listeners } from "../../lib/listeners";
import type { KeyValueStore } from "../../platform/ports";
import { threadKey } from "./thread-directory";
import type { ThreadListV2Facts } from "./threadListV2";

/**
 * What T3 Code's thread list shows beyond a session's record, read from each
 * host (docs/plans/session-pull-requests.md): where the session is in the
 * list (settled, snoozed), its live status, and its pull requests. The host
 * holds the state, so this keeps no settle or snooze of its own; it reads
 * after every change the host announces.
 */

/** The part of a host connection this store uses. */
export interface ThreadListConnection {
  readonly api: Pick<
    HostApi,
    | "sessionShelfList"
    | "sessionPullRequestsList"
    | "sessionPullRequestWatch"
    | "sessionSetSettled"
    | "sessionSnooze"
    | "setSessionTitle"
  >;
  readonly events: Pick<HostEventSubscriber, "subscribe">;
  onReset(listener: () => void): () => void;
}

/** Whether the Snoozed and Settled shelves show their rows; kept on this device. */
export interface ThreadListShelfExpansion {
  readonly snoozed: boolean;
  readonly settled: boolean;
}

const SHELF_EXPANSION_KEY = "solus.mobile.threadListShelves";

function readShelfExpansion(raw: string | null): ThreadListShelfExpansion {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (value && typeof value === "object" && "snoozed" in value && "settled" in value) {
      return { snoozed: value.snoozed === true, settled: value.settled === true };
    }
  } catch {
    // A damaged value falls back to the defaults below.
  }
  return { snoozed: false, settled: false };
}

const EMPTY_FACTS: ThreadListV2Facts = {
  shelf: new Map(),
  liveStatus: new Map(),
  pullRequests: new Map(),
};

export class ThreadListState {
  readonly changes = new Listeners();
  private readonly shelf = new Map<string, SessionState>();
  private readonly liveStatus = new Map<string, SessionStatus>();
  private readonly pullRequests = new Map<string, ReadonlyArray<SessionPullRequestLink>>();
  private readonly readers = new WeakMap<ThreadListConnection, SessionPullRequestReader>();
  private readonly watched = new WeakSet<ThreadListConnection>();
  /** A stable snapshot, replaced only when something changes. */
  private snapshot: ThreadListV2Facts = EMPTY_FACTS;
  private expansion: ThreadListShelfExpansion;

  constructor(
    private readonly connectionFor: (hostId: string) => ThreadListConnection | null,
    private readonly storage: KeyValueStore,
  ) {
    this.expansion = readShelfExpansion(storage.getItem(SHELF_EXPANSION_KEY));
  }

  facts = (): ThreadListV2Facts => this.snapshot;

  shelfExpansion = (): ThreadListShelfExpansion => this.expansion;

  toggleShelf(shelf: keyof ThreadListShelfExpansion): void {
    this.expansion = { ...this.expansion, [shelf]: !this.expansion[shelf] };
    this.storage.setItem(SHELF_EXPANSION_KEY, JSON.stringify(this.expansion));
    this.changes.notify();
  }

  /** Reads one host's settled and snoozed sessions and pull request links,
   *  and follows the host's announcements from then on. A host that fails the
   *  read keeps what it answered last time. */
  async load(hostId: string): Promise<void> {
    const connection = this.connectionFor(hostId);
    if (!connection) return;
    this.watch(hostId, connection);
    const [shelf, pullRequests] = await Promise.all([
      connection.api.sessionShelfList().catch(() => null),
      connection.api.sessionPullRequestsList().catch(() => null),
    ]);
    if (shelf) {
      this.dropHostEntries(this.shelf, hostId);
      for (const entry of shelf) this.shelf.set(threadKey(hostId, entry.sessionId), entry);
    }
    if (pullRequests) {
      this.dropHostEntries(this.pullRequests, hostId);
      for (const [sessionId, links] of Object.entries(pullRequests)) {
        this.pullRequests.set(threadKey(hostId, sessionId), links);
      }
    }
    if (shelf || pullRequests) this.publish();
  }

  /** Settle a session, or make a settled one active again. */
  async setSettled(hostId: string, sessionId: string, settled: boolean): Promise<void> {
    const connection = this.requireConnection(hostId);
    this.watch(hostId, connection);
    await connection.api.sessionSetSettled(sessionId, settled);
    await this.shelfChanges.get(threadKey(hostId, sessionId));
  }

  /** Snooze a session until a wake time; null wakes it now. */
  async snooze(hostId: string, sessionId: string, until: number | null): Promise<void> {
    const connection = this.requireConnection(hostId);
    this.watch(hostId, connection);
    await connection.api.sessionSnooze(sessionId, until);
    await this.shelfChanges.get(threadKey(hostId, sessionId));
  }

  /** Watch a session's pull request, or stop: its agent wakes on news
      (docs/plans/pr-watch.md). Answers what the host did. */
  async setWatching(
    hostId: string,
    sessionId: string,
    target: { readonly repository: string; readonly number: number },
    watching: boolean,
  ): Promise<SessionPullRequestWatchOutcome> {
    const connection = this.requireConnection(hostId);
    const outcome = await connection.api.sessionPullRequestWatch(sessionId, target.repository, target.number, watching);
    await this.refreshPullRequests(hostId, sessionId);
    return outcome;
  }

  /** Name a session; an empty name goes back to the derived title. */
  async rename(hostId: string, sessionId: string, title: string | null): Promise<void> {
    await this.requireConnection(hostId).api.setSessionTitle(sessionId, title, "manual");
  }

  forgetHost(hostId: string): void {
    this.dropHostEntries(this.shelf, hostId);
    this.dropHostEntries(this.pullRequests, hostId);
    this.dropHostEntries(this.liveStatus, hostId);
    this.publish();
  }

  private watch(hostId: string, connection: ThreadListConnection): void {
    if (this.watched.has(connection)) return;
    this.watched.add(connection);
    connection.events.subscribe("session.stateChanged", ({ sessionId }) => {
      const key = threadKey(hostId, sessionId);
      const read = this.refreshShelf(hostId, sessionId).catch(() => undefined).finally(() => {
        if (this.shelfChanges.get(key) === read) this.shelfChanges.delete(key);
      });
      this.shelfChanges.set(key, read);
    });
    connection.events.subscribe("session.pullRequestsChanged", ({ sessionId }) => {
      void this.refreshPullRequests(hostId, sessionId);
    });
    connection.events.subscribe("session.statusChanged", ({ sessionId, agentSessionId, status }) => {
      // A list may hold either id for the same session.
      this.liveStatus.set(threadKey(hostId, sessionId), status);
      if (agentSessionId) this.liveStatus.set(threadKey(hostId, agentSessionId), status);
      this.publish();
    });
    // A fresh server session forgets what was live; the records answer again.
    connection.onReset(() => {
      this.dropHostEntries(this.liveStatus, hostId);
      this.publish();
      void this.load(hostId);
    });
  }

  private readonly shelfChanges = new Map<string, Promise<void>>();

  private async refreshShelf(hostId: string, sessionId: string): Promise<void> {
    const connection = this.connectionFor(hostId);
    if (!connection) return;
    const answer = await connection.api.sessionShelfList([sessionId]);
    if (this.connectionFor(hostId) !== connection) return;
    // The host answers under the stable id, which the caller may not hold.
    if (answer.length === 0) this.shelf.delete(threadKey(hostId, sessionId));
    for (const entry of answer) this.shelf.set(threadKey(hostId, entry.sessionId), entry);
    this.publish();
  }

  private async refreshPullRequests(hostId: string, sessionId: string): Promise<void> {
    const connection = this.connectionFor(hostId);
    if (!connection) return;
    let reader = this.readers.get(connection);
    if (!reader) {
      reader = new SessionPullRequestReader(connection.api);
      this.readers.set(connection, reader);
    }
    const answer = await reader.read(sessionId).catch(() => null);
    if (!answer || this.connectionFor(hostId) !== connection) return;
    this.pullRequests.delete(threadKey(hostId, sessionId));
    for (const [id, links] of Object.entries(answer)) this.pullRequests.set(threadKey(hostId, id), links);
    this.publish();
  }

  private requireConnection(hostId: string): ThreadListConnection {
    const connection = this.connectionFor(hostId);
    if (!connection) throw new Error("This host cannot be reached now.");
    return connection;
  }

  private dropHostEntries(map: Map<string, unknown>, hostId: string): void {
    const prefix = threadKey(hostId, "");
    for (const key of Array.from(map.keys())) if (key.startsWith(prefix)) map.delete(key);
  }

  private publish(): void {
    this.snapshot = {
      shelf: new Map(this.shelf),
      liveStatus: new Map(this.liveStatus),
      pullRequests: new Map(this.pullRequests),
    };
    this.changes.notify();
  }
}
