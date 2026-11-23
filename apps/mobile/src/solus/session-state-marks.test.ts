import type { AgentActivity } from "@solus/contracts/agent-activity";
import type { SessionExecutionPhase } from "@solus/contracts/session-execution";
import type { SessionStatus } from "@solus/contracts/types";
import { DOT_MARK_FOR_ACTIVITY } from "@solus/client-core/dot-marks";
import { HostEventSubscriber } from "@solus/client-core/host-event-subscriber";
import { ThreadListState, type ThreadListConnection } from "@solus-mobile/features/threads/thread-list-state";
import { threadKey } from "@solus-mobile/features/threads/thread-directory";
import { memoryKeyValueStore } from "@solus-mobile/platform/ports";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  dotMarkShowsElapsedTime,
  resolveThreadListV2DotMark,
  resolveThreadListV2RowStatus,
} from "../features/threads/threadListV2";
import type { SessionRow } from "./session";
import { createSessionListProjection } from "./session-list";

// The state marks of the mobile thread rows (docs/plans/session-state-marks.md).

const session: SessionRow = {
  sessionId: "s1",
  provider: "claude-code",
  projectPath: "/project",
  model: null,
  title: "Fix login",
  customTitle: null,
  createdAt: 1000,
  lastActivityAt: 2000,
  branch: null,
  cwd: "/project",
  isWorktree: false,
  status: "running",
};

function threadListHost() {
  const events = new HostEventSubscriber();
  const connection: ThreadListConnection = {
    api: {
      listAttention: async () => [], pinnedSessionsList: vi.fn(), togglePinnedSession: vi.fn(),
      sessionPullRequests: vi.fn(), sessionPullRequestPut: vi.fn(), sessionPullRequestDelete: vi.fn(),
      sessionPullRequestWatch: vi.fn(), sessionUpdate: vi.fn(), setSessionTitle: vi.fn(),
      setSessionReadState: vi.fn(),
    },
    events,
    onReset: () => () => {},
  };
  const state = new ThreadListState(() => connection, memoryKeyValueStore());
  state.follow("mac");
  let at = 3000;
  const status = (value: SessionExecutionPhase | "completed", awaitingApproval?: true) => {
    at++;
    events.receive({
      type: "session.executionChanged",
      occurredAt: at,
      payload: { sessionId: "s1", execution: {
        revision: at, awaitingApproval,
        current: value === "completed" ? null : { runId: "run", phase: value, startedAt: at },
        lastTurn: value === "completed" ? { runId: "run", outcome: "completed", startedAt: 3000, endedAt: at } : null,
      } },
    });
  };
  const activity = (value: AgentActivity | null) =>
    events.receive({ type: "session.activityChanged", occurredAt: ++at, payload: { sessionId: "s1", activity: value, at } });
  return { state, status, activity };
}

describe("thread list agent activity", () => {
  const key = threadKey("mac", "s1");

  it("keeps the activity of a running turn on its Solus session and clears it with null", () => {
    const { state, status, activity } = threadListHost();
    status("running");
    activity("read");
    expect(state.facts().agentActivity?.get(key)).toBe("read");
    activity(null);
    expect(state.facts().agentActivity?.has(key)).toBe(false);
  });

  it("clears the activity when the status leaves running, and ignores one sent as the turn ended", () => {
    const { state, status, activity } = threadListHost();
    status("running");
    activity("edit");
    status("completed");
    expect(state.facts().agentActivity?.has(key)).toBe(false);
    activity("run");
    expect(state.facts().agentActivity?.has(key)).toBe(false);
  });

  it("takes an activity after a reconnect before any live status arrives", () => {
    const { state, activity } = threadListHost();
    activity("search");
    expect(state.facts().agentActivity?.get(key)).toBe("search");
  });

  it("tells a waiting permission from a question, also when only that fact changes", () => {
    const { state, status } = threadListHost();
    status("awaiting_input", true);
    expect(state.facts().awaitingApprovals?.has(key)).toBe(true);
    status("awaiting_input");
    expect(state.facts().awaitingApprovals?.has(key)).toBe(false);
  });
});

