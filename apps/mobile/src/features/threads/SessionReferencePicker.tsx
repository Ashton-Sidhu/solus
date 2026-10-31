import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import type { SolusThreadShell } from "./thread-directory";
import { sessionReferenceCandidates, sessionReferenceTitle } from "./session-reference";

/** The composer's "Reference Session…" sheet: a session on this host, chosen
 *  by name, goes into the draft as a `session://ref` token (desktop drags it
 *  from the sidebar). */
export function SessionReferencePicker(props: {
  readonly hostId: string;
  readonly currentSessionId: string;
  readonly onPick: (thread: SolusThreadShell) => void;
  readonly onClose: () => void;
}) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const threads = useListened(app.threads.changes, app.threads.threads);
  const unlisted = useListened(app.threads.changes, app.threads.unlistedThreads);
  const candidates = useMemo(
    () => sessionReferenceCandidates({ threads: [...threads, ...unlisted], hostId: props.hostId, currentSessionId: props.currentSessionId, query }),
    [props.currentSessionId, props.hostId, query, threads, unlisted],
  );
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
        <View className="h-14 flex-row items-center gap-3 px-5">
          <Text className="flex-1 font-t3-semibold text-base text-foreground">Reference Session</Text>
          <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={props.onClose}>
            <Text className="text-primary">Cancel</Text>
          </Pressable>
        </View>
        <TextInput
          accessibilityLabel="Search sessions"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          clearButtonMode="while-editing"
          onChangeText={setQuery}
          placeholder="Search sessions"
          placeholderTextColorClassName="accent-placeholder"
          returnKeyType="search"
          className="mx-5 mb-2 h-[40px] rounded-xl bg-subtle px-3 font-sans text-base text-foreground"
          value={query}
        />
        <FlatList
          data={candidates}
          keyExtractor={(thread) => thread.key}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text className="px-5 py-6 text-sm text-foreground-muted">No matching sessions.</Text>}
          renderItem={({ item: thread }) => (
            <Pressable accessibilityRole="button" className="gap-1 border-b border-border px-5 py-3 active:opacity-70" onPress={() => props.onPick(thread)}>
              <Text numberOfLines={1} className="text-sm font-t3-medium text-primary-text">{sessionReferenceTitle(thread)}</Text>
              <Text numberOfLines={1} className="text-xs text-foreground-tertiary">{thread.record.branch ?? thread.record.projectPath} · {thread.record.provider}</Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}
