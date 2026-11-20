// Adapted from T3 Code worktree-setup-card.tsx (MIT, see UPSTREAM.md).
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { formatStepDuration, mayWorkLocallyDuringSetup, setupOutputTail, stepDurationMs } from "@solus/contracts/setup-card";
import type { StatusCardState, StatusCardStep } from "@solus/contracts/types";
import { seatProviderSchema } from "@solus/contracts/seats";
import { isSessionSyncCard, sessionSyncCardView, sessionSyncFailureText, type SessionSyncCardNames } from "@solus/client-core/session-sync-card";

import { AppSheet } from "../../components/AppSheet";
import { TerminalOutput } from "../../components/TerminalOutput";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useApp, useListened } from "../../app/app-context";
import { conversationIdOf, type ConversationStore } from "../conversation/conversation-store";
import { useRunHostRow } from "./ThreadRunHostRow";
import { ShimmeringWorkContent } from "./thread-work-log";
import { useTranscriptItem } from "./use-transcript-items";

/**
 * The host's setup before a run starts, as one card that updates in place.
 * Details opens the stages, the last output lines, and the actions: retry or
 * work locally after a failure; cancel, or work locally while the worktree is made.
 */
export function WorktreeSetupCard({ store, id }: { store: ConversationStore; id: string }) {
  const item = useTranscriptItem(store, id);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const syncNames = useSessionSyncNames(store);
  if (item?.kind !== "setup") return null;
  // A sync card speaks in host ids; it shows with the hosts' names and plain step labels.
  const isSync = isSessionSyncCard(item.card);
  const card = isSync ? sessionSyncCardView(item.card, syncNames) : item.card;
  const syncFailure = isSync && card.status === "error" && card.syncFailureReason ? card.syncFailureReason : null;
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
          {card.steps.map((step) => (
            // A failed sync says why in full below, not cut short in its row.
            <StageRow key={step.id} step={syncFailure ? { ...step, detail: undefined } : step} compact animate={!detailsOpen} />
          ))}
          {syncFailure ? <SessionSyncFailure store={store} names={syncNames} message={sessionSyncFailureText(syncFailure, syncNames)} /> : null}
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

/**
 * The names a session's sync card speaks in: the host it syncs to (this one),
 * the host with its newest turn, and the agent.
 */
function useSessionSyncNames(store: ConversationStore): SessionSyncCardNames {
  const app = useApp();
  const runHostId = store.controller.hostId;
  const sessionId = conversationIdOf(store);
  const sourceHostId = useListened(app.runHosts.changes, () => {
    const newest = app.runHosts.newestHostOf(sessionId, runHostId);
    return newest && newest !== runHostId ? newest : store.controller.target.movedFrom ?? null;
  });
  const labelOf = (hostId: string | null) => (hostId ? app.registry.host(hostId)?.label : undefined);
  return {
    runHost: labelOf(runHostId) ?? "this host",
    sourceHost: labelOf(sourceHostId) ?? "the other host",
    provider: store.controller.run.provider === "codex" ? "Codex" : "Claude",
  };
}

/** Why a sync failed, and the one thing that fixes it here. */
function SessionSyncFailure(props: {
  readonly store: ConversationStore;
  readonly names: SessionSyncCardNames;
  readonly message: ReturnType<typeof sessionSyncFailureText>;
}) {
  const { store, message } = props;
  const meta = useListened(store.meta, store.metaSnapshotOf);
  const hostRow = useRunHostRow(store, meta);
  const seat = seatProviderSchema.safeParse(store.controller.run.provider);
  const canChooseHost = message.action === "choose-host" && hostRow.isShown && !hostRow.isLocked;
  const canConnectSeat = message.action === "connect-seat" && seat.success && store.controller.mayDrive;
  return (
    <View className="gap-2 pt-1 pl-8">
      <Text selectable className="text-xs text-danger-foreground">{message.message}</Text>
      {canChooseHost || canConnectSeat ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (canChooseHost) store.requestHostChoice();
            else if (seat.success) void store.controller.auth.run({ kind: "login", provider: seat.data }, store.controller.run.workingDirectory);
          }}
          className="min-h-11 items-center justify-center self-start rounded-full bg-subtle px-4"
        >
          <Text className="text-sm text-foreground">{canChooseHost ? "Choose a host" : `Connect ${props.names.provider}`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SetupDetails({ store, id, card }: { store: ConversationStore; id: string; card: StatusCardState }) {
  const [isRecovering, setIsRecovering] = useState(false);
  const isError = card.status === "error";
  const canRecover = isError && card.recovery === "worktree" && store.controller.mayDrive;
  const canWorkLocally = mayWorkLocallyDuringSetup(card) && store.controller.mayDrive;
  const recover = (workLocally: boolean) => {
    setIsRecovering(true);
    void store.controller.recoverWorktreeSetup(id, workLocally).finally(() => setIsRecovering(false));
  };
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-5 pb-8">
      {card.steps.map((step) => <StageRow key={step.id} step={step} />)}
      {card.steps.filter((step) => (step.status === "error" || step.status === "warning") && step.detail).map((step) => (
        <Text
          key={`${step.id}:${step.status}`}
          selectable
          className={step.status === "error" ? "mt-2 ml-8 text-xs text-danger-foreground" : "mt-2 ml-8 text-xs text-warning-foreground"}
        >
          {step.detail}
        </Text>
      ))}
      {card.output?.length ? (
        // The end of the host's output, in the terminal panel every command output uses.
        <View className="mb-2 ml-8">
          <TerminalOutput output={setupOutputTail(card.output)} label="Setup output" maxHeight={192} />
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
        <View className="flex-row gap-2">
          {canWorkLocally ? (
            <Pressable accessibilityRole="button" disabled={isRecovering} onPress={() => recover(true)} className="min-h-11 flex-1 items-center justify-center rounded-full bg-subtle disabled:opacity-40">
              <Text className="text-sm text-foreground">Work locally</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => void store.controller.stop()} className="min-h-11 flex-1 items-center justify-center rounded-full bg-subtle">
            <Text className="text-sm text-danger-foreground">Cancel setup</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

/** One step of a setup card; adding a machine over SSH draws its steps with it too. */
export function StageRow({ step, compact = false, animate = true }: { step: StatusCardStep; compact?: boolean; animate?: boolean }) {
  const isRunning = step.status === "active" && animate;
  const symbol = step.status === "done" ? "checkmark"
    : step.status === "error" ? "xmark"
    : step.status === "warning" ? "exclamationmark.triangle"
    : step.status === "skipped" ? "minus"
    : step.status === "active" ? "clock" : "circle";
  const trailing = stageTrailing(step);
  return (
    <View
      accessibilityLabel={`${step.label}, ${step.status}`}
      className={compact ? "min-h-8 flex-row items-center" : "min-h-11 flex-row items-center"}
      style={{ columnGap: 8, opacity: step.status === "pending" || step.status === "skipped" ? 0.4 : 1 }}
    >
      <View className="w-6 items-center">
        {isRunning ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.75 }] }} />
        ) : (
          <SymbolView
            name={symbol}
            size={14}
            tintColorClassName={step.status === "error" ? "accent-danger-foreground" : step.status === "warning" ? "accent-warning-foreground" : "accent-icon-muted"}
          />
        )}
      </View>
      {isRunning ? (
        <ShimmeringWorkContent icon="clock" iconSubtleColor="transparent" label={step.label} showIcon={false} />
      ) : (
        <Text numberOfLines={1} className={step.status === "error" ? "flex-1 text-sm text-danger-foreground" : "flex-1 text-sm text-foreground-secondary"}>
          {step.label}
        </Text>
      )}
      {step.detail ? <Text numberOfLines={1} className="max-w-[25%] shrink text-2xs text-foreground-secondary">{step.detail}</Text>
        : trailing ? <Text numberOfLines={1} className="shrink-0 text-2xs text-foreground-secondary">{trailing}</Text>
        : null}
    </View>
  );
}

/** The short text at the end of a stage row: its percentage while it runs, or
 *  how long it took by the host's clock. */
function stageTrailing(step: StatusCardStep): string | null {
  if (step.status === "active") return step.percent === undefined ? null : `${step.percent}%`;
  if (step.status === "skipped") return "skipped";
  const durationMs = stepDurationMs(step);
  return durationMs ? formatStepDuration(durationMs) : null;
}
