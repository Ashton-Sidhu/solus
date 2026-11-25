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

it("names each task by the kind the host sent", () => {
  // WHY: without the kind every task read "Running a background task", and a
  // dev server could not be told from a monitor.
  const model = new TranscriptModel("session");
  model.setBackgroundWorkRunning(true, ["dev", "watch", "cron"], [
    { taskId: "dev", kind: "command", description: "bun run dev" },
    { taskId: "watch", kind: "monitor" },
    { taskId: "cron", kind: "schedule", description: "check the log" },
  ]);
  expect(backgroundTasks(model).map((task) => [task.taskId, task.kind, task.description])).toEqual([
    ["dev", "command", "bun run dev"],
    ["watch", "monitor", undefined],
    ["cron", "background_task", "check the log"],
  ]);
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

it("shows a completed provider agent and its report after live delivery and reconnect", () => {
  const toolId = "provider-call";
  const report =
    "[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n\nUpdated the three render works.";
  const live = new TranscriptModel("parent");
  live.apply({ type: "tool_call", toolName: "Agent", toolId, index: 0, isSubagent: true });
  expect(sessionAgents(live, "parent", "claude-code")?.liveCount).toBe(1);
  live.apply({ type: "subagent_report", toolUseId: toolId, text: report });

  const restored = new TranscriptModel("parent");
  restored.prependHistory({
    before: null,
    messages: [
      { role: "tool", content: "", toolId, toolName: "Agent", toolStatus: "running", timestamp: 1000 },
      {
        role: "tool_result",
        content: "",
        toolResultForId: toolId,
        status: "ok",
        report,
        timestamp: 4000,
      },
    ],
  });

  for (const model of [live, restored]) {
    const turn = sessionAgents(model, "parent", "claude-code");
    expect(turn?.liveCount).toBe(0);
    expect(turn?.subagents[0]).toMatchObject({
      status: "completed",
      result: "Updated the three render works.",
    });
    expect(turn?.subagents[0]?.completedAt).toBeTruthy();
  }
});

it("names a provider sub-agent by its own description, as the desktop card and the host do", () => {
  const model = new TranscriptModel("parent");
  model.apply({ type: "tool_call", toolName: "Agent", toolId: "provider-call", index: 0, isSubagent: true });
  // Claude streams the input after the call starts.
  expect(sessionAgents(model, "parent", "claude-code")?.subagents[0]?.title).toBe("Sub-agent");
  model.apply({
    type: "tool_call_complete",
    index: 0,
    toolId: "provider-call",
    toolInput: JSON.stringify({ description: "Audit the auth module", prompt: "Read every file" }),
  });
  expect(sessionAgents(model, "parent", "claude-code")?.subagents[0]?.title).toBe("Audit the auth module");
});
