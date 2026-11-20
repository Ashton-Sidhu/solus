import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { AppSheet } from "../../components/AppSheet";
import { AppText as Text } from "../../components/AppText";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ListChoiceRow } from "../../components/ListChoiceRow";
import { conversationIdOf, type ConversationMeta, type ConversationStore } from "../conversation/conversation-store";
import { hostMachineKind } from "./NewTaskContextPickerScreens";
import { sessionCloudState, type SessionCloudState } from "@solus/client-core/session-cloud-state";
import { runHostRowNote, runHostRowView, type RunHostRowView } from "./lib/run-host-row";

/** The host control of a started session, from what this device knows now. */
export function useRunHostRow(store: ConversationStore, meta: ConversationMeta): RunHostRowView {
  const app = useApp();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  // A string, so an unrelated connection change does not draw the row again.
  const readiness = useListened(app.connections.changes, () =>
    hosts.map((host) => {
      const state = app.connections.readiness(host.id);
      return `${state.readiness}:${state.away}`;
    }).join("\n"),
  );
  const runHostId = store.controller.hostId;
  const sessionId = conversationIdOf(store);
  const newestHostId = useListened(app.runHosts.changes, () => app.runHosts.newestHostOf(sessionId, runHostId));
  // Text, so a snapshot compares by value; the host facts and the cloud facts each change it.
  const readCloudState = () => JSON.stringify(sessionCloudState({
    runServerId: runHostId,
    turns: app.runHosts.turnsFor(sessionId),
    cloud: app.cloudSessions.headFor(sessionId),
    runningServerId: app.cloudSessions.runningHostFor(sessionId),
    wasPromptRefused: meta.isSessionDiverged,
  }));
  useListened(app.runHosts.changes, readCloudState);
  const cloudStateText = useListened(app.cloudSessions.changes, readCloudState);
  const isStarted = store.controller.target.record !== undefined;
  const { mayDrive } = store.controller;
  const hasAttachments = meta.attachments.length + meta.uploading > 0;
  return useMemo(() => {
    const states = readiness.split("\n");
    return runHostRowView({
      // SAFETY: the text is `JSON.stringify` of a `sessionCloudState` answer, made above.
      cloudState: JSON.parse(cloudStateText) as SessionCloudState | null,
      runHostId,
      isStarted,
      mayDrive,
      status: meta.status,
      backgroundWorkRunning: meta.backgroundWorkRunning,
      hasUnsentPrompts: meta.hasUnsentPrompts,
      hasAttachments,
      newestHostId,
      hosts: hosts.map((host, index) => {
        const [state, away] = (states[index] ?? "").split(":");
        return { hostId: host.id, label: host.label, isReady: state === "ready", isAway: away === "true" };
      }),
    });
  }, [cloudStateText, hasAttachments, hosts, isStarted, mayDrive, meta.backgroundWorkRunning, meta.hasUnsentPrompts, meta.status, newestHostId, readiness, runHostId]);
}

/**
 * The conversation a prompt goes to while another host runs a turn of the
 * session (plan §4 decision 5): that host's, which opens at once. Undefined
 * sends it here.
 */
export function useRunningHostSend(
  store: ConversationStore,
  view: RunHostRowView,
  onFollowHost: ((hostId: string) => ConversationStore | null) | undefined,
): (() => ConversationStore) | undefined {
  const { runningHostId } = view;
  return useMemo(
    () => (runningHostId && onFollowHost ? () => onFollowHost(runningHostId) ?? store : undefined),
    [onFollowHost, runningHostId, store],
  );
}

/**
 * The host that runs the next prompt of a started session, under the
 * composer's toolbar: a pick moves the conversation there at once, and that
 * host gets the session in the background (docs/plans/portable-sessions.md
 * §10). Beside it, "<host> is offline" when the host with the newest turn is away.
 */
export function ThreadRunHostRow(props: {
  readonly store: ConversationStore;
  readonly view: RunHostRowView;
  /** Absent for a session the host does not know yet: it has no host to change. */
  readonly onChooseHost: ((hostId: string) => void) | undefined;
  /** The sheet closed: the composer takes focus back. */
  readonly onClosed: () => void;
}) {
  const app = useApp();
  const { store, view } = props;
  const [isChoosing, setChoosing] = useState(false);
  // "Choose a host" on a failed sync card opens the same choice.
  useEffect(() => store.onHostChoiceRequested(() => setChoosing(true)), [store]);
  const note = runHostRowNote(view);
  const { onChooseHost } = props;
  // The cloud's words show with no other host to choose too ("Not synced yet").
  if (!onChooseHost || (!view.isShown && !note)) return null;
  const runHost = app.registry.host(store.controller.hostId);
  return (
    <View className="flex-row items-center gap-2 px-4">
      {view.isShown ? (
        <ComposerInlineControl
          accessibilityLabel={`Host: ${view.runHostLabel}`}
          accessibilityHint={view.isLocked ? "Available when the agent is not working" : "Chooses the host that runs the next prompt"}
          chevronDirection="down"
          disabled={view.isLocked}
          label={`on ${view.runHostLabel}`}
          maxWidth={220}
          onPress={() => setChoosing(true)}
          renderIcon={(size) => (
            <EnvironmentMachineSymbol kind={hostMachineKind(runHost?.os)} size={size} tintColorClassName="accent-icon-muted" />
          )}
          showChevron
        />
      ) : null}
      {note ? (
        <Text
          accessibilityLiveRegion="polite"
          className={note === view.cloudNote ? "min-w-0 shrink text-xs text-foreground-secondary" : "min-w-0 shrink text-xs text-warning-foreground"}
          numberOfLines={1}
        >
          {note}
        </Text>
      ) : null}
      {isChoosing ? (
        <AppSheet
          title="Run on"
          onClose={() => {
            setChoosing(false);
            props.onClosed();
          }}
        >
          <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="pb-8">
            {view.choices.map((choice, index) => (
              <ListChoiceRow
                key={choice.hostId}
                label={choice.label}
                description={choice.hostId === store.controller.hostId ? "Runs the next prompt" : choice.isReady ? undefined : "Offline"}
                selected={choice.hostId === store.controller.hostId}
                disabled={view.isLocked || !choice.isReady}
                separated={index > 0}
                onPress={() => {
                  setChoosing(false);
                  if (choice.hostId !== store.controller.hostId) onChooseHost(choice.hostId);
                  props.onClosed();
                }}
              />
            ))}
          </ScrollView>
        </AppSheet>
      ) : null}
    </View>
  );
}
