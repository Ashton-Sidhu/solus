import type { SessionHistoryPage, WireSessionLoadMessage } from "@solus/contracts/session-history";
import { toolFeedBody, userMessageBody } from "@solus/contracts/session-feed-item";
import { ThreadId } from "@t3tools/contracts";
import { v2ThreadShell } from "../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { expect, it } from "vite-plus/test";
import { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import { conversationFeed } from "./conversation-feed";

// Measures the two steps a saved page goes through on the phone when a session opens:
// history rows to transcript items, then transcript items to the T3 feed. It decides
// whether the host must convert history rows for the phone: below ~3 ms for 800 rows on
// a desktop CPU, the phone keeps the conversion. Run it with SOLUS_BENCH=1.

/** Rows as the host sends them with `sessionFeedHistoryOptions`. */
function page(rowCount: number): SessionHistoryPage {
  const messages: WireSessionLoadMessage[] = [];
  let clock = 1_700_000_000_000;
  let turn = 0;
  const push = (row: WireSessionLoadMessage) => messages.push(row);
  while (messages.length < rowCount) {
    turn++;
    push({ role: "user", content: "", timestamp: ++clock, messageId: `u${turn}`, turnItem: userMessageBody(`Please fix the bug in module ${turn}. It fails when the cache is cold and the reader is remote.`) });
    for (let step = 0; step < 6; step++) {
      const toolId = `t${turn}-${step}`;
      const name = ["Read", "Bash", "Edit", "Grep", "Read", "Bash"][step]!;
      const input = name === "Bash" ? JSON.stringify({ command: `bun test tests/unit/module-${turn}.test.ts` })
        : name === "Edit" ? JSON.stringify({ file_path: `/repo/src/module-${turn}.ts`, old_string: "a".repeat(200), new_string: "b".repeat(220) })
          : JSON.stringify({ file_path: `/repo/src/module-${turn}-${step}.ts` });
      const body = toolFeedBody(name, input);
      const call: WireSessionLoadMessage = { role: "tool", content: "", timestamp: ++clock, messageId: `m${toolId}`, toolId, toolName: name, status: "ok", turnItem: body };
      // The host leaves out a dynamic tool's raw input: its body carries it.
      if (body.type !== "dynamic_tool") call.toolInput = input;
      push(call);
      push({ role: "tool_result", content: "", timestamp: ++clock, toolResultForId: toolId, status: step === 5 && turn % 4 === 0 ? "error" : "ok",
        contentBytes: 2_400, ...(step === 5 && turn % 4 === 0 && { errorHead: "Error: expected 1 to be 2" }) });
    }
    if (turn % 3 === 0) {
      // A provider sub-agent with its own rows.
      const taskId = `task${turn}`;
      push({ role: "tool", content: "", timestamp: ++clock, messageId: `m${taskId}`, toolId: taskId, toolName: "Task", isSubagent: true, subagentType: "Explore",
        toolInput: JSON.stringify({ description: "Find callers", prompt: "Find every caller of the cache." }), report: "Found 4 callers.", status: "ok" });
      for (let step = 0; step < 3; step++) {
        push({ role: "tool", content: "", timestamp: ++clock, parentToolUseId: taskId, messageId: `c${taskId}-${step}`, toolId: `${taskId}-c${step}`, toolName: "Grep", toolInput: JSON.stringify({ pattern: "cache" }) });
        push({ role: "tool_result", content: "", timestamp: ++clock, parentToolUseId: taskId, toolResultForId: `${taskId}-c${step}`, status: "ok", contentBytes: 300 });
      }
    }
    if (turn % 4 === 0) {
      // An orchestration call to another Solus session, and its result.
      const startId = `start${turn}`;
      push({ role: "tool", content: "", timestamp: ++clock, messageId: `m${startId}`, toolId: startId, toolName: "mcp__solus__start_sessions",
        toolInput: JSON.stringify({ sessions: [{ prompt: "Review the change", title: "Review" }] }), status: "ok" });
      push({ role: "tool_result", content: "", timestamp: ++clock, toolResultForId: startId, status: "ok",
        agentConversationResults: [{ item: 0, sessionId: `child-${turn}`, messageId: `ex-${turn}` }] });
    }
    if (turn % 5 === 0) {
      // An HTML render and a screenshot.
      const renderId = `render${turn}`;
      push({ role: "tool", content: "", timestamp: ++clock, messageId: `m${renderId}`, toolId: renderId, toolName: "mcp__solus__render_artifact", toolInputKey: `key-${renderId}`, status: "ok" });
      push({ role: "tool_result", content: "", timestamp: ++clock, toolResultForId: renderId, status: "ok",
        artifactWorkRef: { workId: `work${turn}`, title: "Chart", contentVersion: 1, layout: { height: 480, heights: [[375, 480]] } } });
      const shotId = `shot${turn}`;
      push({ role: "tool", content: "", timestamp: ++clock, messageId: `m${shotId}`, toolId: shotId, toolName: "mcp__solus__browser_snapshot", toolInput: "{}", status: "ok",
        toolImages: [{ assetId: `shot-${turn}`, mimeType: "image/png", width: 1280, height: 800 }] });
    }
    push({ role: "assistant", content: "", timestamp: ++clock, messageId: `a${turn}`, turnItem: { type: "assistant_message", streaming: false,
      text: `I fixed module ${turn}.\n\n- The cache now reads through.\n- The test passes.\n\n\`\`\`ts\nconst value = cache.get(key) ?? load(key)\n\`\`\`` } });
  }
  return { before: null, messages: messages.slice(0, rowCount) };
}

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

it.skipIf(!process.env.SOLUS_BENCH)("measures the saved-page conversion on the phone", () => {
  const report: string[] = [];
  for (const rows of [100, 400, 800, 2000]) {
    const fixture = page(rows);
    const modelTimes: number[] = [];
    const feedTimes: number[] = [];
    let items = 0;
    for (let run = 0; run < 30; run++) {
      const pageCopy = structuredClone(fixture);
      let start = performance.now();
      const model = TranscriptModel.fromHistory("session", pageCopy);
      modelTimes.push(performance.now() - start);
      items = model.order.length;
      start = performance.now();
      const feed = conversationFeed(
        { item: (key) => model.items.get(key), subscribeFeedItems: () => () => {} },
        "session", () => null, async (path) => path, async (key) => key,
        { provider: "claude-code", child: () => undefined },
      )(model.order);
      feed.get();
      feed.projection({ ...v2ThreadShell, id: ThreadId.make("session") });
      feedTimes.push(performance.now() - start);
    }
    expect(items).toBeGreaterThan(0);
    report.push(`${rows} rows -> ${items} items: fromHistory median ${median(modelTimes.slice(5)).toFixed(2)} ms (first ${modelTimes[0]!.toFixed(2)} ms), feed median ${median(feedTimes.slice(5)).toFixed(2)} ms (first ${feedTimes[0]!.toFixed(2)} ms)`);
  }
  console.log(report.join("\n"));
});
