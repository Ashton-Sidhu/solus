import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { memo, type ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { useApp, useListened } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { RootStackParamList } from "../../navigation/routes";
import { conversationIdOf, type ConversationStore } from "../conversation/conversation-store";
import { TurnArtifactChips } from "./AgentArtifactChips";
import { ThreadToolGallery } from "./ThreadImages";

/**
 * What ends a finished turn: the images its calls returned, the turn's changes
 * when the conversation shows its copy from Solus Cloud, then what the session
 * linked during the turn.
 */
export const TurnFooter = memo(function TurnFooter({ toolIds, ...props }: ComponentProps<typeof TurnArtifactChips> & { readonly toolIds: readonly string[] }) {
  return (
    <>
      <ThreadToolGallery store={props.store} toolIds={toolIds} />
      <CloudTurnChanges store={props.store} promptId={props.promptId} />
      <TurnArtifactChips {...props} />
    </>
  );
});

/**
 * "Changes" under a turn of a copy from Solus Cloud
 * (docs/plans/portable-sessions-cloud.md, Phase 5B): it opens the turn's diff,
 * read from the Solus API. A host's history shows no such chip; the host's
 * own diff surfaces cover it.
 */
function CloudTurnChanges(props: { readonly store: ConversationStore; readonly promptId: string | null }) {
  const app = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { store, promptId } = props;
  // The model changes with the order: a host's history that replaces the copy has no cloud turns.
  const turnIndex = useListened(store.order, () => (promptId ? app.cloudHistory.turnOf(store.controller.model, promptId) : null));
  if (turnIndex === null) return null;
  return (
    <View className="my-1 self-stretch">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Changes of turn ${turnIndex + 1}`}
        accessibilityHint="Shows the changes this turn made, from Solus Cloud"
        onPress={() => navigation.push("ThreadTurnDiff", { sessionId: conversationIdOf(store), turnIndex })}
        className="h-8 flex-row items-center gap-1.5 self-start rounded-full border border-border bg-card pl-2.5 pr-3 active:opacity-70"
      >
        <SymbolView name="chevron.left.forwardslash.chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
        <Text className="font-t3-medium text-xs text-foreground">Changes</Text>
      </Pressable>
    </View>
  );
}
