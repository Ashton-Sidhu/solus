// Adapted from T3 Code worktree-setup-card.tsx (MIT, see UPSTREAM.md).
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { setupOutputWindow } from "@solus/contracts/setup-card";
import type { StatusCardState, StatusCardStep } from "@solus/contracts/types";

import { AppSheet } from "../../components/AppSheet";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { ConversationStore } from "../conversation/conversation-store";
import { ShimmeringWorkContent } from "./thread-work-log";
import { useTranscriptItem } from "./use-transcript-items";

/**
 * The host's setup before a run starts, as one card that updates in place.
 * Details opens the stages, the last output lines, and the actions: retry or
 * work locally after a failure, cancel while setup runs.
 */
export function WorktreeSetupCard({ store, id }: { store: ConversationStore; id: string }) {
  const item = useTranscriptItem(store, id);
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (item?.kind !== "setup") return null;
  const { card } = item;
  const isActive = card.status === "active";
  const isWorktree = card.icon === "git-branch";
  const setupTitle = isWorktree ? "Worktree setup" : card.title;
  const title = isActive && isWorktree ? "Setting up worktree…" : card.title;
  return (
    <View accessibilityLabel={setupTitle} className="py-1">
      <View className="min-h-11 flex-row items-center gap-2 border-b border-border px-1">
        {isActive && !detailsOpen ? (
          <ShimmeringWorkContent icon="clock" iconSubtleColor="transparent" label={title} showIcon={false} />
        ) : (
          <Text numberOfLines={1} className={card.status === "error" ? "flex-1 text-sm text-danger-foreground" : "flex-1 text-sm text-foreground-secondary"}>
            {title}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${setupTitle} details`}
          accessibilityState={{ expanded: detailsOpen }}
          onPress={() => setDetailsOpen(true)}
          className="min-h-11 max-w-[55%] justify-center px-2"
        >
          <View className="flex-row items-center gap-1">
            {card.status === "error" ? <SymbolView name="exclamationmark.circle" size={12} tintColorClassName="accent-danger-foreground" /> : null}
            <Text numberOfLines={1} className="shrink text-2xs text-foreground-secondary">Details</Text>
            <SymbolView name="chevron.right" size={10} tintColorClassName="accent-icon-muted" />
          </View>
        </Pressable>
      </View>
      {card.status !== "done" ? (
        <View className="pt-1 pb-2">
          {card.steps.map((step) => <StageRow key={step.id} step={step} compact animate={!detailsOpen} />)}
        </View>
      ) : null}
      {detailsOpen ? (
        <AppSheet title={setupTitle} onClose={() => setDetailsOpen(false)}>
          <SetupDetails store={store} id={id} card={card} />
        </AppSheet>
      ) : null}
    </View>
  );
}

function SetupDetails({ store, id, card }: { store: ConversationStore; id: string; card: StatusCardState }) {
  const [isRecovering, setIsRecovering] = useState(false);
  const isError = card.status === "error";
  const canRecover = isError && card.recovery === "worktree" && store.controller.mayDrive;
  const recover = (workLocally: boolean) => {
    setIsRecovering(true);
    void store.controller.recoverWorktreeSetup(id, workLocally).finally(() => setIsRecovering(false));
  };
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-5 pb-8">
      {card.steps.map((step) => <StageRow key={step.id} step={step} />)}
      {card.steps.filter((step) => step.status === "error" && step.detail).map((step) => (
        <Text key={`${step.id}:error`} selectable className="mt-2 ml-8 text-xs text-danger-foreground">{step.detail}</Text>
      ))}
      {card.output?.length ? (
        // The last four lines, in a window that does not change height.
        <View
          accessibilityLabel="Setup output"
          className={isError ? "mb-2 ml-8 rounded-md border border-danger-border bg-danger px-3 py-2" : "mb-2 ml-8 rounded-md border border-border bg-card-alt px-3 py-2"}
        >
          {setupOutputWindow(card.output).map((line, slot) => (
            <Text
              key={slot}
              selectable
              numberOfLines={1}
              className={isError
                ? "text-2xs leading-5 text-danger-foreground ios:font-[family-name:Menlo] android:font-mono"
                : "text-2xs leading-5 text-foreground-secondary ios:font-[family-name:Menlo] android:font-mono"}
            >
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {canRecover ? (
        <View className="flex-row gap-2">
          <Pressable accessibilityRole="button" disabled={isRecovering} onPress={() => recover(false)} className="min-h-11 flex-1 items-center justify-center rounded-full bg-subtle disabled:opacity-40">
            <Text className="text-sm text-foreground">Retry setup</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={isRecovering} onPress={() => recover(true)} className="min-h-11 flex-1 items-center justify-center rounded-full bg-subtle disabled:opacity-40">
            <Text className="text-sm text-foreground">Work locally</Text>
          </Pressable>
        </View>
      ) : null}
      {card.status === "active" && store.controller.mayDrive ? (
        <Pressable accessibilityRole="button" onPress={() => void store.controller.stop()} className="min-h-11 items-center justify-center rounded-full bg-subtle">
          <Text className="text-sm text-danger-foreground">Cancel setup</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function StageRow({ step, compact = false, animate = true }: { step: StatusCardStep; compact?: boolean; animate?: boolean }) {
  const isRunning = step.status === "active" && animate;
  const symbol = step.status === "done" ? "checkmark" : step.status === "error" ? "xmark" : step.status === "active" ? "clock" : "circle";
  return (
    <View
      accessibilityLabel={`${step.label}, ${step.status}`}
      className={compact ? "min-h-8 flex-row items-center" : "min-h-11 flex-row items-center"}
      style={{ columnGap: 8, opacity: step.status === "pending" ? 0.4 : 1 }}
    >
      <View className="w-6 items-center">
        {isRunning ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.75 }] }} />
        ) : (
          <SymbolView name={symbol} size={14} tintColorClassName={step.status === "error" ? "accent-danger-foreground" : "accent-icon-muted"} />
        )}
      </View>
      {isRunning ? (
        <ShimmeringWorkContent icon="clock" iconSubtleColor="transparent" label={step.label} showIcon={false} />
      ) : (
        <Text numberOfLines={1} className={step.status === "error" ? "flex-1 text-sm text-danger-foreground" : "flex-1 text-sm text-foreground-secondary"}>
          {step.label}
        </Text>
      )}
      {step.detail ? <Text numberOfLines={1} className="max-w-[25%] shrink text-2xs text-foreground-secondary">{step.detail}</Text> : null}
    </View>
  );
}
