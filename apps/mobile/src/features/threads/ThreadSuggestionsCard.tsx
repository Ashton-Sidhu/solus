import { suggestionRows } from "@solus/client-core/suggestion-rows";
import { View } from "react-native";

import { useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import type { ConversationController } from "../conversation/conversation-controller";
import { RequestActionButton } from "./RequestActionButton";

/**
 * What guests suggested to this session (docs/plans/custom-roles.md §7), above
 * the composer, with Send and Dismiss for a reader who may prompt it. Send runs
 * the suggestion as the reader's own turn, as desktop and web do.
 */
export function ThreadSuggestionsCard(props: { readonly controller: ConversationController }) {
  const feed = props.controller.suggestions;
  const list = useListened(feed.changes, () => feed.list);
  const deciding = useListened(feed.changes, () => feed.deciding);
  const rows = suggestionRows(list, props.controller.mayDrive).filter((row) => row.suggestion.state === "waiting");
  if (rows.length === 0) return null;
  return (
    <View className="shrink-0 gap-3 px-4 pb-3">
      {rows.map(({ suggestion, canDecide, caption }) => (
        <View key={suggestion.id} className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">{caption}</Text>
          <Text className="font-sans text-base leading-normal text-foreground">{suggestion.text}</Text>
          {suggestion.attachments.length > 0 ? (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              {suggestion.attachments.map((attachment) => attachment.name).join(", ")}
            </Text>
          ) : null}
          {canDecide ? (
            <View className="flex-row flex-wrap gap-2.5">
              <RequestActionButton label="Send" tone="primary" disabled={deciding !== null} onPress={() => void feed.decide(suggestion.id, "send")} />
              <RequestActionButton label="Dismiss" tone="secondary" disabled={deciding !== null} onPress={() => void feed.decide(suggestion.id, "dismiss")} />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
