import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { msg, useMessages } from "gt-react-native";
import { modelLabelFor, REASONING_EFFORT_LABELS } from "@solus/contracts/types";
import { PROVIDERS } from "@solus/contracts/provider-model-settings";
import { formatModelSlugName } from "@t3tools/shared/model";
import { ProviderIcon } from "../components/ProviderIcon";
import { modelInstanceId } from "./model-picker-catalog";
import { agentCardStatus } from "@solus-mobile/features/conversation/lib/agent-cards";
import { Alert, Pressable, View } from "react-native";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import { mayWorkLocallyDuringSetup } from "@solus/contracts/setup-card";
import { RequestActionButton } from "@solus-mobile/features/threads/RequestActionButton";
import { compactionDividerText } from "@solus/contracts/context-compaction";
import { handoffDividerText } from "@solus-mobile/features/conversation/lib/provider-handoff";
import { rememberSession } from "./session-record";
import { threadKey } from "@solus-mobile/features/threads/thread-directory";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useOpenLinkedThread, useOpenLinkedThreadRead } from "../features/threads/useOpenLinkedThread";
import { useTranscriptItem } from "@solus-mobile/features/threads/use-transcript-items";
import {
  toolFullDetail,
  toolRowLabel,
} from "@solus-mobile/features/threads/thread-work-log-presentation";
import { InlineHtmlRender } from "../features/threads/HtmlRenderWebView";
import { workHistoryKey } from "@solus/client-core/person-history";
import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { ThreadMcpApp } from "@solus-mobile/features/threads/ThreadMcpApp";
import { WorktreeOfferCard } from "@solus-mobile/features/threads/WorktreeOfferCard";
import { ThreadToolAudio } from "@solus-mobile/features/threads/ThreadToolAudio";
import { AppText } from "../components/ui/AppText";
import {
  startedSessionStateMark,
  stateMarkLabel,
  subagentStateMark,
  toolStateMark,
  type StateMark,
} from "../features/threads/state-marks";
import { StateMarkView } from "../features/threads/StateMark";
import { ConversationMedia, conversationImageSource } from "./ConversationMedia";
import { PlanCard } from "./PlanCard";
import { solus } from "./runtime";

function Details({
  title,
  subtitle,
  mark,
  children,
}: {
  title: string;
  subtitle?: string;
  /** The state mark of the agent or call (docs/plans/session-state-marks.md). */
  mark?: { state: StateMark; environmentId: EnvironmentId } | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const messages = useMessages();
  return (
    <View className="mb-2 gap-2 rounded-2xl border border-border bg-card p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          mark
            ? [title, stateMarkLabel(mark.state, messages), subtitle].filter(Boolean).join(", ")
            : undefined
        }
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <View className="flex-row items-center gap-2">
          <AppText className="min-w-0 shrink font-medium">{title}</AppText>
          {mark ? <StateMarkView mark={mark.state} environmentId={mark.environmentId} /> : null}
        </View>
        {subtitle ? <AppText className="text-xs text-foreground-muted">{subtitle}</AppText> : null}
      </Pressable>
      {open && children}
    </View>
  );
}

