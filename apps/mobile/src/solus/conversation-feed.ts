import type { ReactNode } from "react";
import { mcpAppLiveToolName } from "@solus/contracts/mcp-apps";
import { viewedImagePath } from "@solus/client-core/viewed-workspace-image";
import {
  MessageId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { DateTime } from "effect";
import {
  commandText,
  parseToolInput,
  toolGroupAction,
} from "@solus-mobile/features/threads/thread-work-log-presentation";
import {
  buildThreadFeed,
  createThreadFeedCache,
  type ThreadFeedSourceRow,
  type RawThreadFeedEntry,
} from "../lib/threadActivity";
import { messageAttachments } from "./upload-images";
import { createArtifactGrouping, type ArtifactGroup } from "./artifact-groups";

// The T3 list owns text messages. Rich cards subscribe to their own item on mount.
export function conversationFeed(
  store: Pick<ConversationStore, "item" | "subscribeFeedItems">,
  id: string,
  renderCard: (
    key: string,
    superseded: boolean,
    liveAppOnly?: boolean,
    artifactGroup?: ArtifactGroup,
  ) => ReactNode,
  resolveImagePath: (path: string, refresh?: boolean) => Promise<string>,
  readToolInput: (key: string) => Promise<string>,
) {
  type Item = NonNullable<ReturnType<ConversationStore["item"]>>;
  const cache = new WeakMap<
    Item,
    {
      leadingRun: RunId | null;
      superseded: boolean;
      group: ArtifactGroup | undefined;
      sources: ThreadFeedSourceRow[];
    }
  >();
  const threadId = ThreadId.make(id);
  const project = (
    key: string,
    item: Item,
    leadingRun: RunId | null,
    superseded: boolean,
    group: ArtifactGroup | undefined,
  ): ThreadFeedSourceRow[] => {
    // The group card shows at its first member; the other members are in it.
    if (group && group.id !== key) return [];
    if (
      item.kind === "user" &&
      item.waitsForTurn &&
      (item.delivery === "queued" || item.delivery === "sending")
    )
      return [];
    const timestamp = "timestamp" in item ? item.timestamp : undefined;
    const date = timestamp && timestamp > 0 ? new Date(timestamp) : null;
    const createdAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
    if (item.kind === "fork") {
      const sourceThreadId = ThreadId.make(item.activity.sourceSessionId);
      const time = DateTime.makeUnsafe(item.activity.at);
      const itemId = TurnItemId.make(key);
      return [{
        sourceItemId: itemId,
        sourceThreadId,
        position: 0,
        visibility: "synthetic",
        item: {
          id: itemId,
          threadId,
          runId: null,
          nodeId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: "Forked from conversation",
          startedAt: null,
          completedAt: time,
          updatedAt: time,
          type: "fork",
          source: { type: "provider_thread", providerThreadId: ProviderThreadId.make(sourceThreadId) },
          targetThreadId: threadId,
        },
      }];
    }
    const viewedImage =
      item.kind === "tool" ? viewedImagePath(item.toolName, item.input, item.status) : undefined;
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
          ...(viewedImage && { viewedImagePath: viewedImage }),
        };
      };
      const projected = toolItem(item.input);
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
          item: projected,
          sourceItemId: base.id,
          sourceThreadId: threadId,
          position: 0,
          visibility: "local",
          hostTime: createdAt,
          hostTool: {
            hasDetail: !!(item.input?.trim() || item.errorHead),
            ...(loadHostDetail && { load: loadHostDetail }),
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
      ...(viewedImage && { viewedImagePath: viewedImage }),
      render: () => (group ? renderCard(key, false, false, group) : renderCard(key, superseded)),
    };
    if (item.kind !== "user" && item.kind !== "assistant") {
      return [
        {
          hostEntries:
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
        },
      ];
    }
    const time = DateTime.makeUnsafe(date && createdAt ? date : 0);
    const streaming = item.kind === "assistant" && item.streaming === true;
    const base = {
      id: TurnItemId.make(key),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      title: null,
      startedAt: createdAt ? time : null,
      completedAt: streaming || !createdAt ? null : time,
      updatedAt: time,
      status: streaming ? ("running" as const) : ("completed" as const),
      messageId: MessageId.make(key),
      text: item.text,
    };
    const row: ThreadFeedSourceRow = {
      hostTime: createdAt,
      hostBackgroundCommand: item.kind === "user" ? item.backgroundCommand : undefined,
      ...(item.kind === "assistant" && item.forkPointId && { hostForkPointId: item.forkPointId }),
      sourceItemId: base.id,
      sourceThreadId: ThreadId.make(item.sourceSessionId ?? id),
      position: 0,
      visibility: "local",
      item:
        item.kind === "assistant"
          ? { ...base, type: "assistant_message", streaming }
          : {
              ...base,
              type: "user_message",
              inputIntent: "turn_start",
              createdBy: "user",
              creationSource: "provider",
              attachments: messageAttachments(item.sourceSessionId ?? id, item.attachments, resolveImagePath),
            },
    };
    return item.kind === "user" &&
      item.delivery === "failed"
      ? [row, { hostEntries: [{ ...card, id: key + ":attachments" }] }]
      : [row];
  };
  const feedCache = createThreadFeedCache();
  const artifactGroups = createArtifactGrouping();
  return (order: readonly string[]) => {
    const observed = new Map<string, NonNullable<ReturnType<ConversationStore["item"]>>>();
    const rows = new Map<string, ThreadFeedSourceRow[]>();
    const latest = new Map<string, string>();
    const leadingTools = new Set<string>();
    let hasPrompt = false;
    for (const key of order) {
      const item = store.item(key);
      if (item?.kind === "user") hasPrompt = true;
      if (!hasPrompt && item?.kind === "tool") leadingTools.add(key);
      if (item?.kind === "artifact" && item.workId) latest.set(item.workId, key);
    }
    const groups = artifactGroups(order, (key) => store.item(key));
    const update = (key: string) => {
      const item = store.item(key);
      if (!item) return;
      if (item.kind === "tool" || item.kind === "user" || item.kind === "assistant")
        observed.set(key, item);
      const group = groups.get(key);
      const superseded =
        !group && item.kind === "artifact" && !!item.workId && latest.get(item.workId) !== key;
      const leadingRun = leadingTools.has(key) ? RunId.make("leading-work:" + order[0]) : null;
      let held = cache.get(item);
      if (
        !held ||
        held.leadingRun !== leadingRun ||
        held.superseded !== superseded ||
        held.group !== group
      ) {
        held = {
          leadingRun,
          superseded,
          group,
          sources: project(key, item, leadingRun, superseded, group),
        };
        cache.set(item, held);
      }
      rows.set(key, held.sources);
    };
    order.forEach(update);
    const offsets = new Map<string, number>();
    const collectSources = () => {
      const sources: ThreadFeedSourceRow[] = [];
      for (const [key, entries] of rows) {
        offsets.set(key, sources.length);
        sources.push(...entries);
      }
      return sources;
    };
    let sources = collectSources();
    let snapshot = buildThreadFeed(sources, { cache: feedCache });
    return {
      get: () => snapshot,
      subscribe: (notify: () => void) => {
        const refresh = (keys: Iterable<string>) => {
          let rebuild = false;
          let patched: ThreadFeedSourceRow[] | undefined;
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
            const beforeRows = rows.get(key)!;
            update(key);
            const afterRows = rows.get(key)!;
            if (beforeRows.length !== afterRows.length) rebuild = true;
            else if (!rebuild && beforeRows !== afterRows) {
              patched ??= sources.slice();
              const offset = offsets.get(key)!;
              afterRows.forEach((row, index) => {
                patched![offset + index] = row;
              });
            }
          }
          if (rebuild || patched) {
            sources = rebuild ? collectSources() : patched!;
            snapshot = buildThreadFeed(sources, { cache: feedCache });
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
