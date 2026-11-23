import type { AgentExchangeStatus, WireNormalizedEvent } from "@solus/contracts/types";
import { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import { describe, expect, it } from "vite-plus/test";

import {
  startedSessionStateMark,
  stateMarkLabel,
  subagentStateMark,
  toolStateMark,
  type StartedSessionLive,
  type StateMark,
} from "./state-marks";

// The state marks of the mobile agent cards (docs/plans/session-state-marks.md):
// the same grammar and the same states as the thread rows and the desktop cards.

const dot = (mark: string, startedAt: number | null = 1000) => ({ kind: "dot", mark, startedAt });
const glyph = (name: string) => ({ kind: "glyph", glyph: name });

/** A parent transcript with one running provider sub-agent, fed the given child events. */
function subagentAfter(...events: WireNormalizedEvent[]) {
  const model = new TranscriptModel("parent");
  model.apply({ type: "tool_call", toolId: "agent", toolName: "Agent", index: 0, isSubagent: true });
  for (const event of events) model.apply({ ...event, parentToolUseId: "agent" } as WireNormalizedEvent);
  const item = [...model.items.values()].find((entry) => entry.kind === "tool");
  if (item?.kind !== "tool") throw new Error("no sub-agent card");
  return { model, tool: { ...item, timestamp: 1000 } };
}

const toolCall = (toolName: string, toolId = toolName): WireNormalizedEvent => ({
  type: "tool_call",
  toolName,
  toolId,
  index: 0,
});

describe("sub-agent card marks", () => {
  it("shows the dot mark of the step the sub-agent runs now, with its time", () => {
    const cases: Array<[WireNormalizedEvent[], string]> = [
      [[{ type: "thinking", state: "start" }], "thinking"],
      [[toolCall("Read")], "reading"],
      [[toolCall("Edit")], "editing"],
      [[toolCall("Bash")], "running"],
      [[toolCall("Grep")], "searching"],
      [[{ type: "text_chunk", text: "Found it" }], "writing"],
      [[toolCall("mcp__linear__search_issues")], "working"],
    ];
    for (const [events, mark] of cases) {
      expect(subagentStateMark(subagentAfter(...events).tool)).toEqual(dot(mark));
    }
  });

  it("follows the newest step only, and a question tool does not change it", () => {
    const { tool } = subagentAfter(
      toolCall("Read"),
      { type: "thinking", state: "start" },
      toolCall("Edit"),
      toolCall("AskUserQuestion"),
    );
    expect(subagentStateMark(tool)).toEqual(dot("editing"));
  });

  it("keeps the sub-agent's steps out of the parent's own activity", () => {
    // The parent's own step is its call of the sub-agent.
    const { model } = subagentAfter(toolCall("Bash"));
    expect(model.activity).toBe("other");
  });

  it("reads the newest running row when history gave no live activity", () => {
    const children = new TranscriptModel("child");
    children.apply(toolCall("Grep"));
    children.activity = null;
    const tool = { status: "running" as const, timestamp: 1000, children };
    expect(subagentStateMark(tool)).toEqual(dot("searching"));
  });

  it("uses the background progress of a sub-agent whose rows do not reach the client", () => {
    const model = new TranscriptModel("parent");
    model.apply({ type: "tool_call", toolId: "agent", toolName: "Agent", index: 0, isSubagent: true });
    model.apply({ type: "background_task_progress", taskId: "t1", toolUseId: "agent", lastToolName: "Write" });
    const item = [...model.items.values()].find((entry) => entry.kind === "tool");
    expect(item?.kind === "tool" && item.lastToolName).toBe("Write");
    expect(subagentStateMark({ status: "running", timestamp: 1000, lastToolName: "Write" })).toEqual(
      dot("editing"),
    );
  });

  it("falls back to Working when nothing is known", () => {
    expect(subagentStateMark({ status: "running", timestamp: 1000 })).toEqual(dot("working"));
    expect(subagentStateMark({ status: "running" })).toEqual(dot("working", null));
  });

  it("shows only the glyph once the sub-agent is done or failed", () => {
    expect(subagentStateMark({ status: "completed" })).toEqual(glyph("done"));
    expect(subagentStateMark({ status: "error" })).toEqual(glyph("failed"));
  });
});

describe("other tool card marks", () => {
  it("a command runs and an MCP call works; a finished call has no mark", () => {
    expect(toolStateMark({ toolName: "Bash", status: "running", timestamp: 1000 })).toEqual(dot("running"));
    expect(toolStateMark({ toolName: "mcp__solus__fake__long", status: "running", timestamp: 1000 })).toEqual(
      dot("working"),
    );
    expect(toolStateMark({ toolName: "Bash", status: "completed" })).toBeNull();
    expect(toolStateMark({ toolName: "Bash", status: "error" })).toEqual(glyph("failed"));
  });
});

describe("marks of a session another session started", () => {
  const quiet: StartedSessionLive = { activity: undefined, awaitingApproval: false };
  const markOf = (status: AgentExchangeStatus, live = quiet) => startedSessionStateMark(status, 1000, live);

  it("maps every exchange state to the desktop card's mark", () => {
    const expected: Record<AgentExchangeStatus, StateMark> = {
      dispatched: dot("starting", null) as StateMark,
      queued: dot("starting", null) as StateMark,
      running: dot("working") as StateMark,
      answered: dot("working") as StateMark,
      waiting_for_children: dot("delegating") as StateMark,
      awaiting_input: glyph("input") as StateMark,
      rate_limited: glyph("limited") as StateMark,
      failed: glyph("failed") as StateMark,
      lost: dot("offline", null) as StateMark,
      done: glyph("done") as StateMark,
      interrupted: glyph("done") as StateMark,
    };
    for (const [status, mark] of Object.entries(expected)) {
      expect(markOf(status as AgentExchangeStatus)).toEqual(mark);
    }
  });

  it("a replying session shows its own agent activity", () => {
    expect(markOf("running", { activity: "edit", awaitingApproval: false })).toEqual(dot("editing"));
    expect(markOf("answered", { activity: "reply", awaitingApproval: false })).toEqual(dot("writing"));
  });

  it("a session that waits on a permission shows Approval, not Input", () => {
    expect(markOf("awaiting_input", { activity: undefined, awaitingApproval: true })).toEqual(glyph("approval"));
  });
});

describe("spoken labels", () => {
  it("names each mark in words, also the glyphs that show no word", () => {
    expect(stateMarkLabel({ kind: "dot", mark: "delegating", startedAt: null })).toBe("Waiting on its agents");
    expect(stateMarkLabel({ kind: "glyph", glyph: "done" })).toBe("Done");
    expect(stateMarkLabel({ kind: "glyph", glyph: "failed" })).toBe("Failed");
  });
});
