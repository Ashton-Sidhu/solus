import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";

/**
 * The cloud refused this host's push: another host continued the session
 * first (docs/plans/portable-sessions-cloud.md answer 3.4). The host refuses
 * new prompts until it uses the newer copy. The phone has no session fork
 * (portable-sessions.md §16 decision 5), so it offers only that action; the
 * turns this host ran stay in its history.
 */
export function SessionPushRefusedCard(props: {
  readonly store: ConversationStore;
  /** The words of the refused push; null shows nothing. */
  readonly text: string | null;
  /** The copy is in use: the composer takes focus back. */
  readonly onDone: () => void;
}) {
  const { store } = props;
  const [isUsing, setUsing] = useState(false);
  const mayDrive = store.controller.mayDrive;
  if (!props.text) return null;
  return (
    <View accessibilityRole="summary" className="mx-4 mb-2 gap-2 rounded-2xl border border-border bg-subtle px-4 py-3">
      <Text selectable className="text-sm text-foreground">{props.text}</Text>
      {mayDrive ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: isUsing, disabled: isUsing }}
          accessibilityHint="This host gets the session as the other host left it"
          disabled={isUsing}
          onPress={() => {
            setUsing(true);
            void store.controller.takeNewerCopy().finally(() => {
              setUsing(false);
              props.onDone();
            });
          }}
          className="min-h-11 flex-row items-center justify-center gap-2 self-start rounded-full bg-screen px-4"
        >
          {isUsing ? <ActivityIndicator size="small" /> : null}
          <Text className="text-sm text-foreground">Use the newer copy</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
