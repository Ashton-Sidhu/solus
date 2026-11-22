import type { ReactNode } from "react";
import { mcpAppLiveToolName } from "@solus/contracts/mcp-apps";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { ThreadFeedEntry } from "../lib/threadActivity";

// The T3 list owns text messages. Rich cards subscribe to their own item on mount.
export function conversationFeed(
  store: Pick<ConversationStore, "item" | "subscribeFeedItems">,
  id: string,
  renderCard: (key: string, superseded: boolean, liveAppOnly?: boolean) => ReactNode,
) {
  type Item = NonNullable<ReturnType<ConversationStore["item"]>>;
  const cache = new WeakMap<
    Item,
    { leadingRun: RunId | null; superseded: boolean; entries: ThreadFeedEntry[] }
  >();
  const project = (
    key: string,
    item: Item,
    leadingRun: RunId | null,
    superseded: boolean,
  ): ThreadFeedEntry[] => {
    const timestamp = "timestamp" in item ? item.timestamp : undefined;
    const date = timestamp && timestamp > 0 ? new Date(timestamp) : null;
    const createdAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
    const card: ThreadFeedEntry = {
      type: "conversation-card",
      id: key,
      createdAt,
      runId: leadingRun,
      ...(item.kind === "tool" && { toolStatus: item.status }),
      render: () => renderCard(key, superseded),
    };
    if (item.kind !== "user" && item.kind !== "assistant") {
      return item.kind === "tool" && mcpAppLiveToolName(item.toolName)
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
        : [card];
    }
    return [
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
    ];
  };
  return (order: readonly string[]) => {
    const observed = new Map<string, NonNullable<ReturnType<ConversationStore["item"]>>>();
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
      if (item.kind === "tool" || item.kind === "user" || item.kind === "assistant")
        observed.set(key, item);
      const superseded =
        item.kind === "artifact" && !!item.workId && latest.get(item.workId) !== key;
      const leadingRun = leadingTools.has(key) ? RunId.make("leading-work:" + order[0]) : null;
      let held = cache.get(item);
      if (!held || held.leadingRun !== leadingRun || held.superseded !== superseded) {
        held = { leadingRun, superseded, entries: project(key, item, leadingRun, superseded) };
        cache.set(item, held);
      }
      rows.set(key, held.entries);
    };
    order.forEach(update);
    let snapshot = Array.from(rows.values()).flat();
    return {
      get: () => snapshot,
      subscribe: (notify: () => void) => {
        const refresh = (keys: Iterable<string>) => {
          let changed = false;
          for (const key of keys) {
            const before = observed.get(key);
            if (!before) continue;
            const item = store.item(key);
            if (!item || item === before) continue;
            if (item.kind === "tool" && before.kind === "tool" && item.status === before.status) {
              observed.set(key, item);
              continue;
            }
            update(key);
            changed = true;
          }
          if (changed) {
            snapshot = Array.from(rows.values()).flat();
            notify();
          }
        };
        const stop = store.subscribeFeedItems(refresh);
        // Reconcile a change between render and subscribe without publishing unchanged rows.
        refresh(observed.keys());
        return stop;
      },
    };
  };
}
