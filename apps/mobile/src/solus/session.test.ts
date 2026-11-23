import { presentThreadLinkedPullRequests, resolveThreadPrBadgeAction } from "../state/thread-pr-presentation";
import { linkedPullRequestDestination } from "../lib/pullRequestNavigation";
import type { AttentionEntry } from "@solus/contracts/attention-types";
import { createNavigationThreads } from "./navigation-threads";
import { EMPTY_SESSION_VIEW } from "@solus/contracts/session-state";
import { createSessionListProjection } from "./session-list";
import { EnvironmentId } from "@t3tools/contracts";
import {
  buildThreadListV2Items,
  threadHasUnseenCompletion,
  resolveThreadListV2RowStatus,
  resolveThreadListV2WokeAt,
  resolveThreadListV2SwipeActions,
} from "../features/threads/threadListV2";
import { resolveThreadProviderInstance } from "../features/threads/thread-provider-instance";
import type { SessionStatus } from "@solus/contracts/types";
import { solusListHosts } from "./list-hosts";
import { modelLabel } from "@solus-mobile/features/conversation/lib/run-settings";
import { expect, it, vi } from "vite-plus/test";
import { HostEventSubscriber } from "@solus/client-core/host-event-subscriber";
import { ThreadListState, type ThreadListConnection } from "@solus-mobile/features/threads/thread-list-state";
import { threadKey } from "@solus-mobile/features/threads/thread-directory";
import { memoryKeyValueStore } from "@solus-mobile/platform/ports";
import { toThreadShell, type SessionRow } from "./session";

const session: SessionRow = {
  sessionId: "same-id",
  provider: "claude-code",
  projectPath: "/project",
  model: null,
  title: "Original",
  customTitle: "Release notes",
  createdAt: 1000,
  lastActivityAt: 2000,
  branch: "release",
  cwd: "/checkout",
  isWorktree: true,
  status: "running",
};

it("keeps the host and worktree when opening a renamed session", () => {
  expect(toThreadShell("remote", session, "accept-edits")).toMatchObject({
    environmentId: "remote",
    id: "same-id",
    title: "Release notes",
    projectId: "/project",
    branch: "release",
    worktreePath: "/checkout",
    runtimeMode: "auto-accept-edits",
    modelSelection: { instanceId: "claudeAgent", model: "auto" },
  });
});

