import type { ReactNode } from "react";
import { mcpAppLiveToolName } from "@solus/contracts/mcp-apps";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { DateTime } from "effect";
import { m } from "../i18n/messages";
import {
  commandText,
  parseToolInput,
  toolGroupAction,
} from "@solus-mobile/features/threads/thread-work-log-presentation";
import {
  groupAdjacentActivities,
  toFeedActivity,
  type RawThreadFeedEntry,
} from "../lib/threadActivity";
import { messageMediaAttachments } from "./upload-images";
const noChildren = new Map<RunId, ReadonlySet<string>>();

// The T3 list owns text messages. Rich cards subscribe to their own item on mount.
export function conversationFeed(
  store: Pick<ConversationStore, "item" | "subscribeFeedItems">,
  id: string,
  renderCard: (key: string, superseded: boolean, liveAppOnly?: boolean) => ReactNode,
  resolveImagePath: (path: string, refresh?: boolean) => Promise<string>,
  readToolInput: (key: string) => Promise<string>,
) {
  type Item = NonNullable<ReturnType<ConversationStore["item"]>>;
  const cache = new WeakMap<
    Item,
    { leadingRun: RunId | null; superseded: boolean; entries: RawThreadFeedEntry[] }
  >();
  const threadId = ThreadId.make(id);
  const project = (
    key: string,
    item: Item,
    leadingRun: RunId | null,
    superseded: boolean,
  ): RawThreadFeedEntry[] => {
    if (item.kind === "user" && item.waitsForTurn && (item.delivery === "queued" || item.delivery === "sending")) return [];
    const timestamp = "timestamp" in item ? item.timestamp : undefined;
    const date = timestamp && timestamp > 0 ? new Date(timestamp) : null;
    const createdAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
    // Ordinary calls use the same activity projection and disclosures as T3.
    // Calls with Solus resources keep their interactive card.
    if (
      item.kind === "tool" &&
      !item.children &&
      !item.subagent &&
      !item.report &&
      !item.images?.length &&
      !item.audio?.length &&
      !item.leftOut?.length &&
      !item.secretOutcomes?.length &&
      !mcpAppLiveToolName(item.toolName)
    ) {
      const time = DateTime.makeUnsafe(date && createdAt ? date : 0);
      const base = {
        id: TurnItemId.make(key),
        threadId,
        runId: leadingRun,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: item.status === "error" ? ("failed" as const) : item.status,
        title: null,
        startedAt: createdAt ? time : null,
        completedAt: item.status === "running" || !createdAt ? null : time,
        updatedAt: time,
      };
      const toolItem = (input: string | null): OrchestrationV2TurnItem => {
        if (toolGroupAction(item.toolName) === "command")
          return {
            ...base,
            type: "command_execution",
            input: commandText(parseToolInput(input)) ?? (input === "{}" ? "" : input) ?? "",
            ...(item.errorHead && { output: item.errorHead }),
          };
        let args = input;
        if (input) {
          try {
            args = JSON.parse(input);
          } catch {
            /* Provider supplied plain text. */
          }
        }
        return {
          ...base,
          type: "dynamic_tool",
          toolName: item.toolName,
          input: args,
          output: item.errorHead,
        };
      };
      const projected = toolItem(item.input);
      const activity = toFeedActivity(
        {
          item: projected,
          sourceItemId: base.id,
          sourceThreadId: threadId,
          visibility: "local",
          position: 0,
        },
        null,
        m,
      );
      const detailKey = item.toolInputKey;
      let detail: Promise<OrchestrationV2TurnItem> | undefined;
      const loadHostDetail = detailKey
        ? () =>
            (detail ??= readToolInput(detailKey)
              .then(toolItem)
              .catch((error) => {
                detail = undefined;
                throw error;
              }))
        : undefined;
      return [
        {
          type: "activity",
          id: key,
          createdAt,
          runId: leadingRun,
          activity: {
            ...activity,
            createdAt,
            canExpand:
              !!loadHostDetail || (!!(item.input?.trim() || item.errorHead) && activity.canExpand),
            fetchesDetail: false,
            loadHostDetail,
          },
        },
      ];
    }
    const card: RawThreadFeedEntry = {
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
          streaming: item.kind === "assistant" && item.streaming === true,
          attachments:
            item.kind === "user" ? messageMediaAttachments(item.attachments, resolveImagePath) : [],
          runId: null,
          visibility: "local",
          sourceThreadId: ThreadId.make(item.sourceSessionId ?? id),
        },
      },
      ...(item.kind === "user" &&
      (item.attachments.some((a) => a.kind === "file" && !a.video) || item.delivery === "failed")
        ? [{ ...card, id: key + ":attachments" }]
        : []),
    ];
  };
  return (order: readonly string[]) => {
    const observed = new Map<string, NonNullable<ReturnType<ConversationStore["item"]>>>();
    const rows = new Map<string, RawThreadFeedEntry[]>();
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
    const messageIndexes = new Map<string, number>();
    const group = () => {
      const grouped = groupAdjacentActivities(Array.from(rows.values()).flat(), noChildren);
      messageIndexes.clear();
      grouped.forEach((row, index) => {
        if (row.type === "message") messageIndexes.set(row.id, index);
      });
      return grouped;
    };
    let snapshot = group();
    return {
      get: () => snapshot,
      subscribe: (notify: () => void) => {
        const refresh = (keys: Iterable<string>) => {
          let regroup = false;
          let patched: typeof snapshot | undefined;
          for (const key of keys) {
            const before = observed.get(key);
            if (!before) continue;
            const item = store.item(key);
            if (!item || item === before) continue;
            if (
              item.kind === "tool" &&
              before.kind === "tool" &&
              item.status === before.status &&
              item.input === before.input &&
              item.toolInputKey === before.toolInputKey &&
              item.subagent === before.subagent &&
              item.errorHead === before.errorHead &&
              item.images === before.images &&
              item.audio === before.audio &&
              item.leftOut === before.leftOut &&
              item.secretOutcomes === before.secretOutcomes &&
              item.children === before.children &&
              item.report === before.report
            ) {
              observed.set(key, item);
              continue;
            }
            const previous = rows.get(key);
            update(key);
            const next = rows.get(key);
            const message = next?.[0];
            const index = messageIndexes.get(key);
            // Streaming text changes the message in place in the list of groups.
            if (
              before.kind === "assistant" &&
              item.kind === "assistant" &&
              index !== undefined &&
              previous?.length === 1 &&
              next?.length === 1 &&
              message?.type === "message" &&
              item.text.trim()
            ) {
              if (!regroup) (patched ??= snapshot.slice())[index] = message;
            } else {
              regroup = true;
            }
          }
          if (regroup || patched) {
            snapshot = regroup ? group() : patched!;
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
