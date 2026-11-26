import { useState, type ReactNode } from "react";
import { useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import { mayWorkLocallyDuringSetup } from "@solus/contracts/setup-card";
import { RequestActionButton } from "@solus-mobile/features/threads/RequestActionButton";
import { compactionDividerText } from "@solus/contracts/context-compaction";
import { browserSnapshotLabel } from "@solus/client-core/browser-snapshot-label";
import { handoffDividerText } from "@solus-mobile/features/conversation/lib/provider-handoff";
import { EnvironmentId } from "@t3tools/contracts";
import { useTranscriptItem } from "@solus-mobile/features/threads/use-transcript-items";
import {
  toolFullDetail,
  toolRowLabel,
} from "@solus-mobile/features/threads/thread-work-log-presentation";
import { ThreadMcpApp } from "@solus-mobile/features/threads/ThreadMcpApp";
import { WorktreeOfferCard } from "@solus-mobile/features/threads/WorktreeOfferCard";
import { ThreadToolAudio } from "@solus-mobile/features/threads/ThreadToolAudio";
import { AppText } from "../components/ui/AppText";
import {
  stateMarkLabel,
  subagentStateMark,
  toolStateMark,
  type StateMark,
} from "../features/threads/state-marks";
import { StateMarkView } from "../features/threads/StateMark";
import { ConversationMedia, conversationImageSource } from "./ConversationMedia";
import { PlanCard } from "./PlanCard";

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

export function ConversationCard({ store, id }: { store: ConversationStore; id: string }) {
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
      return null; // The upstream feed renders the saved version as an `html_render` row.
    case "mcp_app":
      return <ThreadMcpApp store={store} id={id} />;
    case "tool":
      return <ToolCard item={item} store={store} />;
    case "agent":
      return null; // T3 renders the child session in a subagent group.
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
          label={browserSnapshotLabel(item.snapshot)}
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
            <View key={step.id}>
              <AppText>
                {[
                  step.label,
                  step.status,
                  step.percent !== undefined ? step.percent + "%" : null,
                  step.detail,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </AppText>
              {/* The part of each repository in a step of several repositories. */}
              {step.substeps?.map((substep) => (
                <AppText key={substep.id} className="pl-4 text-foreground-secondary">
                  {[substep.label, substep.status, substep.detail].filter(Boolean).join(" · ")}
                </AppText>
              ))}
            </View>
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
