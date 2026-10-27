import { memo, useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import Animated, { FadeInUp } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { ConversationStore } from "../conversation/conversation-store";
import { useTranscriptItem } from "./use-transcript-items";
import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import { SymbolView } from "../../components/AppSymbol";
import { MessageAttachments } from "./MessageAttachments";
import { ThreadMarkdown } from "./ThreadMarkdown";
const USER_MESSAGE_COLLAPSED_HEIGHT = 208;
const USER_MESSAGE_FADE_HEIGHT = 40;

/** A prompt the person sent, with its delivery state where it has not landed yet. */
export const UserMessageRow = memo(function UserMessageRow(props: {
  readonly store: ConversationStore;
  readonly id: string;
  readonly userBubbleColor: ColorValue;
  readonly userBubbleMaxWidth: number;
  readonly iconSubtleColor: ColorValue;
}) {
  const item = useTranscriptItem(props.store, props.id);
  const [textHeight, setTextHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  if (item?.kind !== "user") return null;
  // Not yet confirmed by the host; "Queued" waits behind the running turn or the connection.
  const pending = item.delivery === "sending";
  // A held prompt is shown whole, as on desktop.
  const canCollapse =
    !["sending", "queued"].includes(item.delivery) && textHeight > USER_MESSAGE_COLLAPSED_HEIGHT;
  const collapsed = canCollapse && !expanded;
  return (
    <Animated.View
      className="mb-5 items-end"
      {...(item.delivery === "sending" ? { entering: FadeInUp.duration(220) } : {})}
    >
      <View
        className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
        style={{ backgroundColor: props.userBubbleColor, maxWidth: props.userBubbleMaxWidth }}
      >
        <MessageAttachments
          attachments={item.attachments}
          cacheKey={`${props.store.controller.run.sessionId}-${item.id}`}
          // The bubble's inner width: its max less `px-3.5` (14pt) each side.
          width={props.userBubbleMaxWidth - 28}
          store={props.store}
        />
        {item.text.trim().length > 0 ? (
          <View>
            <View style={collapsed ? { height: USER_MESSAGE_COLLAPSED_HEIGHT, overflow: "hidden" } : undefined}>
              {/* The text is measured free of the cut in both states: collapsed,
                  it is absolute, so no height limit reaches the native markdown.
                  A text measured within the cut reports only the lines that fit,
                  and the fold then opens and closes in a loop. */}
              <View
                style={collapsed ? { position: "absolute", top: 0, left: 0, right: 0 } : undefined}
                onLayout={(event) => setTextHeight(event.nativeEvent.layout.height)}
              >
                <ThreadMarkdown markdown={item.text} tone="user" store={props.store} />
              </View>
            </View>
            {collapsed ? (
              <View
                pointerEvents="none"
                style={{ position: "absolute", left: 0, right: 0, top: USER_MESSAGE_COLLAPSED_HEIGHT - USER_MESSAGE_FADE_HEIGHT, height: USER_MESSAGE_FADE_HEIGHT }}
              >
                <Svg width="100%" height={USER_MESSAGE_FADE_HEIGHT}>
                  <Defs>
                    <LinearGradient id="user-message-fade" x1="0" y1="0" x2="0" y2={USER_MESSAGE_FADE_HEIGHT} gradientUnits="userSpaceOnUse">
                      <Stop offset="0" stopColor={props.userBubbleColor} stopOpacity={0} />
                      <Stop offset="1" stopColor={props.userBubbleColor} stopOpacity={1} />
                    </LinearGradient>
                  </Defs>
                  <Rect width="100%" height="100%" fill="url(#user-message-fade)" />
                </Svg>
              </View>
            ) : null}
            {canCollapse ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((value) => !value)}
                className="-mb-2 min-h-11 flex-row items-center justify-end active:opacity-70"
              >
                <Text className="font-t3-medium text-xs text-foreground-secondary">
                  {expanded ? "Show less" : "Read more"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
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
        {item.text.trim().length > 0 ? (
          <CopyTextButton
            accessibilityLabel="Copy message"
            text={item.text}
            tintColor={props.iconSubtleColor}
            buttonSize={28}
            iconSize={13}
          />
        ) : null}
      </View>
    </Animated.View>
  );
});
