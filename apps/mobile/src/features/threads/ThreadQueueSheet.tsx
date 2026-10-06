// Adapted from T3 Code apps/mobile/src/features/threads/ThreadQueueControl.tsx (MIT, see UPSTREAM.md).
import { isSteerableStatus, modelLabelFor, type QueuedPromptSnapshot } from "@solus/contracts/types";
import type { SessionQueueMutation } from "@solus/contracts/session-queue";
import * as Haptics from "expo-haptics";
import { useEffect, useReducer, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { MaterialButton } from "../../components/MaterialButton";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { ConversationMeta, ConversationStore } from "../conversation/conversation-store";
import { QueueDraft } from "../conversation/lib/queue-edit";
import { PROVIDERS } from "../conversation/lib/run-settings";
import { pickComposerFiles } from "./composer-attachment-pickers";

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
 * The prompts waiting behind the running turn. Each can steer the turn now,
 * be edited, move up or down, or leave. A queue held after a restart resumes
 * from here. T3 drags rows to reorder; here Move up and Move down do it.
 */
export function ThreadQueueSheet(props: {
  readonly visible: boolean;
  readonly store: ConversationStore;
  readonly meta: ConversationMeta;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { store, meta } = props;
  const entries = meta.queue.entries;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<QueueDraft | null>(null);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const canSteer = isSteerableStatus(meta.status);

  // The host's queue is the truth; read it fresh each time the sheet opens.
  useEffect(() => {
    if (props.visible) void store.controller.refreshQueue().catch(() => undefined);
  }, [props.visible, store]);

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
        setDraft(new QueueDraft(entry, store.controller));
        return;
      case "up":
        return void change({ kind: "move", queueId: entry.queueId, revision, beforeQueueId: entries[index - 1]?.queueId ?? null });
      case "down":
        return void change({ kind: "move", queueId: entry.queueId, revision, beforeQueueId: entries[index + 2]?.queueId ?? null });
      case "remove":
        return void change({ kind: "remove", queueId: entry.queueId, revision });
    }
  };
  const close = () => {
    setDraft(null);
    setError(null);
    props.onClose();
  };

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View collapsable={false} className="flex-1 bg-sheet">
        <View className="flex-row items-center justify-between px-5 pb-2 pt-4">
          <Text accessibilityRole="header" className="font-t3-extrabold text-lg text-foreground">
            {draft ? "Edit queued message" : "Queued"}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={draft ? () => setDraft(null) : close} className="active:opacity-70">
            <Text className="font-t3-bold text-sm text-primary-text">{draft ? "Cancel" : "Done"}</Text>
          </Pressable>
        </View>
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-5 pb-6"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
          keyboardShouldPersistTaps="handled"
        >
          {error ? <Text accessibilityRole="alert" className="py-2 text-sm text-danger-foreground">{error}</Text> : null}
          {draft ? (
            <View className="gap-3 pt-2">
              <TextInput
                accessibilityLabel="Queued message"
                multiline
                autoFocus
                value={draft.text}
                onChangeText={(text) => {
                  draft.text = text;
                  refresh();
                }}
                placeholderTextColorClassName="accent-placeholder"
                selectionColorClassName="accent-focus/32"
                cursorColorClassName="accent-focus"
                className="min-h-28 rounded-2xl border border-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
              />
              {draft.attachments?.map((file) => (
                <View key={file.id} className="flex-row items-center gap-2 border-b border-border py-2">
                  <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>{file.name}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${file.name}`}
                    disabled={busy}
                    onPress={() => {
                      draft.removeFile(file.id);
                      refresh();
                    }}
                    className="active:opacity-70"
                  >
                    <Text className="text-sm text-danger-foreground">Remove</Text>
                  </Pressable>
                </View>
              ))}
              <View className="flex-row flex-wrap gap-2">
                <MaterialButton
                  label="Add files"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      const files = await pickComposerFiles(draft.attachments?.length ?? 0);
                      if (files.length === 0) return;
                      await draft.addFiles(files);
                      refresh();
                    })
                  }
                />
                <MaterialButton
                  label="Save"
                  tone="primary"
                  loading={busy}
                  onPress={() =>
                    void run(async () => {
                      await draft.save();
                      setDraft(null);
                    })
                  }
                />
              </View>
            </View>
          ) : (
            <>
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
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
