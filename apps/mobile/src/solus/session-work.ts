import {
  NodeId,
  RunId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2Subagent,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import { deriveThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import { DateTime } from "effect";
import { atomFromConversation } from "./session-detail";
import { agentCardStatus } from "@solus-mobile/features/conversation/lib/agent-cards";
import type { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import type { AgentId } from "@solus/contracts/types";
import { subagentTitle } from "@solus/contracts/subagent-input";

export function sessionAgents(model: TranscriptModel, id: string, provider: AgentId) {
  const subagents = model.agentRows.map((item): OrchestrationV2Subagent => {
    const agent = item.kind === "agent";
    const time = DateTime.makeUnsafe(agent ? item.startedAt : (item.timestamp ?? 0));
    const driver =
      (agent ? (item.provider ?? provider) : provider) === "claude-code" ? "claudeAgent" : "codex";
    const status = agent ? agentCardStatus(item) : item.status;
    const promptId = model.agentTurnIds.get(item.id);
    return {
      id: NodeId.make(item.id),
      parentNodeId: NodeId.make(id),
      threadId: ThreadId.make(id),
      runId: promptId ? RunId.make(promptId) : null,
      driver: ProviderDriverKind.make(driver),
      providerInstanceId: ProviderInstanceId.make(driver),
      origin: agent ? "app_owned" : "provider_native",
      childThreadId: agent ? ThreadId.make(item.sessionId) : null,
      createdBy: "agent",
      providerThreadId: null,
      nativeTaskRef: agent
        ? null
        : { driver: ProviderDriverKind.make(driver), nativeId: item.toolId, strength: "strong" },
      title: agent ? item.title : subagentTitle(item.input ?? undefined),
      prompt: agent ? item.prompt : "",
      model: agent ? item.model : null,
      status:
        status === "done" || status === "completed"
          ? "completed"
          : status === "error" || status === "failed"
            ? "failed"
            : status === "lost" || status === "interrupted"
              ? "interrupted"
              : "running",
      result: agent ? item.reply : item.report,
      startedAt: time,
      updatedAt: time,
      completedAt: agent && item.settledAt ? DateTime.makeUnsafe(item.settledAt) : null,
    };
  });
  const result = deriveThreadTurnSubagents({ runs: [], subagents });
  if (!result) return null;
  return {
    ...result,
    latestTurn: result.runId === model.latestPromptId,
    turnActive: model.status === "running",
  };
}

export const sessionAgentsAtom = atomFromConversation((store) => {
  let previous: TranscriptModel["agentRows"] | null = null;
  let promptId: string | null = null;
  let status: typeof store.controller.model.status | undefined;
  let result: ReturnType<typeof sessionAgents> = null;
  return () => {
    const { model, run } = store.controller;
    if (
      previous !== model.agentRows ||
      promptId !== model.latestPromptId ||
      status !== model.status
    ) {
      status = model.status;
      promptId = model.latestPromptId;
      previous = model.agentRows;
      result = sessionAgents(model, run.sessionId, run.provider);
    }
    return result;
  };
});

export function backgroundTasks(
  model: Pick<TranscriptModel, "backgroundTasks" | "backgroundWorkRunning" | "status">,
): OrchestrationV2PendingBackgroundTask[] {
  const tasks = model.backgroundTasks;
  if (tasks.length === 0 && !model.backgroundWorkRunning) return [];
  return (
    tasks.length ? tasks : [{ taskId: "session-background", description: "Background work" }]
  ).map((task) => ({
    ...task,
    kind: "background_task",
    ...(model.status === "background" && { awaited: true }),
  }));
}

export const backgroundTasksAtom = atomFromConversation(
  (store) => () => backgroundTasks(store.controller.model),
);
