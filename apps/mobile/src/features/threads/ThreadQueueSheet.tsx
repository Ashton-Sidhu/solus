// Adapted from T3 Code apps/mobile/src/features/threads/ThreadQueueControl.tsx (MIT, see UPSTREAM.md).
// T3's `ThreadQueue` form-sheet route and its header frame. Edit opens the
// message in the thread's composer, as T3; Move up and Move down replace dragging.
import { isSteerableStatus, modelLabelFor, type QueuedPromptSnapshot } from "@solus/contracts/types";
import type { SessionQueueMutation } from "@solus/contracts/session-queue";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { MaterialButton } from "../../components/MaterialButton";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import type { ScreenProps } from "../../navigation/routes";
import type { ConversationStore } from "../conversation/conversation-store";
import { PROVIDERS } from "../conversation/lib/run-settings";
import { beginQueuedMessageEdit } from "./queued-message-edit";

type QueueAction = "steer" | "edit" | "up" | "down" | "remove";

/** The model an entry runs with, named as the model picker names it. */
function entryModel(entry: QueuedPromptSnapshot): string | null {
  return modelLabelFor(entry.provider, entry.modelConfig?.modelId)
    ?? PROVIDERS.find((provider) => provider.id === entry.provider)?.label
    ?? null;
}

function entryTitle(entry: QueuedPromptSnapshot): string {
  if (entry.kind === "provider_switch") return `Switch to ${entryModel(entry) ?? "another model"}`;
  const text = entry.text.replace(/\s+/g, " ").trim();
  return text || (entry.attachments?.length ? "Attachments" : "Queued message");
}

/**
 * The prompts waiting behind the running turn, as a sheet over its thread.
 * Each can steer the turn now, be edited, move up or down, or leave. A queue
 * held after a restart resumes from here.
 */
export function ThreadQueueSheet({ route, navigation }: ScreenProps<"ThreadQueue">) {
  const { hostId, conversationId } = route.params;
  const app = useApp();
  const store = app.openConversation(hostId, conversationId);
  return store ? (
    <ThreadQueueSheetContent store={store} onClose={() => navigation.goBack()} />
  ) : (
    <ThreadQueueSheetFrame title="Queued" onBack={() => navigation.goBack()}>
      <Text className="pt-6 text-center text-sm text-foreground-muted">This conversation is no longer open.</Text>
    </ThreadQueueSheetFrame>
  );
}

