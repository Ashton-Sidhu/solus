// Adapted from T3 Code apps/mobile/src/features/threads/thread-work-log.tsx (MIT, see UPSTREAM.md).
import { WorkLogLabel, WorkLogBlock, WorkLogRows, WorkLogIconSlot, WorkLogPressable } from "./work-log-layout";
import * as Haptics from "expo-haptics";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { MaskedView } from "@expo/ui/community/masked-view";
import { useIsFocused } from "@react-navigation/native";
import { memo, useEffect, useId, useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { AccessibilityInfo, AppState, type ColorValue, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { deriveThreadWorkLogSizing } from "../../lib/layout";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import type { ConversationStore } from "../conversation/conversation-store";
import { useTranscriptItem, useTranscriptItems } from "./use-transcript-items";
import { ToolResultImages } from "./ToolResultImages";
import {
  summarizeToolGroup,
  toolActivitySummary,
  toolFullDetail,
  toolGroupAction,
  toolGroupSummaryKind,
  toolRowLabel,
  type ToolGroupAction,
  type ToolTranscriptItem,
} from "./thread-work-log-presentation";

const SHIMMER_WIDTH = 72;
const SHIMMER_SWEEP_MS = 1_350;
const SHIMMER_PAUSE_MS = 1_450;
const SHIMMER_ICON_AND_GAP_WIDTH = 30;
export const THREAD_DISCLOSURE_TRANSITION_MS = 180;
const WORK_LOG_LAYOUT_TRANSITION = LinearTransition.duration(THREAD_DISCLOSURE_TRANSITION_MS);
const WORK_LOG_DETAIL_ENTER_TRANSITION = FadeIn.duration(140);
const WORK_LOG_DETAIL_EXIT_TRANSITION = FadeOut.duration(120);

type WorkLogSizing = ReturnType<typeof deriveThreadWorkLogSizing>;

function WorkLogIcon(props: {
  readonly icon: AppSymbolName;
  readonly color: ColorValue;
  readonly colorClassName?: string;
  readonly highlighted?: boolean;
}) {
  const colorClassName = props.highlighted ? "accent-foreground" : props.colorClassName;
  return (
    <SymbolView
      name={props.icon}
      size={14}
      weight="medium"
      {...(colorClassName ? { tintColorClassName: colorClassName } : { tintColor: props.color })}
      type="monochrome"
    />
  );
}

export function ThreadDisclosureChevron(props: {
  readonly expanded: boolean;
  readonly collapsedDirection: "right" | "down";
  readonly size: number;
  readonly tintColor: ColorValue;
}) {
  const expandedAngle = props.collapsedDirection === "right" ? 90 : 180;
  const rotation = useSharedValue(props.expanded ? expandedAngle : 0);

  useLayoutEffect(() => {
    rotation.value = withTiming(props.expanded ? expandedAngle : 0, {
      duration: THREAD_DISCLOSURE_TRANSITION_MS,
      reduceMotion: ReduceMotion.System,
    });
  }, [expandedAngle, props.expanded, rotation]);

  const rotationStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[{ width: props.size, height: props.size }, rotationStyle]}
    >
      <SymbolView
        name={props.collapsedDirection === "right" ? "chevron.right" : "chevron.down"}
        size={props.size}
        tintColor={props.tintColor}
        type="monochrome"
      />
    </Animated.View>
  );
}

function ShimmerWorkContent(props: {
  readonly textClassName?: string;
  readonly compact?: boolean;
  readonly highlighted: boolean;
  readonly icon: AppSymbolName;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly onTextLayout?: ComponentProps<typeof Text>["onTextLayout"];
  readonly showIcon: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      {props.showIcon ? (
        <View className="h-6 w-6 shrink-0 items-center justify-center">
          <WorkLogIcon icon={props.icon} color={props.iconSubtleColor} highlighted={props.highlighted} />
        </View>
      ) : null}
      <Text
        className={cn(
          "min-w-0 shrink",
          props.compact ? "text-xs" : "text-sm",
          props.highlighted ? "text-foreground" : "text-foreground-muted",
          props.textClassName,
        )}
        numberOfLines={1}
        onTextLayout={props.onTextLayout}
      >
        {props.label}
      </Text>
    </View>
  );
}

