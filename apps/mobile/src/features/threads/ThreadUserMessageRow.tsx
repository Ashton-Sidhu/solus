// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx (MIT, see UPSTREAM.md).
import { memo } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import Animated, { FadeInUp } from "react-native-reanimated";
import type { ConversationStore } from "../conversation/conversation-store";
import type { TranscriptItem } from "../conversation/lib/transcript-model";
import { useTranscriptItem } from "./use-transcript-items";
import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import { SymbolView } from "../../components/AppSymbol";
import { copyableImage, messageAttachmentLayout } from "../conversation/lib/message-attachments";
import { useApp } from "../../app/app-context";
import { resolveHostMediaUrl } from "../files/host-media-url";
import { copyImageToClipboard } from "../../lib/copyImageToClipboard";
import { MessageFiles, MessageMedia } from "./MessageAttachments";
import { ThreadMarkdown } from "./ThreadMarkdown";

/** A prompt the person sent, with its delivery state where it has not landed yet. */
export const UserMessageRow = memo(function UserMessageRow(props: {
  readonly store: ConversationStore;
  readonly id: string;
  readonly userBubbleColor: ColorValue;
  readonly userBubbleMaxWidth: number;
  readonly iconSubtleColor: ColorValue;
  /** The next row is another prompt from the person: the gap below closes. */
  readonly groupedWithNext: boolean;
}) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "user") return null;
  // Not yet confirmed by the host; "Queued" waits behind the running turn or the connection.
  const pending = item.delivery === "sending";
  const hasText = item.text.trim().length > 0;
  const layout = messageAttachmentLayout(item.attachments, hasText);
  return (
    <Animated.View
      className={props.groupedWithNext ? "mb-1 items-end gap-2" : "mb-5 items-end gap-2"}
      {...(item.delivery === "sending" ? { entering: FadeInUp.duration(220) } : {})}
    >
      {/* Pictures and videos are a shape of their own above the words. */}
      <MessageMedia
        images={layout.images}
        videos={layout.videos}
        cacheKey={`${props.store.controller.run.sessionId}-${item.id}`}
        maxWidth={props.userBubbleMaxWidth}
        store={props.store}
      />
      {layout.fileStyle === "cards" ? (
        <MessageFiles files={layout.files} variant="cards" sending={pending} store={props.store} />
      ) : null}
      {hasText ? (
        <View
          className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
          style={{
            backgroundColor: props.userBubbleColor,
            maxWidth: props.userBubbleMaxWidth,
            borderTopRightRadius: 20,
          }}
        >
          {layout.fileStyle === "chips" ? (
            <MessageFiles files={layout.files} variant="chips" sending={pending} store={props.store} />
          ) : null}
          <ThreadMarkdown markdown={item.text} tone="user" store={props.store} />
        </View>
      ) : null}
      <UserMessageMeta store={props.store} item={item} hasText={hasText} iconSubtleColor={props.iconSubtleColor} />
    </Animated.View>
  );
});

/** Under the bubble: where the prompt is on its way, its retry, and its copy. */
function UserMessageMeta(props: {
  readonly store: ConversationStore;
  readonly item: Extract<TranscriptItem, { kind: "user" }>;
  readonly hasText: boolean;
  readonly iconSubtleColor: ColorValue;
}) {
  const app = useApp();
  const item = props.item;
  const pending = item.delivery === "sending";
  const image = item.delivery === "sent" ? copyableImage(item.attachments, props.hasText) : null;
  // The picture's bytes, from the prompt itself or through a URL the host signs.
  const copyImage = async () => {
    if (image?.kind === "image") return copyImageToClipboard({ dataUrl: image.dataUrl });
    const connection = app.connections.connection(props.store.controller.hostId);
    if (image?.kind !== "host-image" || !connection) throw new Error("The picture is not available.");
    await copyImageToClipboard({ url: await resolveHostMediaUrl(connection, { path: image.hostPath }) });
  };
  return (
    <View className="-mt-1 flex-row items-center justify-end gap-1 pr-0.5">
      {item.delivery === "queued" ? (
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel="Queued"
          className="rounded-full border border-adaptive-amber-500-a25-400-a25 bg-adaptive-amber-500-a10-400-a10 px-1.5 py-0.5"
        >
          <Text className="font-t3-medium text-2xs tracking-wide text-adaptive-amber-700-300">
            Queued
          </Text>
        </View>
      ) : null}
      {pending ? (
        <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">Pending</Text>
      ) : null}
      {item.delivery === "failed" ? (
        <Text className="font-t3-medium text-xs text-danger-foreground" numberOfLines={2}>
          {item.error && item.error !== "Not sent." ? `Not sent: ${item.error}` : "Not sent"}
        </Text>
      ) : null}
      {item.delivery === "failed" && item.error !== "Not sent." ? (
        <>
          {props.store.controller.lowerModeFor(item.id) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Lower the mode"
              accessibilityHint="Sets the highest mode the policy allows and sends the message again"
              hitSlop={8}
              className="rounded-full bg-subtle px-2.5 py-1 active:opacity-70"
              onPress={() => void props.store.controller.lowerModeAndRetry(item.id)}
            >
              <Text className="font-t3-medium text-xs text-foreground">Lower the mode</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send again"
            hitSlop={8}
            className="size-7 items-center justify-center"
            onPress={() => void props.store.controller.retry(item.id)}
          >
            <SymbolView name="arrow.clockwise" size={14} tintColor={props.iconSubtleColor} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remove message"
            hitSlop={8}
            className="size-7 items-center justify-center"
            onPress={() => props.store.controller.discard(item.id)}
          >
            <SymbolView name="xmark" size={14} tintColor={props.iconSubtleColor} />
          </Pressable>
        </>
      ) : null}
      {props.hasText ? (
        <CopyTextButton
          accessibilityLabel="Copy message"
          text={item.text}
          tintColor={props.iconSubtleColor}
          buttonSize={28}
          iconSize={13}
        />
      ) : image ? (
        <CopyTextButton
          accessibilityLabel="Copy picture"
          text={image.name}
          onCopy={copyImage}
          tintColor={props.iconSubtleColor}
          buttonSize={28}
          iconSize={13}
        />
      ) : null}
    </View>
  );
}
