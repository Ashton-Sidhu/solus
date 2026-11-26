import {
  RunId,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import { deriveThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import { atomFromConversation } from "./session-detail";
import type { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import type { AgentId } from "@solus/contracts/types";
import { remoteAgentChild } from "./agent-child-host";
import { sessionSubagent, type AgentFeedContext } from "./session-subagent";

export function sessionAgents(
  model: TranscriptModel,
  id: string,
  provider: AgentId,
  remoteChild?: AgentFeedContext["child"],
) {
  const subagents = model.agentRows.map((item) => {
    const prompt = model.agentTurnIds.get(item.id);
    return sessionSubagent(item, id, prompt ? RunId.make(prompt) : null, provider,
      item.kind === "agent" ? remoteChild?.(item) : undefined);
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
      result = sessionAgents(model, run.sessionId, run.provider, remoteAgentChild(store.controller.hostId));
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
  ).map(({ kind, ...task }) => ({
    ...task,
    kind: kind === "command" || kind === "monitor" || kind === "subagent" ? kind : "background_task",
    ...(model.status === "background" && { awaited: true }),
  }));
}

export const backgroundTasksAtom = atomFromConversation(
  (store) => () => backgroundTasks(store.controller.model),
);