function AgentCard({
  store,
  item,
}: {
  store: ConversationStore;
  item: Extract<TranscriptItem, { kind: "agent" }>;
}) {
  const openThread = useOpenLinkedThread();
  const openLinked = useOpenLinkedThreadRead();
  const [loading, setLoading] = useState(false);
  const hostId = store.controller.hostId;
  const messages = useMessages();
  const agent = useSyncExternalStore(store.meta.subscribe, () =>
    item.serverId && item.serverId !== hostId ? undefined :
      store.metaSnapshotOf().runOptions.agents?.find(({ id }) => id === item.provider),
  );
  const provider = agent?.label ?? PROVIDERS.find(({ id }) => id === item.provider)?.label ?? item.provider;
  const model = agent?.models.find(({ id }) => id === item.model)?.label
    ?? (item.model && agent?.modelProfiles?.[item.model]?.label)
    ?? modelLabelFor(item.provider, item.model);
  const modelName = model && model === item.model ? formatModelSlugName(model) : model;
  const effort = Object.entries(REASONING_EFFORT_LABELS).find(([id]) => id === item.reasoningEffort)?.[1] ?? item.reasoningEffort;
  // The started session's own live facts, as its thread row reads them.
  const key = threadKey(item.serverId ?? hostId, item.sessionId);
  const activity = useSyncExternalStore(solus.threadList.changes.subscribe, () =>
    solus.threadList.facts().agentActivity?.get(key),
  );
  const awaitingApproval = useSyncExternalStore(
    solus.threadList.changes.subscribe,
    () => solus.threadList.facts().awaitingApprovals?.has(key) === true,
  );
  const mark = startedSessionStateMark(agentCardStatus(item), item.startedAt, {
    activity,
    awaitingApproval,
  });
  const open = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const head = solus.cloudSessions.headFor(item.sessionId);
      const childHost = head?.lastRunServerId ?? head?.lastRunHostId ?? item.serverId ?? hostId;
      if (childHost !== hostId && solus.connections.state(childHost)?.readiness !== "ready") {
        openLinked({environmentId: EnvironmentId.make(childHost), threadId: ThreadId.make(item.sessionId)},
          {viaEnvironmentId: EnvironmentId.make(hostId), label: solus.registry.host(childHost)?.label ?? childHost}, item.title);
        return;
      }
      await rememberSession(childHost, item.sessionId);
      openThread({ environmentId: childHost, threadId: item.sessionId });
    } catch (error) {
      Alert.alert("Could not open session", error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  const title = item.title || "Agent session";
  const subtitle = [provider, modelName || messages(msg("Not reported")), effort].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessible
      accessibilityRole="link"
      accessibilityLabel={[title, stateMarkLabel(mark, messages), subtitle].join(", ")}
      accessibilityHint={messages(msg("Opens this agent's thread"))}
      accessibilityState={{ busy: loading, disabled: loading }}
      disabled={loading}
      onPress={() => void open()}
      className="mb-2 gap-1 rounded-2xl border border-border bg-card p-3 active:bg-subtle"
    >
      <View className="flex-row items-center gap-2">
        <AppText className="min-w-0 shrink font-medium">{title}</AppText>
        <StateMarkView mark={mark} environmentId={EnvironmentId.make(hostId)} />
      </View>
      <View className="min-w-0 flex-row items-center gap-1.5">
        {item.provider && <ProviderIcon provider={modelInstanceId(item.provider)} size={12} />}
        <AppText numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">{subtitle}</AppText>
      </View>
    </Pressable>
  );
}

function ToolCard({
  store,
  item,
}: {
  store: ConversationStore;
  item: Extract<TranscriptItem, { kind: "tool" }>;
}) {
  const text = toolFullDetail(item);
  const mark = item.subagent ? subagentStateMark(item) : toolStateMark(item);
  return (
    <Details
      title={toolRowLabel(item)}
      subtitle={[item.toolName, item.progress?.message].filter(Boolean).join(" · ")}
      mark={mark && { state: mark, environmentId: EnvironmentId.make(store.controller.hostId) }}
    >
      {text && (
        <AppText selectable className="font-mono text-xs">
          {text}
        </AppText>
      )}
      {item.report && <AppText selectable>{item.report}</AppText>}
      {item.children?.order.map((id) => {
        const child = item.children?.items.get(id);
        if (child?.kind === "tool") return <ToolCard key={id} item={child} store={store} />;
        if (child?.kind === "assistant" || child?.kind === "notice" || child?.kind === "user")
          return (
            <AppText key={id} selectable>
              {child.text}
            </AppText>
          );
        return null;
      })}
      {item.images?.map((image, i) => (
        <ConversationMedia
          key={image.assetId}
          store={store}
          source={{ assetId: image.assetId }}
          label={`Tool image ${i + 1}`}
        />
      ))}
      {item.audio?.map((audio, i) => (
        <ThreadToolAudio
          key={audio.assetId}
          audio={audio}
          label={`Tool audio ${i + 1}`}
          store={store}
        />
      ))}
      {item.leftOut?.map((line, i) => (
        <AppText key={i}>{line}</AppText>
      ))}
      {!text &&
        !item.report &&
        !item.images?.length &&
        !item.audio?.length &&
        !item.leftOut?.length &&
        !item.childCount && (
          <AppText className="text-xs text-foreground-muted">
            {item.status === "running"
              ? "Waiting for the tool."
              : "The host supplied no further detail."}
          </AppText>
        )}
    </Details>
  );
}