export function ShimmeringWorkContent(props: {
  readonly className?: string;
  readonly textClassName?: string;
  /** Secondary line: no icon slot, caption size. */
  readonly compact?: boolean;
  readonly icon: AppSymbolName;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly showIcon: boolean;
}) {
  const [availableWidth, setAvailableWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === "active");
  const [reducedMotion, setReducedMotion] = useState(true);
  const screenIsFocused = useIsFocused();
  const progress = useSharedValue(0);
  const gradientId = `work-shimmer-${useId().replaceAll(":", "")}`;
  const contentWidth = Math.min(
    availableWidth,
    (props.showIcon ? SHIMMER_ICON_AND_GAP_WIDTH : 0) + Math.ceil(textWidth),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppIsActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (contentWidth <= 0 || reducedMotion || !appIsActive || !screenIsFocused) return;

    progress.value = withRepeat(
      withSequence(
        withTiming(1, {
          duration: SHIMMER_SWEEP_MS,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
        withDelay(
          SHIMMER_PAUSE_MS,
          withTiming(0, { duration: 0, reduceMotion: ReduceMotion.Never }),
        ),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(progress);
  }, [appIsActive, contentWidth, progress, reducedMotion, screenIsFocused]);

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -SHIMMER_WIDTH + progress.value * (contentWidth + SHIMMER_WIDTH) }],
  }));
  const counterSweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: SHIMMER_WIDTH - progress.value * (contentWidth + SHIMMER_WIDTH) }],
  }));

  return (
    <View
      className={cn("min-w-0 flex-1 overflow-hidden", props.className)}
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      <ShimmerWorkContent
        textClassName={props.textClassName}
        compact={props.compact}
        highlighted={false}
        icon={props.icon}
        iconSubtleColor={props.iconSubtleColor}
        label={props.label}
        showIcon={props.showIcon}
        onTextLayout={(event) => setTextWidth(event.nativeEvent.lines[0]?.width ?? 0)}
      />
      {!reducedMotion && appIsActive && screenIsFocused && contentWidth > 0 ? (
        <Animated.View
          className="absolute inset-y-0 left-0 overflow-hidden"
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[{ width: SHIMMER_WIDTH }, sweepStyle]}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
                    <Stop offset="0" stopColor="white" stopOpacity={0} />
                    <Stop offset="0.15" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="0.35" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.5" stopColor="white" stopOpacity={1} />
                    <Stop offset="0.65" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.85" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="1" stopColor="white" stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
              </Svg>
            }
          >
            <Animated.View style={[{ width: availableWidth }, counterSweepStyle]}>
              <ShimmerWorkContent
                textClassName={props.textClassName}
                compact={props.compact}
                highlighted
                icon={props.icon}
                iconSubtleColor={props.iconSubtleColor}
                label={props.label}
                showIcon={props.showIcon}
              />
            </Animated.View>
          </MaskedView>
        </Animated.View>
      ) : null}
    </View>
  );
}

export function toolGroupSummarySymbolName(kind: ToolGroupAction | "mixed"): AppSymbolName {
  switch (kind) {
    case "read":
      return { ios: "eye", android: "visibility" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "device":
      return { ios: "iphone", android: "smartphone" };
    case "browser":
    case "search":
      return { ios: "globe", android: "public" };
    case "code-search":
      return "magnifyingglass";
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "other":
      return { ios: "wrench", android: "build" };
    case "mixed":
      return { ios: "hammer", android: "construction" };
  }
}

const WORK_GROUP_MAX_HEIGHT = 256;
const WORK_GROUP_EDGE_FADE_HEIGHT = 12;

interface ThreadWorkLogProps {
  readonly store: ConversationStore;
  readonly continuesWorkLog?: boolean | undefined;
  readonly toolIds: readonly string[];
  readonly anchorKey: string;
  readonly copiedRowId: string | null;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly rowSizing: WorkLogSizing;
  readonly iconSubtleColor: ColorValue;
  /** Feed background, painted as the scroll-edge fade over a long group. */
  readonly edgeFadeColor: string;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string, anchorKey: string) => void;
}

/** An expanded group's calls, each one row; a long group scrolls inside a fixed height. */
export function ThreadWorkLog(props: ThreadWorkLogProps) {
  if (props.toolIds.length === 0) {
    return null;
  }
  const rows = props.toolIds.map((id) => (
    <ThreadWorkLogRow
      key={id}
      store={props.store}
      toolItemId={id}
      anchorKey={props.anchorKey}
      copied={props.copiedRowId === id}
      expanded={props.expandedRows[id] ?? false}
      iconSubtleColor={props.iconSubtleColor}
      onCopyRow={props.onCopyRow}
      onToggleRow={props.onToggleRow}
    />
  ));
  return (
    <WorkLogBlock continues={props.continuesWorkLog}>
      <ThreadWorkGroupList edgeFadeColor={props.edgeFadeColor}>{rows}</ThreadWorkGroupList>
    </WorkLogBlock>
  );
}

