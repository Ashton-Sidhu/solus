import { isSessionWorktreeSetup } from "@solus/contracts/setup-card";
import { compactionDividerText } from "@solus/contracts/context-compaction";
import { hostNoticeKind, watchNotification } from "@solus/client-core/host-notice";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { sessionSubagent, type AgentFeedContext } from "./session-subagent";
import type { ReactNode } from "react";
import { secretReceiptRows, secretReceiptText } from "@solus/contracts/secret-request";
import { mcpAppLiveToolName } from "@solus/contracts/mcp-apps";
import { viewedImagePath } from "@solus/client-core/viewed-workspace-image";
import {
  EventId,
  MessageId,
  ProviderThreadId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Notification,
} from "@t3tools/contracts";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { DateTime } from "effect";
import { toolFeedBody, userMessageBody } from "@solus/contracts/session-feed-item";
import { savedTurnItems, type TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import {
  buildThreadFeed,
  createThreadFeedCache,
  type ThreadFeedEntry,
  type ThreadFeedSourceRow,
  type RawThreadFeedEntry,
} from "../lib/threadActivity";
import { messageAttachments } from "./upload-images";
import { artifactHtmlRender, type ArtifactRender } from "@solus-mobile/features/conversation/lib/artifacts";
import { HTML_RENDER_TOOL_NAME } from "@t3tools/shared/htmlRender";

const empty = [] as const;
type Tool = Extract<TranscriptItem, { kind: "tool" }>;

function hasInlineToolResult(item: Tool): boolean {
  if (item.images?.length || item.audio?.length || item.progress?.message) return true;
  if (!item.children) return false;
  for (const child of item.children.items.values()) {
    if (child.kind === "tool" && hasInlineToolResult(child)) return true;
  }
  return false;
}

// Older hosts and partial pages can have a child reply without its original
// launch. Keep that output available in the standard disclosure on tap.
function toolReply(item: Tool): string | null {
  const lines: string[] = [];
  if (item.errorHead) lines.push(item.errorHead);
  if (item.secretOutcomes?.length) lines.push(secretReceiptText(secretReceiptRows(item.secretOutcomes, item.input ?? undefined)));
  if (item.leftOut) lines.push(...item.leftOut);
  for (const id of item.children?.order ?? empty) {
    const child = item.children?.items.get(id);
    if (child?.kind === "assistant" || child?.kind === "user" || child?.kind === "notice") lines.push(child.text);
    if (child?.kind === "tool") {
      lines.push(child.toolName);
      if (child.input) lines.push(child.input);
      const output = toolReply(child);
      if (output) lines.push(output);
    }
  }
  if (item.report && item.report !== lines.at(-1)) lines.push(item.report);
  return lines.join("\n\n") || null;
}

function projectedUserBody(item: Extract<TranscriptItem, { kind: "user" }>) {
  const saved = savedTurnItems.get(item);
  // Older hosts can send a generic turn body beside the recorded sender.
  const body = saved?.type === "user_message" && saved.createdBy === "agent"
    ? saved
    : userMessageBody(item.text, item.sender, !item.sender && !!hostNoticeKind({ content: item.text, via: item.via }));
  const { senderThreadId, scheduledTaskId, ...fields } = body;
  return {
    ...fields,
    text: item.text,
    ...(senderThreadId && { senderThreadId: ThreadId.make(senderThreadId) }),
    ...(scheduledTaskId && { scheduledTaskId: ScheduledTaskId.make(scheduledTaskId) }),
  };
}

export function hostFeedWork(feed: readonly ThreadFeedEntry[], busy: boolean, hasPendingText: boolean) {
  // T3 already reserves the working rows below a pending prompt.
  const runlessWorkActive = busy && !hasPendingText;
  const activeWorkStartedAt = runlessWorkActive
    ? feed.findLast((entry) => entry.type === "message" && entry.message.role === "user")?.createdAt || null
    : null;
  return { runlessWorkActive, activeWorkStartedAt };
}

/** A saved artifact version as a finished T3 `html_render` call. T3's feed
 *  builder makes its render row, sized before the page loads. */
function htmlRenderRow(
  threadId: ThreadId,
  key: string,
  render: ArtifactRender,
  runId: RunId | null,
  date: Date | null,
): ThreadFeedSourceRow {
  const time = DateTime.makeUnsafe(date ?? 0);
  const itemId = TurnItemId.make(key);
  return {
    sourceItemId: itemId,
    sourceThreadId: threadId,
    position: 0,
    visibility: "local",
    hostTime: date ? date.toISOString() : "",
    item: {
      id: itemId,
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: date ? time : null,
      completedAt: date ? time : null,
      updatedAt: time,
      type: "dynamic_tool",
      toolName: HTML_RENDER_TOOL_NAME,
      input: null,
      output: { htmlRender: artifactHtmlRender(render) },
    },
  };
}

// The T3 list owns text messages. Rich cards subscribe to their own item on mount.
export function conversationFeed(
  store: Pick<ConversationStore, "item" | "subscribeFeedItems">,
  id: string,
  renderCard: (key: string, liveAppOnly?: boolean) => ReactNode,
  resolveImagePath: (path: string, refresh?: boolean) => Promise<string>,
  readToolInput: (key: string) => Promise<string>,
  agents: AgentFeedContext,
  isLiveAppHeld?: (toolUseId: string) => boolean,
) {
  type Item = NonNullable<ReturnType<ConversationStore["item"]>>;
  const cache = new WeakMap<
    Item,
    {
      leadingRun: RunId | null;
      sources: ThreadFeedSourceRow[];
    }
  >();
  const monitorMessages = new WeakMap<OrchestrationV2TurnItem, {
    message: Extract<OrchestrationV2TurnItem, { type: "user_message" }>;
    notification: OrchestrationV2Notification;
  }>();
  const subagentByItem = new WeakMap<OrchestrationV2TurnItem, OrchestrationV2Subagent>();
  const threadId = ThreadId.make(id);
  const project = (
    key: string,
    item: Item,
    leadingRun: RunId | null,
  ): ThreadFeedSourceRow[] => {
    if (
      item.kind === "user" &&
      item.waitsForTurn &&
      (item.delivery === "queued" || item.delivery === "sending")
    )
      return [];
    const saved = savedTurnItems.get(item);
    const timestamp = "timestamp" in item ? item.timestamp : undefined;
    const date = timestamp && timestamp > 0 ? new Date(timestamp) : null;
    const createdAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
    if (item.kind === "setup" && isSessionWorktreeSetup(item.card, id)) return [];
    if (item.kind === "notice" || item.kind === "compaction") {
      const sourceItemId = TurnItemId.make(key);
      const body = item.kind === "notice"
        ? { type: "system_notice" as const, message: item.text, level: item.tone }
        : { type: "compaction" as const, driver: null, summary: compactionDividerText(item.compaction).label,
            beforeTokenCount: item.compaction.preTokens, afterTokenCount: item.compaction.postTokens };
      return [{ sourceItemId, sourceThreadId: threadId, position: 0, visibility: "local", hostTime: createdAt,
        item: { id: sourceItemId, threadId, runId: leadingRun, nodeId: null, providerThreadId: null, providerTurnId: null,
          nativeItemRef: null, parentItemId: null, ordinal: 0, title: null, startedAt: null, completedAt: null,
          status: item.kind === "compaction" && item.compaction.isRunning ? "running" : "completed",
          updatedAt: DateTime.makeUnsafe(date ?? 0), ...body },
      }];
    }
    if (item.kind === "artifact") return [htmlRenderRow(threadId, key, item, leadingRun, date && createdAt ? date : null)];
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
    if (item.kind === "agent" || (item.kind === "tool" && item.subagent)) {
      const agent = sessionSubagent(item, id, leadingRun, agents.provider,
        item.kind === "agent" ? agents.child(item) : undefined);
      const sourceItemId = TurnItemId.make(key);
      const projected: OrchestrationV2TurnItem = {
        type: "subagent", id: sourceItemId, subagentId: agent.id, threadId, runId: leadingRun,
        nodeId: null, providerThreadId: null, providerTurnId: null, parentItemId: null,
        nativeItemRef: agent.nativeTaskRef, ordinal: 0,
        origin: agent.origin, driver: agent.driver, providerInstanceId: agent.providerInstanceId,
        childThreadId: agent.childThreadId, remoteChild: agent.remoteChild,
        title: agent.title, prompt: agent.prompt, progress: agent.progress, result: agent.result,
        status: agent.status, startedAt: agent.startedAt, completedAt: agent.completedAt, updatedAt: agent.updatedAt,
      };
      subagentByItem.set(projected, agent);
      return [{ sourceItemId, sourceThreadId: threadId, position: 0, visibility: "local", item: projected }];
    }
    // Ordinary calls use the same activity projection and disclosures as T3.
    if (item.kind === "tool") {
      const viewedImage = item.viewedImagePath ?? viewedImagePath(item.toolName, item.input, item.status);
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
      const toolItem = (input: string | null, body = toolFeedBody(item.toolName, input), output = item.errorHead): OrchestrationV2TurnItem =>
        body.type === "command_execution"
          ? { ...base, ...body, ...(output && { output }) }
          : { ...base, ...body, output, ...(viewedImage && { viewedImagePath: viewedImage }) };
      const projected = toolItem(item.input, saved?.type === "command_execution" || saved?.type === "dynamic_tool" ? saved : undefined);
      const detailKey = item.toolInputKey;
      let detail: Promise<OrchestrationV2TurnItem> | undefined;
      const loadHostDetail = detailKey || item.report || item.childCount || item.leftOut?.length || item.secretOutcomes?.length
        ? () => detail ??= (detailKey ? readToolInput(detailKey) : Promise.resolve(item.input))
            .then(input => toolItem(input, undefined, toolReply(item)))
            .catch(error => {
              detail = undefined;
              throw error;
            })
        : undefined;
      const rows: ThreadFeedSourceRow[] = [
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
            ...(hasInlineToolResult(item) && { renderResult: () => renderCard(key) }),
          },
        },
      ];
      // On completion only a mounted app needs the live row for the handoff.
      if (mcpAppLiveToolName(item.toolName) && (item.status === "running" || isLiveAppHeld?.(item.toolId))) {
        rows.push({ hostEntries: [{
          type: "conversation-card", id: key + ":app", runId: null, createdAt,
          render: () => renderCard(key, true),
        }] });
      }
      return rows;
    }
    const card: RawThreadFeedEntry = {
      type: "conversation-card",
      id: key,
      createdAt,
      runId: leadingRun,
      render: () => renderCard(key),
    };
    if (item.kind !== "user" && item.kind !== "assistant") {
      return [{ hostEntries: [card] }];
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
    };
    const row: ThreadFeedSourceRow = {
      hostTime: createdAt,
      hostBackgroundCommand: item.kind === "user" ? item.backgroundCommand : undefined,
      ...(item.kind === "assistant" && item.forkPointId && { hostForkPointId: item.forkPointId }),
      ...(item.kind === "assistant" && item.replyHtmlLayout && { replyHtmlLayout: item.replyHtmlLayout }),
      sourceItemId: base.id,
      sourceThreadId: ThreadId.make(item.sourceSessionId ?? id),
      position: 0,
      visibility: "local",
      item:
        item.kind === "assistant"
          ? { ...base, ...(saved?.type === "assistant_message" ? saved : { type: "assistant_message" as const, text: item.text, streaming }) }
          : {
              ...base,
              ...projectedUserBody(item),
              attachments: messageAttachments(item.sourceSessionId ?? id, key, item.attachments, resolveImagePath),
            },
    };
    if (item.kind === "user" && !item.sender && row.item?.type === "user_message") {
      const monitor = (saved?.type === "user_message" && saved.notification) || watchNotification(item.text, item.via);
      if (monitor && !item.attachments.length) {
        const notification = { ...monitor, detail: item.text };
        const activity = { ...base, type: "notification" as const, ...notification };
        monitorMessages.set(activity, { message: row.item, notification });
        return [{ ...row, item: activity }];
      }
    }
    return item.kind === "user" &&
      item.delivery === "failed"
      ? [row, { hostEntries: [{ ...card, id: key + ":attachments" }] }]
      : [row];
  };
  const feedCache = createThreadFeedCache();
  return (order: readonly string[]) => {
    const observed = new Map<string, NonNullable<ReturnType<ConversationStore["item"]>>>();
    const rows = new Map<string, ThreadFeedSourceRow[]>();
    const leadingTools = new Set<string>();
    let hasPrompt = false;
    for (const key of order) {
      const item = store.item(key);
      if (item?.kind === "user") hasPrompt = true;
      if (!hasPrompt && (item?.kind === "tool" || item?.kind === "agent")) leadingTools.add(key);
    }
    const update = (key: string) => {
      const item = store.item(key);
      if (!item) return;
      if (item.kind === "setup" || item.kind === "compaction" || item.kind === "notice" || item.kind === "agent" || item.kind === "tool" || item.kind === "user" || item.kind === "assistant")
        observed.set(key, item);
      const leadingRun = leadingTools.has(key) ? RunId.make("leading-work:" + order[0]) : null;
      let held = cache.get(item);
      if (!held || held.leadingRun !== leadingRun) {
        held = { leadingRun, sources: project(key, item, leadingRun) };
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
    const messageOf = (item: OrchestrationV2TurnItem): OrchestrationV2ConversationMessage | null => {
      const monitor = monitorMessages.get(item);
      if (monitor) item = monitor.message;
      if (item.type !== "user_message" && item.type !== "assistant_message") return null;
      return {
        id: item.messageId, threadId, runId: item.runId, nodeId: item.nodeId,
        role: item.type === "assistant_message" ? "assistant" : "user",
        ...(monitor && { notification: monitor.notification }),
        text: item.text, streaming: item.type === "assistant_message" && item.streaming,
        createdAt: item.startedAt ?? item.updatedAt, updatedAt: item.updatedAt,
        createdBy: item.type === "assistant_message" ? "agent" : item.createdBy,
        creationSource: item.type === "user_message" ? item.creationSource : "provider",
        ...(item.type === "user_message" && { senderThreadId: item.senderThreadId, scheduledTaskId: item.scheduledTaskId }),
        attachments: item.type === "user_message" ? item.attachments : [],
      };
    };
    const buildProjection = (shell: OrchestrationV2ThreadShell): OrchestrationV2ThreadProjection => {
      const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = [];
      const subagents: OrchestrationV2Subagent[] = [];
      const messages: OrchestrationV2ConversationMessage[] = [];
      const turnItems: OrchestrationV2TurnItem[] = [];
      sources.forEach((source) => {
        if (!source.item) return;
        if (source.item.type === "subagent") subagents.push(subagentByItem.get(source.item)!);
        const row = visibleTurnItems.length;
        const message = messageOf(source.item);
        visibleTurnItems.push({ ...source, position: row });
        turnItems.push(source.item);
        if (message) messages.push(message);
      });
      return {
        thread: { ...shell, lastVisitedAt: shell.lastVisitedAt ?? null },
        visibleTurnItems, messages, turnItems,
        runs: empty,
        attempts: empty,
        nodes: empty,
        subagents,
        providerSessions: empty,
        providerThreads: empty,
        providerTurns: empty,
        runtimeRequests: empty,
        plans: empty,
        checkpointScopes: empty,
        checkpoints: empty,
        contextHandoffs: empty,
        contextTransfers: empty,
        updatedAt: shell.updatedAt,
      };
    };
    let projection: OrchestrationV2ThreadProjection | null = null;
    let previousShell: OrchestrationV2ThreadShell | undefined;
    let sequence = 0;
    let snapshot = buildThreadFeed(sources, { cache: feedCache });
    return {
      get: () => snapshot,
      projection: (shell: OrchestrationV2ThreadShell) => {
        if (!projection) projection = buildProjection(shell);
        else if (shell !== previousShell) {
          projection = { ...projection, thread: { ...shell, lastVisitedAt: shell.lastVisitedAt ?? null }, updatedAt: shell.updatedAt };
        }
        previousShell = shell;
        return projection;
      },
      subscribe: (notify: () => void) => {
        const refresh = (keys: Iterable<string>) => {
          let rebuild = false;
          const changedOffsets: number[] = [];
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
              (!item.subagent || (item.completedAt === before.completedAt && item.progress === before.progress)) &&
              item.errorHead === before.errorHead &&
              item.images === before.images &&
              item.audio === before.audio &&
              !!item.progress?.message === !!before.progress?.message &&
              item.leftOut === before.leftOut &&
              item.secretOutcomes === before.secretOutcomes &&
              (item.subagent || (!item.children && !before.children)) &&
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
                changedOffsets.push(offset + index);
              });
            }
          }
          if (rebuild || patched) {
            // T3 records which slot changed. Its detail selectors can then update one
            // streamed item without scanning the history. Rebuild once for a batch
            // or a change in row shape, including inherited rows and Solus cards.
            const offset = changedOffsets.length === 1 ? changedOffsets[0] : undefined;
            const before = offset === undefined ? undefined : sources[offset];
            sources = rebuild ? collectSources() : patched!;
            const after = offset === undefined ? undefined : sources[offset];
            if (projection && !rebuild && before?.item && after?.item &&
                before.item.type === after.item.type && before.item.id === after.item.id &&
                after.sourceThreadId === threadId && after.visibility === "local") {
              const base = { threadId, occurredAt: projection.updatedAt };
              const message = messageOf(after.item);
              const agent = subagentByItem.get(after.item);
              if (agent) projection = applyOrchestrationV2ProjectionEvent(projection, {
                ...base, id: EventId.make(String(++sequence)), type: "subagent.updated", payload: agent,
              });
              if (message) projection = applyOrchestrationV2ProjectionEvent(projection, {
                ...base, id: EventId.make(String(++sequence)), type: "message.updated", payload: message,
              });
              projection = applyOrchestrationV2ProjectionEvent(projection, {
                ...base, id: EventId.make(String(++sequence)), type: "turn-item.updated", payload: after.item,
              });
            } else {
              projection = null;
            }
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