function ArtifactCard({
  store,
  item,
  superseded,
}: {
  store: ConversationStore;
  item: Extract<TranscriptItem, { kind: "artifact" }>;
  superseded: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { workId } = item;
  const visible = !superseded || expanded;
  const pending = !item.html && !!item.contentVersion;
  const needsRead = visible && pending && !item.loading && !item.error;
  useEffect(() => {
    if (needsRead) void store.controller.ensureArtifact(item.id);
  }, [store, item.id, needsRead]);
  return (
    <View className="px-1">
      {superseded && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          className="min-h-11 justify-center"
          onPress={() => setExpanded(!expanded)}
        >
          <AppText className="text-sm text-foreground-secondary">
            {item.title} · earlier version
          </AppText>
        </Pressable>
      )}
      {visible &&
        (pending ? (
          item.error ? (
            <View className="min-h-28 items-center justify-center">
              <AppText accessibilityRole="alert">{item.error}</AppText>
              <RequestActionButton
                label="Try again"
                onPress={() => void store.controller.ensureArtifact(item.id)}
              />
            </View>
          ) : (
            <AppActivityIndicator accessibilityLabel="Loading artifact" />
          )
        ) : (
          <InlineHtmlRender html={item.html} title={item.title} onOpen={workId ? () => solus.history.record(workHistoryKey(workId)) : undefined} />
        ))}
    </View>
  );
}

export function ConversationCard({
  store,
  id,
  superseded = false,
}: {
  store: ConversationStore;
  id: string;
  superseded?: boolean;
}) {
  const item = useTranscriptItem(store, id);
  if (!item) return null;
  switch (item.kind) {
    case "fork": return null;
    case "user":
      return (
        <View>
          {item.delivery === "failed" && (
            <View>
              <AppText accessibilityRole="alert">{item.error ?? "Message failed to send."}</AppText>
              {store.controller.mayDrive && (
                <RequestActionButton
                  label="Retry message"
                  onPress={() => void store.controller.retry(item.id)}
                />
              )}
            </View>
          )}
        </View>
      );
    case "assistant":
      return null; // The upstream feed renders the message.
    case "artifact":
      return <ArtifactCard store={store} item={item} superseded={superseded} />;
    case "mcp_app":
      return <ThreadMcpApp store={store} id={id} />;
    case "tool":
      return <ToolCard item={item} store={store} />;
    case "agent":
      return <AgentCard item={item} store={store} />;
    case "image":
      return (
        <ConversationMedia
          store={store}
          label="Image"
          source={conversationImageSource(item.path)}
        />
      );
    case "browser_snapshot":
      return (
        <ConversationMedia
          store={store}
          label={item.snapshot.title || "Browser screenshot"}
          source={{ assetId: item.snapshot.assetId }}
        />
      );
    case "notice":
      return (
        <AppText
          accessibilityRole={item.tone === "error" ? "alert" : "text"}
          selectable
          className="my-2 text-sm text-foreground-secondary"
        >
          {item.text}
        </AppText>
      );
    case "plan":
      return <PlanCard store={store} plan={item} history />;
    case "worktree_offer":
      return <WorktreeOfferCard store={store} offer={item} />;
    case "setup":
      return (
        <Details title={item.card.title} subtitle={item.card.status}>
          {item.card.steps.map((step) => (
            <AppText key={step.id}>
              {[
                step.label,
                step.status,
                step.percent !== undefined ? step.percent + "%" : null,
                step.detail,
              ]
                .filter(Boolean)
                .join(" · ")}
            </AppText>
          ))}
          {item.card.output?.length ? (
            <AppText selectable className="font-mono text-xs">
              {item.card.output.join("\n")}
            </AppText>
          ) : null}
          {store.controller.mayDrive &&
            item.card.recovery === "worktree" &&
            item.card.status === "error" && (
              <RequestActionButton
                label="Retry setup"
                onPress={() => void store.controller.recoverWorktreeSetup(id, false)}
              />
            )}
          {store.controller.mayDrive &&
            (mayWorkLocallyDuringSetup(item.card) ||
              (item.card.status === "error" && item.card.recovery === "worktree")) && (
              <RequestActionButton
                label="Work locally"
                tone="secondary"
                onPress={() => void store.controller.recoverWorktreeSetup(id, true)}
              />
            )}
          {store.controller.mayDrive && item.card.status === "active" && (
            <RequestActionButton
              label="Cancel setup"
              tone="secondary"
              onPress={() => void store.controller.stop()}
            />
          )}
        </Details>
      );
    case "compaction": {
      const { label, detail } = compactionDividerText(item.compaction);
      return (
        <AppText className="my-2 text-xs text-foreground-muted">
          {[label, detail].filter(Boolean).join(" · ")}
        </AppText>
      );
    }
    case "handoff":
      return (
        <AppText className="my-2 text-xs text-foreground-muted">
          {handoffDividerText(item.activity)}
        </AppText>
      );
    default:
      return item satisfies never;
  }
}