function ThreadQueueSheetContent(props: { readonly store: ConversationStore; readonly onClose: () => void }) {
  const { store } = props;
  const meta = useListened(store.meta, store.metaSnapshotOf);
  const entries = meta.queue.entries;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSteer = isSteerableStatus(meta.status);
  const { onClose } = props;

  // The host's queue is the truth; read it fresh each time the sheet opens.
  useEffect(() => {
    void store.controller.refreshQueue().catch(() => undefined);
  }, [store]);

  // Nothing left to manage: the sheet closes rather than sitting on an empty
  // list the user has to dismiss themselves.
  const hadEntries = useRef(entries.length > 0);
  useEffect(() => {
    if (entries.length > 0) {
      hadEntries.current = true;
      return;
    }
    if (hadEntries.current) onClose();
  }, [entries.length, onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const change = (mutation: SessionQueueMutation) => run(() => store.controller.changeQueue(mutation));
  const act = (entry: QueuedPromptSnapshot, index: number, action: QueueAction) => {
    void Haptics.selectionAsync();
    const revision = entry.revision ?? 0;
    switch (action) {
      case "steer":
        return void change({ kind: "steer", queueId: entry.queueId, revision });
      case "edit":
        beginQueuedMessageEdit(store, entry);
        props.onClose();
        return;
      case "up":
        return void change({ kind: "move", queueId: entry.queueId, revision, beforeQueueId: entries[index - 1]?.queueId ?? null });
      case "down":
        return void change({ kind: "move", queueId: entry.queueId, revision, beforeQueueId: entries[index + 2]?.queueId ?? null });
      case "remove":
        return void change({ kind: "remove", queueId: entry.queueId, revision });
    }
  };

  return (
    <ThreadQueueSheetFrame title="Queued" onBack={props.onClose}>
      {error ? <Text accessibilityRole="alert" className="py-2 text-sm text-danger-foreground">{error}</Text> : null}
      {meta.queue.held && entries.length > 0 ? (
        <View className="gap-2 py-3">
          <Text className="text-sm text-foreground-muted">Queue held after restart</Text>
          <MaterialButton label="Resume queue" disabled={busy} onPress={() => void change({ kind: "resume" })} />
        </View>
      ) : null}
      {entries.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No messages waiting in this queue.
        </Text>
      ) : null}
      {entries.map((entry, index) => {
        const title = entryTitle(entry);
        const model = entry.kind === "provider_switch" ? null : entryModel(entry);
        const isPrompt = entry.kind !== "provider_switch";
        const steerable = isPrompt && canSteer && !entry.held && !busy;
        return (
          <View key={entry.queueId} className="flex-row items-center border-b border-border bg-sheet">
            <ControlPillMenu
              className="flex-1"
              accessibilityLabel={`Actions for queued message ${index + 1}`}
              shouldOpenOnLongPress
              actions={[
                ...(isPrompt
                  ? [
                      {
                        id: "steer",
                        title: "Steer now",
                        attributes: { disabled: !steerable },
                        image: Platform.OS === "ios" ? "arrow.turn.left.up" : "arrow_upward",
                      },
                      {
                        id: "edit",
                        title: "Edit",
                        attributes: { disabled: busy },
                        image: Platform.OS === "ios" ? "pencil" : "edit",
                      },
                    ]
                  : []),
                { id: "up", title: "Move up", attributes: { disabled: busy || index === 0 } },
                { id: "down", title: "Move down", attributes: { disabled: busy || index === entries.length - 1 } },
                { id: "remove", title: "Remove", attributes: { disabled: busy, destructive: true } },
              ]}
              onPressAction={({ nativeEvent }) => act(entry, index, nativeEvent.event as QueueAction)}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={title}
                accessibilityHint="Opens this message for editing"
                disabled={!isPrompt || busy}
                onPress={() => act(entry, index, "edit")}
                className="min-h-14 flex-1 flex-row items-center gap-2.5 py-2.5 active:opacity-70"
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="min-w-0 text-sm text-foreground" numberOfLines={1}>
                    {title}
                  </Text>
                  {model ? (
                    <View className="flex-row items-center gap-1">
                      <ProviderIcon provider={entry.provider} size={12} />
                      <Text className="min-w-0 text-xs text-foreground-muted" numberOfLines={1}>{model}</Text>
                    </View>
                  ) : null}
                  {entry.error ? (
                    <Text className="text-xs text-danger-foreground" numberOfLines={2}>{entry.error}</Text>
                  ) : null}
                </View>
                {entry.held ? (
                  <Text className="shrink-0 text-2xs uppercase tracking-wide text-foreground-muted">Held</Text>
                ) : null}
                {isPrompt ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Steer with message ${index + 1} now`}
                    disabled={!steerable}
                    onPress={() => act(entry, index, "steer")}
                    className="h-8 shrink-0 justify-center rounded-full bg-primary px-3 active:opacity-70 disabled:opacity-40"
                  >
                    <Text className="font-t3-medium text-xs text-primary-foreground">Steer</Text>
                  </Pressable>
                ) : null}
              </Pressable>
            </ControlPillMenu>
          </View>
        );
      })}
    </ThreadQueueSheetFrame>
  );
}

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

/**
 * T3's queue sheet frame. A plain formSheet screen never renders a stack
 * header, so on iOS it comes from a nested native stack inside the sheet.
 */
function ThreadQueueSheetFrame(props: {
  readonly title: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const content = (
    <ScrollView
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      keyboardShouldPersistTaps="handled"
    >
      {props.children}
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-queue-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title={props.title}
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader title={props.title} onBack={props.onBack} />
      {content}
    </View>
  );
}