function ThreadWorkGroupList(props: { readonly edgeFadeColor: string; readonly children: ReactNode }) {
  const [contentHeight, setContentHeight] = useState(0);
  const height = Math.min(contentHeight, WORK_GROUP_MAX_HEIGHT);
  const scrollOffset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollOffset.value = event.contentOffset.y;
  });
  // Each edge fades only while content continues past it.
  const topFadeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, scrollOffset.value) / WORK_GROUP_EDGE_FADE_HEIGHT),
  }));
  const bottomFadeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(
      1,
      Math.max(0, contentHeight - height - scrollOffset.value) / WORK_GROUP_EDGE_FADE_HEIGHT,
    ),
  }));

  return (
    <View style={{ maxHeight: WORK_GROUP_MAX_HEIGHT, overflow: "hidden" }}>
      <Animated.ScrollView
        nestedScrollEnabled
        directionalLockEnabled
        showsVerticalScrollIndicator
        scrollsToTop={false}
        bounces={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={onScroll}
        onContentSizeChange={(_, nextHeight) => setContentHeight(nextHeight)}
        style={{ maxHeight: WORK_GROUP_MAX_HEIGHT }}
      >
        <WorkLogRows>{props.children}</WorkLogRows>
      </Animated.ScrollView>
      <Animated.View
        pointerEvents="none"
        className="absolute inset-x-0 top-0"
        style={[{ height: WORK_GROUP_EDGE_FADE_HEIGHT }, topFadeStyle]}
      >
        <EdgeFade color={props.edgeFadeColor} direction="down" />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        className="absolute inset-x-0 bottom-0"
        style={[{ height: WORK_GROUP_EDGE_FADE_HEIGHT }, bottomFadeStyle]}
      >
        <EdgeFade color={props.edgeFadeColor} direction="up" />
      </Animated.View>
    </View>
  );
}

