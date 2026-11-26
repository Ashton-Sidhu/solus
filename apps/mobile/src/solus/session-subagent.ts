import { NodeId, ThreadId, ProviderDriverKind, ProviderInstanceId, type RunId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import { DateTime } from "effect";
import { agentCardStatus, type AgentItem } from "@solus-mobile/features/conversation/lib/agent-cards";
import type { ToolItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import type { AgentExchangeStatus, AgentId } from "@solus/contracts/types";
import { parseSubagentInput, subagentInputText, subagentTitle } from "@solus/contracts/subagent-input";

export interface AgentFeedContext {
  provider: AgentId | undefined;
  child: (item: AgentItem) => OrchestrationV2Subagent["remoteChild"];
}

const agentStatus = {
  dispatched: "pending",
  queued: "pending",
  running: "running",
  answered: "running",
  awaiting_input: "waiting",
  waiting_for_children: "waiting",
  rate_limited: "waiting",
  done: "completed",
  completed: "completed",
  failed: "failed",
  error: "failed",
  lost: "interrupted",
  interrupted: "interrupted",
} as const satisfies Record<AgentExchangeStatus | ToolItem["status"], OrchestrationV2Subagent["status"]>;

function providerReportPreview(report: string | null): string | null {
  if (!report?.startsWith("[Subagent hand-back] The text below is the final report")) return report;
  return report.replace(/^[\s\S]*?(?:\r?\n[ \t]*\r?\n|$)/, "").trim() || null;
}

export function sessionSubagent(
  item: AgentItem | ToolItem,
  id: string,
  runId: RunId | null,
  provider: AgentId | undefined,
  remoteChild?: OrchestrationV2Subagent["remoteChild"],
): OrchestrationV2Subagent {
  const agent = item.kind === "agent";
  const start = agent ? item.startedAt : item.timestamp;
  const providerId = (agent && item.provider) || provider;
  const driver = providerId === "claude-code" ? "claudeAgent" : providerId ?? "unknown";
  const status = agent ? agentCardStatus(item) : item.status;
  const input = agent ? undefined : parseSubagentInput(item.input ?? undefined);
  const model = agent ? item.model : input?.model;
  const effort = agent ? item.reasoningEffort : input?.reasoning_effort;
  const end = agent ? item.settledAt : item.completedAt;
  const startedAt = start == null ? null : DateTime.makeUnsafe(start);
  const completedAt = end == null ? null : DateTime.makeUnsafe(end);
  return {
    id: NodeId.make(item.id),
    parentNodeId: NodeId.make(id),
    threadId: ThreadId.make(id),
    runId,
    driver: ProviderDriverKind.make(driver),
    providerInstanceId: ProviderInstanceId.make(driver),
    origin: agent ? "app_owned" : "provider_native",
    childThreadId: agent && !remoteChild ? ThreadId.make(item.sessionId) : null,
    ...(remoteChild && { remoteChild }),
    createdBy: "agent",
    providerThreadId: null,
    nativeTaskRef: agent
      ? null
      : { driver: ProviderDriverKind.make(driver), nativeId: item.toolId, strength: "strong" },
    title: agent ? item.title : subagentTitle(item.input ?? undefined),
    prompt: agent ? item.prompt : subagentInputText(input ?? {}),
    model: model ?? null,
    ...(model && { modelSelection: { instanceId: ProviderInstanceId.make(driver), model,
      ...(effort && { options: [{ id: "effort", value: effort }] }),
    } }),
    ...(!agent && item.progress?.message && { progress: item.progress.message }),
    status: agentStatus[status],
    result: agent ? item.reply : providerReportPreview(item.report),
    startedAt,
    completedAt,
    updatedAt: completedAt ?? startedAt ?? DateTime.makeUnsafe(0),
  };
}
