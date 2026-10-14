import type { HostApi } from "@solus/client-core/host-api";
import type { HostEventSubscriber } from "@solus/client-core/host-event-subscriber";
import type { SessionPullRequestLink, SessionPullRequestWatchOutcome } from "@solus/contracts/session-pull-requests";
import type { SessionState, SessionView } from "@solus/contracts/session-state";
import type { SessionStatus } from "@solus/contracts/types";

import { Listeners } from "../../lib/listeners";
import type { KeyValueStore } from "../../platform/ports";
import { threadKey } from "./thread-directory";
import type { ThreadListV2Facts } from "./threadListV2";

/**
 * What T3 Code's thread list shows beyond a session's record, from each host:
 * its live status, and what changed after the record was read. The record
 * carries its shared state, this person's own view, and its pull requests
 * (docs/plans/session-archive.md). A settle arrives with the new shared state,
 * an archive or snooze with this person's new view, and both are written here
 * with nothing read back. A pull request change is read again for that one
 * session.
 *
 * A session's home keeps its state, view, and links. On mobile the home is
 * the host connection the session came from: this app does not connect to an
 * organization's Solus API.
 */

/** The part of a host connection this store uses. */
export interface ThreadListConnection {
  readonly api: Pick<
    HostApi,
    | "sessionPullRequests"
    | "sessionPullRequestWatch"
    | "sessionUpdate"
    | "setSessionTitle"
    | "setSessionReadState"
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
  states: new Map(),
  views: new Map(),
  liveStatus: new Map(),
  pullRequests: new Map(),
};

export class ThreadListState {
  readonly changes = new Listeners();
  private readonly states = new Map<string, SessionState>();
  private readonly views = new Map<string, SessionView>();
  private readonly liveStatus = new Map<string, SessionStatus>();
  private readonly unread = new Map<string, boolean>();
  private readonly pullRequests = new Map<string, ReadonlyArray<SessionPullRequestLink>>();
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

  /** Follows one host's announcements: the records read before them stay
   *  current. */
  follow(hostId: string): void {
    const connection = this.connectionFor(hostId);
    if (connection) this.watch(hostId, connection);
  }

  /** Settle a session for everyone, or make a settled one active again. */
  async setSettled(hostId: string, sessionId: string, settled: boolean): Promise<void> {
    const connection = this.requireConnection(hostId);
    this.watch(hostId, connection);
    this.write(this.states, hostId, connection, sessionId, (await connection.api.sessionUpdate(sessionId, { settled })).state);
  }

  /** Snooze a session in this person's list until a wake time; null wakes it now. */
  async snooze(hostId: string, sessionId: string, until: number | null): Promise<void> {
    const connection = this.requireConnection(hostId);
    this.watch(hostId, connection);
    this.write(this.views, hostId, connection, sessionId, (await connection.api.sessionUpdate(sessionId, { snoozedUntil: until })).view);
  }

  /** Take a session out of this person's list, or return it. Archive keeps
   *  the settle and the snooze, so it returns to the shelf it left. */
  async setArchived(hostId: string, sessionId: string, archived: boolean): Promise<void> {
    const connection = this.requireConnection(hostId);
    this.watch(hostId, connection);
    this.write(this.views, hostId, connection, sessionId, (await connection.api.sessionUpdate(sessionId, { archived })).view);
  }

  /** A read boundary belongs to one session on one host. Watch before writing
   *  so changes from other clients update the same list. */
  async markRead(hostId: string, sessionId: string, read: boolean): Promise<void> {
    const connection = this.requireConnection(hostId);
    this.watch(hostId, connection);
    await connection.api.setSessionReadState(sessionId, read ? Date.now() : null);
    if (this.connectionFor(hostId) !== connection) return;
    this.unread.set(threadKey(hostId, sessionId), !read);
    this.publish();
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
    this.dropHostEntries(this.states, hostId);
    this.dropHostEntries(this.views, hostId);
    this.dropHostEntries(this.pullRequests, hostId);
    this.dropHostEntries(this.liveStatus, hostId);
    this.dropHostEntries(this.unread, hostId);
    this.publish();
  }

  private watch(hostId: string, connection: ThreadListConnection): void {
    if (this.watched.has(connection)) return;
    this.watched.add(connection);
    connection.events.subscribe("session.readStateChanged", ({ sessionId, viewedAt }) => {
      this.unread.set(threadKey(hostId, sessionId), viewedAt === null);
      this.publish();
    });
    connection.events.subscribe("session.stateChanged", ({ sessionId, state }) => {
      this.write(this.states, hostId, connection, sessionId, state);
    });
    // Only this person's connections hear their own view change.
    connection.events.subscribe("session.viewChanged", ({ sessionId, view }) => {
      this.write(this.views, hostId, connection, sessionId, view);
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
    // A fresh server session forgets what was live, and a change may have
    // been missed; the records read again answer it.
    connection.onReset(() => {
      this.dropHostEntries(this.liveStatus, hostId);
      this.dropHostEntries(this.states, hostId);
      this.dropHostEntries(this.views, hostId);
      this.dropHostEntries(this.pullRequests, hostId);
      this.publish();
    });
  }

  /** A state or view the host announced or answered overrides the record
   *  read before it. An empty one is kept too, so it overrides a stale
   *  record. A host that does not keep the session answers null. */
  private write<Value>(
    into: Map<string, Value>,
    hostId: string,
    connection: ThreadListConnection,
    sessionId: string,
    value: Value | null,
  ): void {
    if (!value || this.connectionFor(hostId) !== connection) return;
    into.set(threadKey(hostId, sessionId), value);
    this.publish();
  }

  /** One session's links changed: they are read again for that session. A
   *  host that fails the read keeps the links shown. */
  private async refreshPullRequests(hostId: string, sessionId: string): Promise<void> {
    const connection = this.connectionFor(hostId);
    if (!connection) return;
    const links = await connection.api.sessionPullRequests(sessionId).catch(() => null);
    if (!links || this.connectionFor(hostId) !== connection) return;
    this.pullRequests.set(threadKey(hostId, sessionId), links);
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
      states: new Map(this.states),
      views: new Map(this.views),
      liveStatus: new Map(this.liveStatus),
      unread: new Map(this.unread),
      pullRequests: new Map(this.pullRequests),
    };
    this.changes.notify();
  }
}
