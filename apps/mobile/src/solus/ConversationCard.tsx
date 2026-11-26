import { useState, type ReactNode } from "react";
import { useMessages } from "gt-react-native";
import { View } from "react-native";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import type { TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";
import { mayWorkLocallyDuringSetup } from "@solus/contracts/setup-card";
import { RequestActionButton } from "@solus-mobile/features/threads/RequestActionButton";
import { WorkLogBlock, WorkLogIconSlot, WorkLogLabel, WorkLogPressable } from "../features/threads/work-log-layout";
import { SymbolView } from "../components/ui/AppSymbol";
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
  icon = "terminal",
  mark,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: "terminal" | "server.rack" | "arrow.triangle.branch";
  /** The state mark of the agent or call (docs/plans/session-state-marks.md). */
  mark?: { state: StateMark; environmentId: EnvironmentId } | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const messages = useMessages();
  return (
    <WorkLogBlock>
      <WorkLogPressable
        accessibilityRole="button"
        accessibilityLabel={
          mark
            ? [title, stateMarkLabel(mark.state, messages), subtitle].filter(Boolean).join(", ")
            : undefined
        }
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <WorkLogIconSlot>
          {mark ? <StateMarkView mark={mark.state} environmentId={mark.environmentId} />
            : <SymbolView name={icon} size={14} tintColorClassName="accent-icon-muted" />}
        </WorkLogIconSlot>
        <WorkLogLabel>{title}</WorkLogLabel>
        <SymbolView name={open ? "chevron.up" : "chevron.down"} size={11} tintColorClassName="accent-icon-muted" />
      </WorkLogPressable>
      {open && <View className="ml-7 gap-2 pb-2">
        {subtitle ? <AppText className="text-xs text-foreground-muted">{subtitle}</AppText> : null}
        {children}
      </View>}
    </WorkLogBlock>
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
    case "compaction":
      return null; // The upstream work log renders the activity.
    case "plan":
      return <PlanCard store={store} plan={item} history />;
    case "worktree_offer":
      return <WorktreeOfferCard store={store} offer={item} />;
    case "setup":
      return (
        <Details title={item.card.title} subtitle={item.card.status} icon={item.card.icon === "git-branch" ? "arrow.triangle.branch" : "server.rack"}>
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
