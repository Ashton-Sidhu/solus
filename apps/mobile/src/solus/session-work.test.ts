import { expect, it, vi } from "vite-plus/test";
import { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import { backgroundTasks, sessionAgents } from "./session-work";

vi.mock("./session-detail", () => ({ atomFromConversation: vi.fn() }));

it("retains task names on reconnect and clears completed background work", () => {
  const model = new TranscriptModel("session");
  model.apply({
    type: "background_task_progress",
    taskId: "build",
    description: "Compile sources",
  });
  model.setBackgroundWorkRunning(true, ["build", "test"]);
  expect(backgroundTasks(model).map((task) => [task.taskId, task.description])).toEqual([
    ["build", "Compile sources"],
    ["test", undefined],
  ]);
  model.apply({ type: "background_task_settled", taskId: "build", status: "completed" });
  expect(backgroundTasks(model).map((task) => task.taskId)).toEqual(["test"]);
  model.setBackgroundWorkRunning(false);
  expect(backgroundTasks(model)).toEqual([]);
});

it("a later prompt hides the completed agents pill and leaves its turn history intact", () => {
  const model = new TranscriptModel("session");
  model.agentRows = [
    {
      kind: "agent",
      id: "first",
      title: "Reader",
      sessionId: "child",
      provider: "codex",
      model: null,
      prompt: "Inspect",
      reply: "Done",
      exchanges: [{ messageId: "one", status: "done" }],
      startedAt: 1000,
      settledAt: 1100,
      durationMs: 100,
    },
  ];
  model.agentTurnIds.set("first", "prompt");
  model.latestPromptId = "prompt";
  expect(sessionAgents(model, "session", "codex")?.latestTurn).toBe(true);
  model.latestPromptId = "later";
  const latest = sessionAgents(model, "session", "codex");
  expect(latest?.latestTurn).toBe(false);
  expect(latest?.subagents[0]?.childThreadId).toBe("child");
});

it("opens a native agent through the provider tool call in its parent session", () => {
  const model = new TranscriptModel("parent");
  model.apply({
    type: "tool_call",
    toolName: "Agent",
    toolId: "provider-call",
    index: 0,
    isSubagent: true,
  });
  const agent = sessionAgents(model, "parent", "claude-code")?.subagents[0];
  expect(agent).toMatchObject({
    origin: "provider_native",
    threadId: "parent",
    childThreadId: null,
    nativeTaskRef: { nativeId: "provider-call" },
  });
  expect(agent?.id).not.toBe("provider-call");
});