/** A screen-colored gradient painted over the list edge that still has content past it. */
function EdgeFade(props: { readonly color: string; readonly direction: "up" | "down" }) {
  const gradientId = `work-group-fade-${useId().replaceAll(":", "")}`;
  return (
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%">
          <Stop
            offset={0}
            stopColor={props.color}
            stopOpacity={props.direction === "down" ? 1 : 0}
          />
          <Stop
            offset={1}
            stopColor={props.color}
            stopOpacity={props.direction === "down" ? 0 : 1}
          />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThreadWorkLogRow = memo(function ThreadWorkLogRow(props: {
  readonly store: ConversationStore;
  readonly toolItemId: string;
  readonly anchorKey: string;
  readonly copied: boolean;
  readonly expanded: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string, anchorKey: string) => void;
}) {
  const item = useTranscriptItem(props.store, props.toolItemId);
  if (item?.kind !== "tool") return null;
  const row: ToolTranscriptItem = item;
  const { expanded } = props;
  const fullDetail = toolFullDetail(row);
  const images = row.images ?? [];
  const canExpand = fullDetail !== null || images.length > 0;
  const displayText = toolRowLabel(row, expanded);
  const failed = row.status === "error";
  const live = row.status === "running";
  const icon = toolGroupSummarySymbolName(toolGroupAction(row.toolName));
  const copyText = fullDetail ?? displayText;
  const accessiblePreview = row.childCount
    ? `${displayText}, ${row.childCount} ${row.childCount === 1 ? "step" : "steps"}`
    : displayText;

  return (
    <Animated.View layout={WORK_LOG_LAYOUT_TRANSITION} className="overflow-hidden">
      <WorkLogPressable
        accessibilityRole={canExpand ? "button" : undefined}
        accessibilityLabel={failed ? `${accessiblePreview}, tool call failed` : accessiblePreview}
        accessibilityHint={
          canExpand
            ? `Double tap to ${expanded ? "hide" : "show"} full details. Long press to copy.`
            : "Long press to copy."
        }
        accessibilityState={canExpand ? { expanded } : undefined}
        onPress={() => {
          if (canExpand) {
            void Haptics.selectionAsync();
            props.onToggleRow(row.id, props.anchorKey);
          }
        }}
        onLongPress={() => props.onCopyRow(row.id, copyText)}
      >
        {live && !expanded ? (
          <ShimmeringWorkContent
            icon={icon}
            iconSubtleColor={props.iconSubtleColor}
            label={displayText}
            showIcon
          />
        ) : (
          <>
            <WorkLogIconSlot>
              <WorkLogIcon
                icon={icon}
                color={props.iconSubtleColor}
                colorClassName={failed ? "accent-danger-foreground/40" : undefined}
              />
            </WorkLogIconSlot>
            <WorkLogLabel>
              {displayText}
              {row.childCount ? (
                <Text className="text-foreground-subtle">{`  ${row.childCount} ${row.childCount === 1 ? "step" : "steps"}`}</Text>
              ) : null}
            </WorkLogLabel>
          </>
        )}

        <View className="shrink-0 flex-row items-center gap-px">
          {props.copied ? (
            <Text className="pr-1 font-t3-medium text-3xs text-adaptive-emerald-600-400">
              Copied
            </Text>
          ) : null}
          {failed ? (
            <View
              className="h-4 w-4 items-center justify-center"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <SymbolView
                name="xmark"
                size={11}
                tintColorClassName="accent-danger-foreground/40"
                type="monochrome"
              />
            </View>
          ) : null}
          <View className="h-4 w-4 items-center justify-center">
            {canExpand ? (
              <ThreadDisclosureChevron
                expanded={expanded}
                collapsedDirection="down"
                size={11}
                tintColor={props.iconSubtleColor}
              />
            ) : null}
          </View>
        </View>
      </WorkLogPressable>

      {expanded && images.length > 0 ? (
        <ToolResultImages images={images} label={`Image from ${toolRowLabel(row, true)}`} store={props.store} />
      ) : null}

      {expanded && fullDetail ? (
        <Animated.View
          entering={WORK_LOG_DETAIL_ENTER_TRANSITION}
          exiting={WORK_LOG_DETAIL_EXIT_TRANSITION}
          layout={WORK_LOG_LAYOUT_TRANSITION}
          className="pb-1 pt-0.5"
        >
          <Animated.ScrollView
            nestedScrollEnabled
            directionalLockEnabled
            showsVerticalScrollIndicator
            className="max-h-60"
            contentContainerStyle={{ paddingRight: 8 }}
          >
            <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
              {fullDetail}
            </Text>
          </Animated.ScrollView>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
});

export function ThreadWorkGroupToggle(props: {
  readonly store: ConversationStore;
  readonly toolIds: readonly string[];
  readonly rowSizing: WorkLogSizing;
  readonly expanded: boolean;
  readonly live: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly onToggle: () => void;
}) {
  const items = useTranscriptItems(props.store, props.toolIds);
  const tools = items.filter((item): item is ToolTranscriptItem => item.kind === "tool");
  const latest = tools.at(-1);
  // The live group reads as its latest call; a finished group as its sentence.
  const summary = props.live && latest ? toolActivitySummary(latest) : summarizeToolGroup(tools);
  const hasFailure = tools.findLast((tool) => tool.status !== "running")?.status === "error";
  const shimmer = props.live && latest !== undefined && latest.status !== "error";
  const icon = toolGroupSummarySymbolName(
    props.live && latest ? toolGroupAction(latest.toolName) : toolGroupSummaryKind(tools),
  );
  const accessibilityLabel = hasFailure ? `${summary}, tool call failed` : summary;
  const hiddenCount = tools.length;

  return (
    <WorkLogBlock layout="group-header">
      <WorkLogPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} ${hiddenCount} tool ${hiddenCount === 1 ? "call" : "calls"}.`}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        rowSizing={props.rowSizing}
      >
        {shimmer ? (
          <ShimmeringWorkContent
            key={props.rowSizing.textSizeKey}
            icon={icon}
            iconSubtleColor={props.iconSubtleColor}
            label={summary}
            showIcon
          />
        ) : (
          <>
            <WorkLogIconSlot>
              <WorkLogIcon icon={icon} color={props.iconSubtleColor} />
            </WorkLogIconSlot>
            <WorkLogLabel key={props.rowSizing.textSizeKey}>{summary}</WorkLogLabel>
          </>
        )}
        <ThreadDisclosureChevron
          expanded={props.expanded}
          collapsedDirection="down"
          size={11}
          tintColor={props.iconSubtleColor}
        />
      </WorkLogPressable>
    </WorkLogBlock>
  );
}

export function ThreadThinkingRow(props: {
  readonly rowSizing: WorkLogSizing;
  readonly iconSubtleColor: ColorValue;
}) {
  return (
    <View
      accessible
      accessibilityLabel="Thinking"
      className="-mx-1 min-h-8 flex-row items-center px-1.5 py-0"
      style={{ minHeight: props.rowSizing.estimatedRowHeight }}
    >
      <ShimmeringWorkContent
        key={props.rowSizing.textSizeKey}
        icon={{ ios: "brain", android: "psychology" }}
        iconSubtleColor={props.iconSubtleColor}
        label="Thinking"
        showIcon
      />
    </View>
  );
}