it("uses the host model label or the Solus catalog name for the composer", () => {
  expect(modelLabel("claude-code", "claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelLabel("codex", "custom", { models: [{ id: "custom", label: "Team model" }] })).toBe(
    "Team model",
  );
});

it("uses the host session state for T3 swipe actions and shelves, including after reconnect", () => {
  const host = EnvironmentId.make("remote");
  const now = "2026-11-22T10:00:00Z";
  const until = Date.parse("2026-11-23T10:00:00Z");
  const hosts = solusListHosts([{ environmentId: host, connectionState: "connected" }]);
  const offline = solusListHosts([{ environmentId: host, connectionState: "connecting" }]);
  const view = { settledAt: null, snoozedUntil: null, snoozeNote: null, archivedAt: null };
  const list = (rowView: NonNullable<SessionRow["view"]>, capabilities = hosts) =>
    buildThreadListV2Items({
      threads: [toThreadShell(host, { ...session, status: "idle", view: rowView })],
      ...capabilities,
      now,
      searchQuery: "",
      environmentId: null,
      settledShelfExpanded: true,
      snoozedShelfExpanded: true,
    });
  expect(hosts.connectedEnvironmentIds.has(host)).toBe(true);
  expect(offline.connectedEnvironmentIds.has(host)).toBe(false);
  expect(
    resolveThreadListV2SwipeActions({
      variant: "card",
      settlementSupported: hosts.settlementEnvironmentIds.has(host),
      snoozeSupported: hosts.snoozeEnvironmentIds.has(host),
      snoozable: true,
    }),
  ).toEqual({ primary: "settle", secondary: "snooze" });
  expect(list({ ...view, settledAt: 2000 }, offline).settledCount).toBe(1);
  expect(list({ ...view, snoozedUntil: until }).snoozedCount).toBe(1);
  expect(list({ ...view, snoozedUntil: 2000 }).snoozedCount).toBe(0);
  expect(list({ ...view, archivedAt: 2000 }).items).toHaveLength(0);
  expect(list(view).items).toHaveLength(1);
});

it("keeps T3's session rows across host notifications and updates just the row that settled", () => {
  const project = createSessionListProjection();
  const rows = [
    { key: "one", hostId: "host", record: session },
    { key: "two", hostId: "host", record: { ...session, sessionId: "two" } },
  ];
  const facts = { views: new Map(), states: new Map() };
  const first = project(rows, facts);
  expect(project(rows, facts)).toBe(first);
  const checked = new Proxy(rows, { get(target, key, receiver) {
    if (key === "0") throw new Error("Read an unrelated row");
    return Reflect.get(target, key, receiver);
  } });
  const next = project(checked, {
    ...facts,
    views: new Map([["two", { ...EMPTY_SESSION_VIEW, settledAt: 4000 }]]),
  }, undefined, undefined, [1]);
  expect(next[0]).toBe(first[0]);
  expect(next[1]).not.toBe(first[1]);
  expect(next[1]?.settledOverride).toBe("settled");
});

it("updates the automation's sidebar name on its own host and keeps the session title for menus", () => {
  const project = createSessionListProjection();
  const record = {
    ...session,
    startedBy: { kind: "automation" as const, automationId: "sync", runId: "run" },
  };
  const rows = [
    { hostId: "home", key: "home-session", record },
    { hostId: "away", key: "away-session", record: { ...record } },
    { hostId: "home", key: "chat", record: { ...session, sessionId: "chat" } },
  ];
  const facts = { views: new Map(), states: new Map() };
  const before = project(rows, facts);
  expect(before[0]?.automationName).toBeNull();
  const names = new Map([["home", new Map([["sync", "Daily sync"]])]]);
  const after = project(rows, facts, names);
  expect(after[0]).toMatchObject({ automationName: "Daily sync", title: "Release notes" });
  expect(after[1]).toBe(before[1]);
  expect(after[2]).toBe(before[2]);
  const search = buildThreadListV2Items({
    threads: after,
    searchQuery: "Daily sync",
    environmentId: null,
    now: "2026-11-22T10:00:00Z",
    settledShelfExpanded: false,
    snoozedShelfExpanded: false,
  });
  expect(search.items.map(({ thread }) => thread.environmentId)).toEqual(["home"]);
  expect(project(rows, facts)[0]?.automationName).toBeNull();
});

it("uses the host project and provider on a session with an encoded storage folder", () => {
  const rows = [
    {
      key: "one",
      hostId: "mac",
      record: {
        ...session,
        projectPath: "-Users-me-project",
        projectRoot: "/Users/me/project",
      },
    },
  ];
  const [thread] = createSessionListProjection()(
    rows,
    { views: new Map(), states: new Map() },
    undefined,
    new Map([["mac", new Set(["/Users/me/project"])]]),
  );
  expect(thread!.projectId).toBe("/Users/me/project");
  expect(thread!.fallbackProject).toEqual({ title: "project", workspaceRoot: "/Users/me/project" });
  expect(resolveThreadProviderInstance(undefined, thread!)).toMatchObject({
    driverKind: "claudeAgent",
  });
});

it("updates the T3 status, timer and snooze gate when a host changes state", () => {
  const project = createSessionListProjection();
  const rows = [
    { key: "one", hostId: "mac", record: { ...session, hasPendingQuestion: true as const } },
  ];
  const facts = { views: new Map(), states: new Map() };
  const status = (liveStatus: SessionStatus) =>
    project(rows, {
      ...facts,
      liveStatus: new Map([["one", liveStatus]]),
      statusSince: new Map([["one", 3000]]),
    })[0]!;
  expect(resolveThreadListV2RowStatus(project(rows, facts)[0]!)).toBe("input");
  expect(status("running").runtime?.activityStartedAt).toBe(new Date(3000).toISOString());
  expect(resolveThreadListV2RowStatus(status("running"))).toBe("working");
  expect(status("awaiting_plan").hasPendingApprovals).toBe(true);
  expect(resolveThreadListV2RowStatus(status("awaiting_input"))).toBe("input");
  expect(resolveThreadListV2RowStatus(status("background"))).toBe("waiting");
  expect(resolveThreadListV2RowStatus(status("rate_limited"))).toBe("limited");
  expect(resolveThreadListV2RowStatus(status("failed"))).toBe("failed");
  expect(resolveThreadListV2RowStatus(status("completed"))).toBe("ready");
});

it("clears the wake badge only after a visit at or after the wake time", () => {
  const rows = [
    {
      key: "one",
      hostId: "mac",
      record: {
        ...session,
        status: "idle" as const,
        view: { ...EMPTY_SESSION_VIEW, snoozedUntil: 3000 },
      },
    },
  ];
  const project = createSessionListProjection();
  const wokeAt = (viewedAt: number) =>
    resolveThreadListV2WokeAt(
      project(rows, {
        views: new Map(),
        states: new Map(),
        viewedAt: new Map([["one", viewedAt]]),
      })[0]!,
      { now: new Date(5000).toISOString() },
    );
  expect(wokeAt(2000)).toBe(new Date(3000).toISOString());
  expect(wokeAt(4000)).toBeNull();
});

it("releases cached host rows together and removes revoked rows even during a hold", () => {
  const project = createNavigationThreads();
  const a = toThreadShell("a", session);
  const b = toThreadShell("b", session);
  const removed = toThreadShell("a", { ...session, sessionId: "revoked" });
  const updated = { ...a, title: "Confirmed by host" };
  const hosts = [a, b].map(({ environmentId }) => ({ environmentId, connectionState: "connected" }));
  const old = [a, removed, b];
  const fresh = [updated, b];
  expect(project(old, hosts, () => "loading", "person", 0).threads).toBe(old);
  const waiting = project(fresh, hosts, id => id === a.environmentId ? "loaded" : "loading", "person", 10);
  expect(waiting.holding).toBe(true);
  expect(waiting.threads).toEqual([a, b]);
  expect(project(fresh, hosts, () => "loaded", "person", 20).threads).toBe(fresh);
  const empty = project([], hosts, () => "loading", "another person", 30);
  expect(empty.threads).toEqual([]);
  expect(empty.holding).toBe(false);
});

it("restores Input and Done on connect and clears only the completion that was read", () => {
  const project = createSessionListProjection();
  const rows = [{ key: "one", hostId: "mac", record: { ...session, status: "idle" as const } }];
  const row = (kind: AttentionEntry["kind"], viewedAt?: number, live?: SessionStatus) =>
    project(rows, {
      views: new Map(), states: new Map(),
      attention: new Map([["one", { kind, sessionId: session.sessionId, since: 3000, summary: "" }]]),
      viewedAt: new Map([["one", viewedAt ?? null]]),
      liveStatus: live ? new Map([["one", live]]) : new Map(),
    })[0]!;
  expect(resolveThreadListV2RowStatus(row("question"))).toBe("input");
  expect(resolveThreadListV2RowStatus(row("needs_approval"))).toBe("approval");
  expect(threadHasUnseenCompletion(row("finished"))).toBe(true);
  expect(threadHasUnseenCompletion(row("finished", 2000))).toBe(true);
  expect(threadHasUnseenCompletion(row("finished", 4000))).toBe(false);
  const afterReconnect = project(
    [{ ...rows[0]!, record: { ...rows[0]!.record, view: { ...EMPTY_SESSION_VIEW, viewedAt: 4000 } } }],
    { views: new Map(), states: new Map(), attention: new Map([
      ["one", { kind: "finished", sessionId: session.sessionId, since: 3000, summary: "" }],
    ]) },
  )[0]!;
  expect(threadHasUnseenCompletion(afterReconnect)).toBe(false);
  expect(resolveThreadListV2RowStatus(row("finished", 4000, "running"))).toBe("working");
});

it("uses the record's Git badge on first load and replaces it when the host changes the links", () => {
  const project = createSessionListProjection();
  const url = "https://github.com/acme/app/pull/7";
  const link = { sessionId: session.sessionId, number: 7, repository: "github.com/acme/app",
    source: "manual" as const, linkedAt: 1000, url, title: "Release",
    snapshot: { number: 7, url, title: "Release", state: "merged" as const, draft: false,
      updatedAt: new Date(1000).toISOString(), baseRepo: { host: "github.com", owner: "acme", repo: "app" } } };
  const rows = [{ key: "one", hostId: "mac", record: { ...session, projectRoot: "/project", pullRequests: [link] } }];
  const facts = { views: new Map(), states: new Map() };
  const first = project(rows, facts)[0]!;
  const badge = presentThreadLinkedPullRequests(first.pullRequests)!;
  expect(badge).toMatchObject({ number: 7, state: "merged", label: "7" });
  expect(resolveThreadPrBadgeAction(badge).kind).toBe("open");
  expect(linkedPullRequestDestination(url, first)).toMatchObject({ environmentId: "mac", projectId: "/project", repository: "acme/app", number: 7 });
  const pending = {
    sessionId: session.sessionId, repository: link.repository, source: link.source, linkedAt: 2000,
    number: 8, url: "https://github.com/acme/app/pull/8", title: "Follow-up",
  };
  const multiple = project(rows, { ...facts, pullRequests: new Map([["one", [link, pending]]]) })[0]!;
  expect(resolveThreadPrBadgeAction(presentThreadLinkedPullRequests(multiple.pullRequests)!).kind).toBe("list");
  const removed = project(rows, { ...facts, pullRequests: new Map([["one", []]]) })[0]!;
  expect(presentThreadLinkedPullRequests(removed.pullRequests)).toBeNull();
});

function threadListHost(api: Partial<ThreadListConnection["api"]>) {
  const events = new HostEventSubscriber();
  const connection: ThreadListConnection = {
    api: {
      listAttention: vi.fn(), pinnedSessionsList: vi.fn(), togglePinnedSession: vi.fn(),
      sessionPullRequests: vi.fn(), sessionPullRequestPut: vi.fn(), sessionPullRequestDelete: vi.fn(),
      sessionPullRequestWatch: vi.fn(), sessionUpdate: vi.fn(), setSessionTitle: vi.fn(),
      setSessionReadState: vi.fn(), ...api,
    },
    events, onReset: () => () => {},
  };
  return { state: new ThreadListState(() => connection, memoryKeyValueStore()), events };
}

it("keeps the latest attention event when a host's initial read arrives late", async () => {
  const initial = Promise.withResolvers<AttentionEntry[]>();
  const { state, events } = threadListHost({ listAttention: () => initial.promise });
  state.follow("mac");
  const entry = { kind: "question", since: 2000, sessionId: "session", summary: "Choose" } as const;
  events.receive({ type: "attention.snapshotChanged", occurredAt: 2000, payload: { entries: [entry] } });
  initial.resolve([]);
  await initial.promise;
  expect(state.facts().attention?.get(threadKey("mac", "session"))).toEqual(entry);
  events.receive({ type: "attention.snapshotChanged", occurredAt: 3000, payload: { entries: [] } });
  expect(state.facts().attention?.size).toBe(0);
});

it("reads back the links after link, watch and unlink on the selected host", async () => {
  const url = "https://github.com/acme/app/pull/7";
  const target = { repository: "github.com/acme/app", number: 7 };
  const link = { ...target, sessionId: "session", url, source: "manual" as const, linkedAt: 1000, title: "Release" };
  const sessionPullRequestPut = vi.fn(async () => {});
  const sessionPullRequestDelete = vi.fn(async () => {});
  const sessionPullRequestWatch = vi.fn(async () => "started" as const);
  const sessionPullRequests = vi.fn<ThreadListConnection["api"]["sessionPullRequests"]>()
    .mockResolvedValueOnce([link])
    .mockResolvedValueOnce([{ ...link, watch: { startedAt: 2000 } }])
    .mockResolvedValueOnce([]);
  const { state } = threadListHost({
    sessionPullRequestPut, sessionPullRequestDelete, sessionPullRequestWatch, sessionPullRequests,
  });
  const links = () => state.facts().pullRequests.get(threadKey("mac", "session"));
  await state.linkPullRequest("mac", "session", url);
  expect(sessionPullRequestPut).toHaveBeenCalledWith("session", url);
  expect(links()).toEqual([link]);
  await state.setWatching("mac", "session", target, true);
  expect(sessionPullRequestWatch).toHaveBeenCalledWith("session", target.repository, 7, true);
  expect(links()?.[0]?.watch?.startedAt).toBe(2000);
  await state.unlinkPullRequest("mac", "session", target);
  expect(sessionPullRequestDelete).toHaveBeenCalledWith("session", target);
  expect(links()).toEqual([]);
});
