// Adapted from T3 Code apps/mobile/src/features/threads/ThreadComposer.tsx (MIT, see UPSTREAM.md).
import type { ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Alert, Platform, View, type ViewStyle } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { isSessionBusyStatus, isSteerableStatus } from "@solus/contracts/types";
import { MAX_ATTACHMENT_UPLOAD_COUNT } from "@solus/contracts/rpc";

import { useApp } from "../../app/app-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useOpenHostFile } from "./MessageAttachments";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
  ComposerUploadingThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { GlassSurface } from "../../components/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { useKeyboardCommand } from "../keyboard/use-keyboard-command";
import type { ConversationMeta, ConversationStore } from "../conversation/conversation-store";
import type { PickedFile } from "../conversation/lib/attachments";
import { modelLabel } from "../conversation/lib/run-settings";
import {
  resolveComposerSendPresentation,
  type ActiveTurnComposerAction,
  type ComposerSendPresentation,
} from "./composerSendPresentation";
import { pickComposerFiles, pickComposerMedia } from "./composer-attachment-pickers";
import { ThreadSettingsSheet } from "./ThreadSettingsSheet";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 */
export const COMPOSER_EXPANDED_CHROME = 156;

const DRAFT_SAVE_DELAY_MS = 400;

export interface ThreadComposerProps {
  readonly store: ConversationStore;
  readonly meta: ConversationMeta;
  /** Where the draft is kept on this device. */
  readonly draftKey: string;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  /** The host is connected: a send leaves now instead of waiting. */
  readonly connected: boolean;
  /** Why sending is blocked right now (the send button's label), or null. */
  readonly sendBlockedReason?: string | null;
  readonly canStopThread: boolean;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onStopThread: () => void;
  /** After a prompt was handed to the conversation. */
  readonly onSent?: () => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

// The bottom-anchored dock position and clipped surface height use the same
// transition so the card grows upward without exposing its final-size content.
// Android gets no layout transition: the composer rides the keyboard via
// KeyboardStickyView, and a time-based morph alongside it reads as jitter.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
const composerHeightTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : composerHeightTransition;

const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

const FOLLOW_UP_ACTION_LABEL = {
  queue: "Queue",
  steer: "Steer now",
} as const;

const FOLLOW_UP_ACTION_SUBTITLE = {
  queue: "Run after the current turn",
  steer: "Interrupt what the agent is doing",
} as const;

/**
 * The composer's primary button. While a turn is running it also long-presses
 * into the two follow-up behaviors.
 */
function SendActionButton(props: {
  readonly accessibilityLabel: string;
  readonly presentation: ComposerSendPresentation;
  readonly disabled: boolean;
  readonly onSend: (followUp?: ActiveTurnComposerAction) => void;
}) {
  const { presentation } = props;
  const button = (
    <ComposerActionButton
      accessibilityLabel={props.accessibilityLabel}
      icon={presentation.icon}
      variant="primary"
      disabled={props.disabled}
      onPress={() => props.onSend()}
    />
  );
  if (!presentation.offersFollowUpChoice || presentation.action === null || props.disabled) {
    return button;
  }
  const actions = [presentation.action, presentation.alternate].filter(
    (action): action is ActiveTurnComposerAction => action !== null,
  );
  return (
    <ControlPillMenu
      accessibilityLabel="Choose how to send this message"
      shouldOpenOnLongPress
      actions={actions.map((action) => ({
        id: action,
        title: FOLLOW_UP_ACTION_LABEL[action],
        subtitle: FOLLOW_UP_ACTION_SUBTITLE[action],
        state: action === presentation.action ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) =>
        props.onSend(nativeEvent.event === "queue" ? "queue" : "steer")
      }
    >
      {button}
    </ControlPillMenu>
  );
}

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  /** Morphs between the compact and expanded composer layouts. */
  readonly animateLayout?: boolean;
}) {
  const colors = useUniwindTheme();
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const animatedBorderRadius = useSharedValue(targetBorderRadius);
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  useLayoutEffect(() => {
    animatedBorderRadius.value = shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius;
  }, [animatedBorderRadius, shouldAnimate, targetBorderRadius]);
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Each native frame follows the same transition. Animating only the outer
  // clip leaves the glass and content at their final height on the first frame.
  return (
    <Animated.View
      className={
        Platform.OS === "android" ? undefined : "shadow-[0_6px_28px] shadow-composer-shadow"
      }
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
        },
      ]}
    >
      <AnimatedGlassSurface
        chrome="none"
        fallbackColor={colors["--color-composer-surface"]}
        fallbackClassName="border border-composer-border"
        glassEffectStyle="regular"
        // The composer is a passive material containing interactive controls.
        pointerEvents="none"
        // Tinted with the Solus input pill, so the composer reads as the same
        // surface with or without the system glass.
        tintColor={colors["--color-composer-surface"]}
        layout={layoutTransition}
        style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const app = useApp();
  const { store, meta } = props;
  const hostId = store.controller.hostId;
  const openHostFile = useOpenHostFile(store);
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const composerPanel = materialTheme["--color-composer-panel"];
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftMessage, setDraftMessage] = useState(() => app.draft(hostId, props.draftKey));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const { onExpandedChange } = props;

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      setDraftMessage(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => app.saveDraft(hostId, props.draftKey, value),
        DRAFT_SAVE_DELAY_MS,
      );
    },
    [app, hostId, props.draftKey],
  );

  const hasContent = draftMessage.trim().length > 0 || meta.attachments.length > 0;
  const stripAttachments = meta.attachments;
  const showStopAction = !hasContent && props.canStopThread;
  const attachmentsUploading = meta.uploading > 0;
  const running = isSessionBusyStatus(meta.status);
  // Every send goes through the outbox; the label says whether it leaves now
  // or waits (for the connection or an earlier queued message).
  const sendPresentation = resolveComposerSendPresentation({
    running,
    canSteer: isSteerableStatus(meta.status),
    followUpBehavior: "steer",
    deliveryDeferred: !props.connected || meta.queue.entries.length > 0 || meta.queue.held,
  });
  const sendLabel = sendPresentation.label;
  const isExpanded = isFocused || settingsOpen;
  const isToolbarVisible = isExpanded;
  const sendBlockedReason =
    props.sendBlockedReason ?? (attachmentsUploading ? "Uploading attachments" : null);
  const canSend = hasContent && sendBlockedReason === null;
  const currentModelLabel = modelLabel(meta.run.provider, meta.run.model);

  // Keep the feed inset aligned with the card.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onExpandedChange?.(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange, onExpandedChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (!settingsOpen) {
      onExpandedChange?.(false);
    }
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange, onExpandedChange, settingsOpen]);

  const handleSend = useCallback(
    async (followUp?: ActiveTurnComposerAction) => {
      if (!canSend || inFlightRef.current) return;
      inFlightRef.current = true;
      const prompt = draftMessage.trim();
      setDraftMessage("");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      try {
        const sending = store.controller.send(prompt, {
          delivery: followUp ?? sendPresentation.action ?? undefined,
        });
        props.onSent?.();
        await sending;
        app.saveDraft(hostId, props.draftKey, "");
      } finally {
        inFlightRef.current = false;
      }
    },
    [app, canSend, draftMessage, hostId, props.draftKey, props.onSent, sendPresentation.action, store],
  );

  const attach = useCallback(
    async (pick: (existingCount: number) => Promise<PickedFile[]>) => {
      try {
        const files = await pick(meta.attachments.length + meta.uploading);
        if (files.length > 0) void store.controller.attach(files);
      } catch (error) {
        Alert.alert("Could not attach", error instanceof Error ? error.message : String(error));
      }
    },
    [meta.attachments.length, meta.uploading, store],
  );
  const onPickDraftMedia = useCallback(() => attach(pickComposerMedia), [attach]);
  const onPickDraftFiles = useCallback(() => attach(pickComposerFiles), [attach]);
  const attachmentsFull = meta.attachments.length + meta.uploading >= MAX_ATTACHMENT_UPLOAD_COUNT;

  const openSettings = useCallback(() => {
    inputRef.current?.blur();
    setSettingsOpen(true);
  }, [inputRef]);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    // Typing is the natural next step after choosing how the next prompt runs.
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [inputRef]);

  // A hardware Return sends; Command-L focuses the composer.
  useKeyboardCommand("send", () => {
    if (canSend) void handleSend();
  });
  useKeyboardCommand("focusInput", () => inputRef.current?.focus());

  return (
    <Animated.View
      className="px-[12px]"
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
        backgroundColor:
          Platform.OS === "android" ? themeColorWithAlpha(composerPanel, 1) : undefined,
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          drops experimental_backgroundImage on Android. */}
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        <ComposerSurface
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingTop: 14,
                }
              : {
                  // Keep the numeric radius close to the expanded card so the
                  // shape morph stays bounded while rendering as a capsule.
                  borderRadius: 27,
                  overflow: "hidden" as const,
                  paddingVertical: 2,
                }
          }
        >
          <Animated.View
            collapsable={false}
            className={isExpanded ? undefined : "flex-row items-center"}
            layout={COMPOSER_LAYOUT_TRANSITION}
          >
            {!isExpanded ? (
              <ComposerAttachmentButton
                disabled={attachmentsFull}
                supportsFiles
                onPickMedia={onPickDraftMedia}
                onPickFiles={onPickDraftFiles}
              />
            ) : null}
            {isExpanded && (stripAttachments.length > 0 || meta.uploading > 0) ? (
              <Animated.View
                className="px-[14px] pb-2.5"
                entering={COMPOSER_ATTACHMENT_ENTERING}
                exiting={FadeOut.duration(120)}
              >
                <ComposerAttachmentStrip
                  attachments={stripAttachments}
                  uploading={meta.uploading}
                  onRemove={(id) => store.controller.removeAttachment(id)}
                  onPressDocument={(attachment) => openHostFile(attachment.hostPath)}
                />
              </Animated.View>
            ) : null}
            <Animated.View
              className={isExpanded ? "px-[14px]" : "min-w-0 flex-1 px-[4px]"}
              layout={COMPOSER_LAYOUT_TRANSITION}
            >
              <ComposerEditor
                ref={inputRef}
                multiline
                value={draftMessage}
                onChangeText={onChangeDraftMessage}
                placeholder={props.placeholder}
                onFocus={handleFocus}
                onBlur={handleBlur}
                scrollEnabled={isExpanded}
                // Android: a collapsed single line centers natively in a
                // pill-height box matching the send button; iOS keeps insets.
                singleLineCentered={!isExpanded}
                contentInsetVertical={isExpanded || Platform.OS === "android" ? 0 : 6}
                style={
                  isExpanded
                    ? {
                        minHeight: 72,
                        maxHeight: 160,
                        paddingVertical: 4,
                      }
                    : {
                        height: 36,
                      }
                }
                textStyle={{
                  ...bodyText,
                  color: foregroundColor,
                }}
              />
            </Animated.View>
            {!isExpanded && (stripAttachments.length > 0 || meta.uploading > 0) ? (
              <View className="flex-row gap-1 pl-1">
                {stripAttachments.slice(0, 3).map((attachment) => (
                  <ComposerAttachmentThumbnail
                    key={attachment.id}
                    attachment={attachment}
                    size={30}
                    borderRadius={8}
                    compact
                  />
                ))}
                {stripAttachments.length === 0 ? (
                  <ComposerUploadingThumbnail size={30} borderRadius={8} />
                ) : null}
                {stripAttachments.length > 3 ? (
                  <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                    <Text className="text-foreground-muted text-2xs font-t3-bold">
                      +{stripAttachments.length - 3}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {!isExpanded ? (
              <View className="flex-row items-center">
                {showStopAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                  />
                ) : (
                  <SendActionButton
                    accessibilityLabel={sendBlockedReason ?? sendLabel}
                    presentation={sendPresentation}
                    disabled={!canSend}
                    onSend={(followUp) => void handleSend(followUp)}
                  />
                )}
              </View>
            ) : null}
            {isExpanded ? <View className="h-1" /> : null}
          </Animated.View>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            layout={COMPOSER_LAYOUT_TRANSITION}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={
              isExpanded
                ? undefined
                : {
                    position: "absolute",
                    bottom: 2,
                    left: 0,
                    right: 0,
                  }
            }
          >
            <View className="relative h-[44px] overflow-hidden">
              {isToolbarVisible ? (
                <View className="absolute inset-0">
                  <ComposerToolbarRow
                    paddingBottom={0}
                    paddingHorizontal={0}
                    paddingTop={0}
                    style={{ gap: 0 }}
                  >
                    <View className="min-w-0 flex-1 flex-row items-center justify-between">
                      <ComposerAttachmentButton
                        disabled={attachmentsFull}
                        supportsFiles
                        onPickMedia={onPickDraftMedia}
                        onPickFiles={onPickDraftFiles}
                      />
                      <View className="min-w-0 shrink">
                        <ComposerInlineControl
                          accessibilityLabel="Model and reasoning settings"
                          emphasized
                          label={currentModelLabel}
                          maxWidth="100%"
                          onPress={openSettings}
                        />
                      </View>
                    </View>
                    <View className="shrink-0 flex-row items-center">
                      {showStopAction ? (
                        <ComposerActionButton
                          accessibilityLabel="Stop agent"
                          icon="stop.fill"
                          variant="danger"
                          onPress={props.onStopThread}
                        />
                      ) : (
                        <SendActionButton
                          accessibilityLabel={sendBlockedReason ?? sendLabel}
                          presentation={sendPresentation}
                          disabled={!canSend}
                          onSend={(followUp) => void handleSend(followUp)}
                        />
                      )}
                    </View>
                  </ComposerToolbarRow>
                </View>
              ) : null}
            </View>
          </Animated.View>
        </ComposerSurface>
      </Animated.View>

      <ThreadSettingsSheet
        visible={settingsOpen}
        onClose={closeSettings}
        store={store}
        meta={meta}
      />
    </Animated.View>
  );
});
