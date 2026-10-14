// Adapted from T3 Code apps/mobile/src/features/threads/ComposerQueuedEdit.tsx (MIT, see UPSTREAM.md).
// The attachment chips show the file type symbol, not an image thumbnail.
import type { QueueAttachment } from "@solus/contracts/session-queue";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

/**
 * The composer is shared, so editing a queued message needs a visible way back
 * out. This is that way out, and the only place the edit announces itself.
 */
export function ComposerQueuedEditBanner(props: {
  readonly saving: boolean;
  readonly onCancel: () => void;
}) {
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="pencil" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        Editing queued message
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel editing queued message"
        disabled={props.saving}
        onPress={props.onCancel}
        hitSlop={8}
        className="min-h-8 justify-center px-1 active:opacity-70 disabled:opacity-40"
      >
        <Text className="font-t3-medium text-xs text-primary">Cancel</Text>
      </Pressable>
    </View>
  );
}

/**
 * The files of the queued message. They live on the host rather than in the
 * conversation's draft, so they get their own row: removing one drops it from
 * the list the edit sends.
 */
export function ComposerQueuedEditAttachments(props: {
  readonly attachments: ReadonlyArray<QueueAttachment>;
  readonly disabled: boolean;
  readonly onRemove: (attachmentId: string) => void;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
      contentContainerClassName="flex-row items-center gap-2"
    >
      {props.attachments.map((attachment) => (
        <View
          key={attachment.id}
          className="max-w-[180px] flex-row items-center gap-2 rounded-xl border border-border bg-card py-1 pl-1 pr-2"
        >
          <View className="h-6 w-6 items-center justify-center rounded-md bg-subtle">
            <SymbolView
              name={attachment.type === "image" ? "photo" : "doc"}
              size={12}
              tintColorClassName="accent-icon-subtle"
            />
          </View>
          <Text className="min-w-0 shrink text-xs text-foreground" numberOfLines={1}>
            {attachment.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${attachment.name}`}
            disabled={props.disabled}
            hitSlop={8}
            onPress={() => props.onRemove(attachment.id)}
            className="active:opacity-70 disabled:opacity-40"
          >
            <SymbolView name="xmark.circle.fill" size={14} tintColorClassName="accent-icon-subtle" />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}
