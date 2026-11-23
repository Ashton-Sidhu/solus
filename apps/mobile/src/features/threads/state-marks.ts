import { agentActivityOfTool, type AgentActivity } from "@solus/contracts/agent-activity";
import type { AgentExchangeStatus } from "@solus/contracts/types";
import { DOT_MARK_FOR_ACTIVITY, type DotMarkName } from "@solus/client-core/dot-marks";
import type { ToolItem } from "@solus-mobile/features/conversation/lib/tool-item";
import { msg } from "gt-react-native";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { m, type MessageResolver } from "../../i18n/messages";

/**
 * The state marks of mobile (docs/plans/session-state-marks.md): dots move
 * while an agent works, and a still line glyph shows when a person must act
 * or the work is done. Input, Approval, and Limited add a word; Failed and
 * Done show the glyph only. The thread rows and the agent cards read these
 * tables, so every surface says the same thing.
 */

export interface StateGlyph {
  readonly label: string;
  // Failed and Done show only the glyph; their label is still spoken.
  readonly glyphOnly?: true;
  readonly icon: AppSymbolName;
  readonly className: string;
  readonly iconTintClassName: string;
}

export const STATE_GLYPHS = {
  approval: {
    label: msg("Approval", { $context: "thread status, waiting for approval" }),
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: msg("Input", { $context: "thread status, waiting for user input" }),
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  limited: {
    label: msg("Limited", { $context: "thread status, usage limit reached" }),
    icon: "clock",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  failed: {
    label: msg("Failed", { $context: "thread status" }),
    glyphOnly: true,
    icon: "xmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  done: {
    label: msg("Done", { $context: "thread status, turn finished" }),
    glyphOnly: true,
    icon: "checkmark.circle",
    className: "text-adaptive-emerald-700-300",
    iconTintClassName: "accent-adaptive-emerald-700-300",
  },
} as const satisfies Record<string, StateGlyph>;

export type StateGlyphName = keyof typeof STATE_GLYPHS;

// What a dot mark says to VoiceOver and TalkBack.
export const DOT_MARK_LABEL = {
  starting: msg("Starting", { $context: "thread status, the agent starts" }),
  thinking: msg("Thinking", { $context: "thread status" }),
  reading: msg("Reading files", { $context: "thread status" }),
  editing: msg("Editing files", { $context: "thread status" }),
  running: msg("Running a command", { $context: "thread status" }),
  searching: msg("Searching", { $context: "thread status" }),
  writing: msg("Writing a reply", { $context: "thread status" }),
  working: msg("Working", { $context: "thread status" }),
  background: msg("Background work running", { $context: "thread status" }),
  offline: msg("Host offline", { $context: "thread status, the host cannot be reached" }),
  delegating: msg("Waiting on its agents", {
    $context: "thread status, the agent waits on the agents it started",
  }),
} satisfies Record<DotMarkName, string>;

/** One state mark: a dot mark with the time its work started, or a line glyph. */
export type StateMark =
  | { readonly kind: "dot"; readonly mark: DotMarkName; readonly startedAt: number | null }
  | { readonly kind: "glyph"; readonly glyph: StateGlyphName };

const glyph = (name: StateGlyphName): StateMark => ({ kind: "glyph", glyph: name });

/** The word a mark says to VoiceOver and TalkBack; the card puts it in its sentence. */
export function stateMarkLabel(mark: StateMark, resolve: MessageResolver = m): string {
  return resolve(mark.kind === "dot" ? DOT_MARK_LABEL[mark.mark] : STATE_GLYPHS[mark.glyph].label);
}

type SubagentTool = Pick<ToolItem, "status" | "timestamp" | "children" | "lastToolName">;

/**
 * What a provider sub-agent does now. Its own transcript keeps the live
 * activity. A history page carries none, so the newest row tells what runs.
 * A background sub-agent whose rows do not reach the client reports only its
 * last tool. Only the newest step is read, never the whole transcript.
 */
function subagentActivity(tool: SubagentTool): AgentActivity {
  const children = tool.children;
  if (children) {
    if (children.activity) return children.activity;
    const newestId = children.order.at(-1);
    const newest = newestId === undefined ? undefined : children.items.get(newestId);
    if (newest?.kind === "tool" && newest.status === "running") {
      return agentActivityOfTool(newest.toolName) ?? "other";
    }
    return "other";
  }
  return (tool.lastToolName && agentActivityOfTool(tool.lastToolName)) || "other";
}

/** The mark of a provider sub-agent's card. */
export function subagentStateMark(tool: SubagentTool): StateMark {
  if (tool.status === "completed") return glyph("done");
  if (tool.status === "error") return glyph("failed");
  return {
    kind: "dot",
    mark: DOT_MARK_FOR_ACTIVITY[subagentActivity(tool)],
    startedAt: tool.timestamp ?? null,
  };
}

/** The mark of any other tool card: its own kind while it runs (a command
 *  runs, an MCP call works), Failed when it failed, and none once it is done. */
export function toolStateMark(tool: Pick<ToolItem, "toolName" | "status" | "timestamp">): StateMark | null {
  if (tool.status === "error") return glyph("failed");
  if (tool.status === "completed") return null;
  return {
    kind: "dot",
    mark: DOT_MARK_FOR_ACTIVITY[agentActivityOfTool(tool.toolName) ?? "other"],
    startedAt: tool.timestamp ?? null,
  };
}

/** What this client knows live about the session an agent card stands for. */
export interface StartedSessionLive {
  /** From `session.activityChanged`, while its turn runs. */
  readonly activity: AgentActivity | undefined;
  /** The input that waits is a permission request, not a question. */
  readonly awaitingApproval: boolean;
}

/**
 * The mark of a card for a session that this session started: the same
 * states as the desktop card. An interrupted exchange reads as replied.
 */
export function startedSessionStateMark(
  status: AgentExchangeStatus,
  startedAt: number,
  live: StartedSessionLive,
): StateMark {
  switch (status) {
    case "dispatched":
    case "queued":
      return { kind: "dot", mark: "starting", startedAt: null };
    case "running":
    case "answered":
      return {
        kind: "dot",
        mark: DOT_MARK_FOR_ACTIVITY[live.activity ?? "other"],
        startedAt,
      };
    case "waiting_for_children":
      return { kind: "dot", mark: "delegating", startedAt };
    case "awaiting_input":
      return glyph(live.awaitingApproval ? "approval" : "input");
    case "rate_limited":
      return glyph("limited");
    case "failed":
      return glyph("failed");
    case "lost":
      return { kind: "dot", mark: "offline", startedAt: null };
    case "done":
    case "interrupted":
      return glyph("done");
  }
}
