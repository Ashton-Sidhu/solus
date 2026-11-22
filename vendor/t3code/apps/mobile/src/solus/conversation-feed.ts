import type { ReactNode } from "react";
import { mcpAppLiveToolName } from "@solus/contracts/mcp-apps";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { ThreadFeedEntry } from "../lib/threadActivity";

// The T3 list owns text messages. Rich cards subscribe to their own item on mount.
export function conversationFeed(
  store: Pick<ConversationStore, "item" | "subscribeItem">,
  order: readonly string[],
  id: string,
  renderCard: (key: string, superseded: boolean, liveAppOnly?: boolean) => ReactNode,
) {
  const rows = new Map<string, ThreadFeedEntry[]>();
  const latest = new Map<string, string>();
  const leadingTools = new Set<string>();
  let hasPrompt = false;
  for (const key of order) {
    const item = store.item(key);
    if (item?.kind === "user") hasPrompt = true;
    if (!hasPrompt && item?.kind === "tool") leadingTools.add(key);
    if (item?.kind === "artifact" && item.workId) latest.set(item.workId, key);
  }
  const update = (key: string) => {
    const item = store.item(key);
    if (!item) return;
    const timestamp = "timestamp" in item ? item.timestamp : undefined;
    const date = timestamp && timestamp > 0 ? new Date(timestamp) : null;
    const createdAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
    const superseded = item.kind === "artifact" && !!item.workId && latest.get(item.workId) !== key;
    const card: ThreadFeedEntry = {
      type: "conversation-card",
      id: key,
      createdAt,
      runId: leadingTools.has(key) ? RunId.make("leading-work:" + order[0]) : null,
      ...(item.kind === "tool" && { toolStatus: item.status }),
      render: () => renderCard(key, superseded),
    };
    if (item.kind !== "user" && item.kind !== "assistant") {
      rows.set(
        key,
        item.kind === "tool" && mcpAppLiveToolName(item.toolName)
          ? [
              card,
              {
                type: "conversation-card",
                id: key + ":app",
                runId: null,
                createdAt,
                render: () => renderCard(key, false, true),
              },
            ]
          : [card],
      );
      return;
    }
    rows.set(key, [
      {
        type: "message",
        id: key,
        createdAt,
        message: {
          id: MessageId.make(key),
          role: item.kind,
          text: item.text,
          createdAt,
          updatedAt: createdAt,
          streaming: false,
          attachments: [],
          runId: null,
          visibility: "local",
          sourceThreadId: ThreadId.make(item.sourceSessionId ?? id),
        },
      },
      ...(item.kind === "user" && (item.attachments.length || item.delivery === "failed")
        ? [{ ...card, id: key + ":attachments" }]
        : []),
    ]);
  };
  order.forEach(update);
  let snapshot = Array.from(rows.values()).flat();
  return {
    get: () => snapshot,
    subscribe: (notify: () => void) => {
      const refresh = () => {
        snapshot = Array.from(rows.values()).flat();
        notify();
      };
      const stops = order
        .filter((key) => {
          const kind = store.item(key)?.kind;
          return kind === "user" || kind === "assistant" || kind === "tool";
        })
        .map((key) =>
          store.subscribeItem(key, () => {
            const item = store.item(key);
            const row = rows.get(key)?.[0];
            if (
              item?.kind === "tool" &&
              row?.type === "conversation-card" &&
              row.toolStatus === item.status
            )
              return;
            update(key);
            refresh();
          }),
        );
      order.forEach(update);
      refresh();
      return () => stops.forEach((stop) => stop());
    },
  };
}
