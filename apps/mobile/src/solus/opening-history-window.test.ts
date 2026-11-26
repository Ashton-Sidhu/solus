import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { ThreadFeedRow } from "../features/threads/pending-thread-feed";
import { openingHistoryStart } from "./opening-history-window";

const createdAt = "2026-01-01T00:00:00Z";
const reply = {
  type: "message", id: "reply", createdAt,
  message: {
    id: MessageId.make("reply"), role: "assistant", text: "Reply", attachments: [],
    runId: null, streaming: false, visibility: "local", sourceThreadId: ThreadId.make("thread"),
    createdAt, updatedAt: createdAt,
  },
} as const satisfies ThreadFeedRow;
const prompt = { ...reply, message: { ...reply.message, role: "user" } } as const;
const fold = {
  type: "run-fold", id: "fold", runId: RunId.make("run"), createdAt, label: "Worked", expanded: false,
} as const;
const card = { type: "conversation-card", id: "card", runId: null, createdAt, render: () => null } as const;

it("opens at the fourth message from the end and retains the folds between messages", () => {
  expect(openingHistoryStart([reply, prompt, fold, reply, prompt, fold, reply])).toBe(1);
});

it("keeps three messages after a card and lets the native list show a shorter partial tail", () => {
  expect(openingHistoryStart([card, reply, prompt, fold, reply])).toBe(1);
  expect(openingHistoryStart([card, prompt, fold, reply])).toBe(4);
  expect(openingHistoryStart([card, reply])).toBe(2);
});

it("can show a whole short conversation and leaves the final prompt to the native list", () => {
  expect(openingHistoryStart([prompt, fold, reply])).toBe(0);
  expect(openingHistoryStart([reply])).toBe(0);
  expect(openingHistoryStart([reply, prompt])).toBe(2);
  expect(openingHistoryStart([])).toBe(0);
});

it("leaves attachment messages and expanded tools to the interactive list", () => {
  const photo = {
    id: "photo", type: "image", name: "photo.png", mimeType: "image/png", sizeBytes: 10,
  } as const;
  const attachment = { ...prompt, message: { ...prompt.message, attachments: [photo] } };
  expect(openingHistoryStart([prompt, fold, attachment, reply])).toBe(4);
  expect(openingHistoryStart([prompt, { ...fold, expanded: true }, reply])).toBe(3);
});