describe("thread row state marks", () => {
  const project = createSessionListProjection();
  const rowOf = (input: {
    live?: SessionStatus;
    activity?: AgentActivity;
    approval?: boolean;
    away?: boolean;
    record?: Partial<SessionRow>;
  }) => {
    const thread = project(
      [{ key: "one", hostId: "mac", record: { ...session, ...input.record } }],
      {
        views: new Map(),
        states: new Map(),
        liveStatus: new Map(input.live ? [["one", input.live]] : []),
        awaitingApprovals: new Set(input.approval ? ["one"] : []),
        agentActivity: new Map(input.activity ? [["one", input.activity]] : []),
        viewedAt: new Map([["one", null]]),
      },
      undefined,
      undefined,
      undefined,
      new Set(input.away ? ["mac"] : []),
    )[0]!;
    const status = resolveThreadListV2RowStatus(thread);
    return { status, mark: resolveThreadListV2DotMark(thread, status) };
  };

  it("shows Starting while the session connects, and Working for a turn with no known activity", () => {
    expect(rowOf({ live: "connecting" })).toEqual({ status: "working", mark: "starting" });
    expect(rowOf({ live: "running" })).toEqual({ status: "working", mark: "working" });
    // A record that says running, read after a reconnect, has no activity yet.
    expect(rowOf({})).toEqual({ status: "working", mark: "working" });
  });

  it("spells each agent activity of a running turn", () => {
    for (const activity of Object.keys(DOT_MARK_FOR_ACTIVITY) as AgentActivity[]) {
      expect(rowOf({ live: "running", activity })).toEqual({ status: "working", mark: DOT_MARK_FOR_ACTIVITY[activity] });
    }
    expect(rowOf({ live: "running", activity: "read" }).mark).toBe("reading");
    expect(rowOf({ live: "running", activity: "think" }).mark).toBe("thinking");
  });

  it("shows Background for a session with background work", () => {
    expect(rowOf({ live: "background" })).toEqual({ status: "waiting", mark: "background" });
  });

  it("shows Approval for a waiting permission and Input for a question, with line glyphs", () => {
    expect(rowOf({ live: "awaiting_input", approval: true })).toEqual({ status: "approval", mark: null });
    expect(rowOf({ live: "awaiting_input" })).toEqual({ status: "input", mark: null });
    expect(rowOf({ live: "awaiting_plan" })).toEqual({ status: "approval", mark: null });
  });

  it("keeps line glyphs for Limited, Failed, and Done", () => {
    expect(rowOf({ live: "rate_limited" })).toEqual({ status: "limited", mark: null });
    expect(rowOf({ live: "failed" })).toEqual({ status: "failed", mark: null });
    expect(rowOf({ live: "completed", record: { status: "idle" } })).toEqual({ status: "ready", mark: null });
  });

  it("shows Offline for live work on an away host, but keeps a state that waits on the person", () => {
    expect(rowOf({ live: "running", activity: "edit", away: true })).toEqual({ status: "working", mark: "offline" });
    expect(rowOf({ live: "background", away: true })).toEqual({ status: "waiting", mark: "offline" });
    expect(rowOf({ live: "awaiting_input", away: true })).toEqual({ status: "input", mark: null });
  });

  it("keeps the elapsed time only beside the marks of a running turn", () => {
    expect(dotMarkShowsElapsedTime("reading")).toBe(true);
    expect(dotMarkShowsElapsedTime("working")).toBe(true);
    expect(dotMarkShowsElapsedTime("starting")).toBe(false);
    expect(dotMarkShowsElapsedTime("background")).toBe(false);
    expect(dotMarkShowsElapsedTime("offline")).toBe(false);
  });
});
