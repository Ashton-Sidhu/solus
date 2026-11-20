// Adapted from T3 Code apps/mobile/src/features/threads/ThreadComposer.tsx (MIT, see UPSTREAM.md).
import type { ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Alert, Platform, View, type ViewStyle } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Animated, {
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from "react-native-reanimated";
import { isSessionBusyStatus, isSteerableStatus } from "@solus/contracts/types";
import { quotedReplyDraft } from "@solus/client-core/quoted-reply";
import { draftWithUnsentRemarks } from "@solus/contracts/question-answer";

import { useApp } from "../../app/app-context";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useOpenHostFile } from "./MessageAttachments";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
  ComposerUploadingThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { GlassSurface } from "../../components/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle, type ComposerEditorSelection } from "../../components/ComposerEditor";
import {
  ComposerActionButton,
  ComposerInlineControl,
} from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";
import { useComposerTextRole } from "../settings/appearance/useScaledTextRole";
import { useKeyboardCommand } from "../keyboard/use-keyboard-command";
import { conversationIdOf, type ConversationMeta, type ConversationStore } from "../conversation/conversation-store";
import type { RootStackParamList } from "../../navigation/routes";
import type { PickedFile } from "../conversation/lib/attachments";
import { permissionForFeedback } from "../conversation/lib/transcript-model";
import { modelLabel, modelOptionsSummary } from "../conversation/lib/run-settings";
import {
  resolveComposerSendPresentation,
  type ActiveTurnComposerAction,
  type ComposerSendPresentation,
} from "./composerSendPresentation";
import { pastedComposerImages, pickComposerFiles, pickComposerMedia } from "./composer-attachment-pickers";
import type { ClipboardAttachmentRef } from "@solus/client-core/attachment-clipboard";
import { withoutPastedText } from "../conversation/lib/pasted-attachments";
import { COMPOSER_TRANSITION_DURATION_MS, ONE_ROW_MIN_EDITOR_SHARE } from "./composer-layout";
import { useCompactComposerEditor } from "./use-compact-composer-editor";
export { COMPOSER_TRANSITION_DURATION_MS } from "./composer-layout";
import { ComposerQueuedEditAttachments } from "./ComposerQueuedEdit";
import { composerDraftView, useComposerQueuedEdit } from "./use-composer-queued-edit";
import { SessionReferencePicker } from "./SessionReferencePicker";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";
import { insertSessionReference, sessionReferenceOf } from "./session-reference";
import type { SolusThreadShell } from "./thread-directory";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = Platform.OS === "ios" && Platform.isPad ? 72 : 58;

/**
 * The composer's padding below the pill (`row`) or the card (`card`).
 * The parent's bottom inset sits below it.
 */
export const THREAD_COMPOSER_BOTTOM_GUTTER = { row: 6, card: 6 } as const;

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
  /** The host is reconnecting: the draft stays, but takes no input until it is back. */
  readonly disabled?: boolean;
  readonly canStopThread: boolean;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onStopThread: () => void;
  /** After a prompt was handed to the conversation. */
  readonly onSent?: () => void;
  /** The conversation the next prompt goes to, when it is not this one: another
   *  host runs a turn of the session now (docs/plans/portable-sessions.md §4 decision 5). */
  readonly sendStore?: () => ConversationStore;
  /** Keeps the new-session host choice aware of the unsent draft. */
  readonly onDraftChange?: (text: string) => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly onHeightChange?: (height: number) => void;
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

// The bottom-anchored dock position and clipped surface height use the same
// transition so the card grows upward without exposing its final-size content.
// Android gets no layout transition: the composer rides the keyboard via
// KeyboardStickyView, and a time-based morph alongside it reads as jitter.
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
  readonly actionKey: string;
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly presentation: ComposerSendPresentation;
  readonly disabled: boolean;
  readonly onSend: (followUp?: ActiveTurnComposerAction) => void;
}) {
  const { presentation } = props;
  const button = (
    <ComposerActionButton
      actionKey={props.actionKey}
      size={props.size}
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
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  const animatedBorderRadius = useDerivedValue(() =>
    shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius,
  );
  const borderCurve = props.style.borderCurve;
  const animatedSurfaceStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
    borderCurve,
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Each native frame follows the same transition. Animating only the outer
  // clip leaves the glass and content at their final height on the first frame.
  return (
    <Animated.View
      className={
        Platform.OS === "android" ? undefined : "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      }
      layout={layoutTransition}
      style={[
        animatedSurfaceStyle,
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
        tintColor="transparent"
        layout={layoutTransition}
        style={[{ position: "absolute", inset: 0 }, animatedSurfaceStyle]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedSurfaceStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const app = useApp();
  // The patched native stack also emits UIKit's finishTransitioning to this route.
  const navigation = useNavigation<
    NativeStackNavigationProp<RootStackParamList> & NavigationWithFinishTransitioning
  >();
  const { store, meta } = props;
  const hostId = store.controller.hostId;
  const openHostFile = useOpenHostFile(store);
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const composerPanel = materialTheme["--color-composer-panel"];
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useComposerTextRole();
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  // The settings are T3's root form-sheet route over this thread.
  const settingsRoutePresentedRef = useRef(false);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    onPresent: () => {
      if (settingsRoutePresentedRef.current) return;
      settingsRoutePresentedRef.current = true;
      navigation.navigate("ThreadSettings", { hostId, conversationId: conversationIdOf(store) });
    },
  });
  const disposeSettingsSheetPresentation = useEffectEvent(settingsSheetPresentation.dispose);
  const [draftMessage, setDraftMessage] = useState(() => app.draft(hostId, props.draftKey));
  // The draft as last edited, read after an answer settles to see whether it changed meanwhile.
  const latestDraft = useRef(draftMessage);
  const resetGeneration = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const draftIdentity = `${hostId}\0${props.draftKey}`;
  const committedDraftIdentity = useRef(draftIdentity);
  useLayoutEffect(() => {
    if (committedDraftIdentity.current === draftIdentity) return;
    committedDraftIdentity.current = draftIdentity;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    resetGeneration.current += 1;
    const text = app.draft(hostId, props.draftKey);
    latestDraft.current = text;
    setDraftMessage(text);
  }, [app, draftIdentity, hostId, props.draftKey]);
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
      latestDraft.current = value;
      props.onDraftChange?.(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => app.saveDraft(hostId, props.draftKey, value),
        DRAFT_SAVE_DELAY_MS,
      );
    },
    [app, hostId, props.draftKey, props.onDraftChange],
  );

  const conversationHasContent = draftMessage.trim().length > 0 || meta.attachments.length > 0;
  const restoreToConversationDraft = useCallback(
    (text: string) => {
      setDraftMessage(text);
      latestDraft.current = text;
      app.saveDraft(hostId, props.draftKey, text);
    },
    [app, hostId, props.draftKey],
  );
  // A prompt sent while its files uploaded comes back if one of them failed,
  // unless the user has typed something since.
  const unsentText = meta.unsentText;
  useEffect(() => {
    if (unsentText === null) return;
    const text = store.controller.takeUnsentText();
    if (text && latestDraft.current.trim() === "") restoreToConversationDraft(text);
  }, [restoreToConversationDraft, store, unsentText]);
  // T3 edits a queued message here, in its own draft; the conversation's draft waits unchanged.
  const queuedEdit = useComposerQueuedEdit({
    store,
    meta,
    inputRef,
    conversationDraftEmpty: !conversationHasContent,
    restoreToConversationDraft,
  });
  const editing = queuedEdit !== null;
  const { text, onChangeText, hasContent, stripAttachments, stripUploading, attachmentsFull, queuedAttachments, locked: draftLocked } =
    composerDraftView(queuedEdit, {
      text: draftMessage,
      onChangeText: onChangeDraftMessage,
      attachments: meta.attachments,
      uploading: meta.uploading,
    });
  const locked = draftLocked || props.disabled === true;
  // Stopping the agent is not what the send button means in edit mode.
  const showStopAction = !hasContent && props.canStopThread && !editing;
  const running = isSessionBusyStatus(meta.status);
  // Every send goes through the outbox; the label says whether it leaves now
  // or waits (for the connection or an earlier queued message).
  const sendPresentation = resolveComposerSendPresentation({
    editingQueuedMessage: editing,
    running,
    canSteer: isSteerableStatus(meta.status),
    followUpBehavior: "steer",
    deliveryDeferred: !props.connected || meta.queue.entries.length > 0 || meta.queue.held,
  });
  const sendLabel = sendPresentation.label;
  const isEditing = isFocused || settingsSheetPresentation.keepsComposerExpanded;
  const currentModelLabel = modelLabel(meta.run.provider, meta.run.model);
  const compactEditor = useCompactComposerEditor(bodyText, text, Platform.OS === "ios" && isFocused);
  const usesLargeControls = Platform.OS === "ios" && Platform.isPad;
  const controlSize = usesLargeControls ? "large" : "regular";
  const [compactRowWidth, setCompactRowWidth] = useState(0);
  const compactAttachmentLimit = compactRowWidth >= 500 ? 3 : 1;
  const editorTextStyle = { ...bodyText, color: foregroundColor };
  // A prompt may go while its files upload: the controller sends it when they
  // land. A queued message's edit still waits for its uploads.
  const sendBlockedReason = queuedEdit?.saving
    ? "Saving…"
    : (props.sendBlockedReason ?? (editing && stripUploading > 0 ? "Uploading attachments" : null));
  const canSend = hasContent && sendBlockedReason === null;

  // "Quote in reply" from a message's selection menu, as desktop's context
  // menu: the quote follows the draft, and the user types their reply below it.
  useEffect(
    () =>
      store.onQuoteInReply((selected) => {
        if (locked) return;
        const quoted = quotedReplyDraft(selected);
        if (!quoted) return;
        const next = text.trim() ? `${text}\n\n${quoted}` : quoted;
        onChangeText(next);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelection({ start: next.length, end: next.length });
        });
      }),
    [inputRef, locked, onChangeText, store, text],
  );

  // "Reference Session…" in the + menu, as desktop's drag from the sidebar:
  // the token goes in at the caret, and the user keeps typing after it.
  const selectionRef = useRef<ComposerEditorSelection | null>(null);
  const [referencing, setReferencing] = useState(false);
  const openReferencePicker = useCallback(() => {
    inputRef.current?.blur();
    setReferencing(true);
  }, [inputRef]);
  const closeReferencePicker = useCallback((thread: SolusThreadShell | null) => {
    setReferencing(false);
    let caret: number | null = null;
    if (thread && !locked) {
      const next = insertSessionReference(text, selectionRef.current, sessionReferenceOf(thread));
      onChangeText(next.text);
      caret = next.caret;
    }
    // The sheet must be gone before the editor can take focus.
    setTimeout(() => {
      inputRef.current?.focus();
      if (caret !== null) inputRef.current?.setSelection({ start: caret, end: caret });
    }, 300);
  }, [inputRef, locked, onChangeText, text]);

  // A question that closed unanswered gives back what the user typed for it.
  // It goes to the conversation's draft, not to a queued message being edited.
  useEffect(
    () =>
      store.onRemarksReturned((remarks) => {
        const next = draftWithUnsentRemarks(draftMessage, remarks);
        if (next !== draftMessage) restoreToConversationDraft(next);
      }),
    [draftMessage, restoreToConversationDraft, store],
  );

  // Keep the feed inset aligned with the card.
  useEffect(() => {
    onExpandedChange?.(compactEditor.isExpanded);
  }, [compactEditor.isExpanded, onExpandedChange]);

  const onEditorFocusChange = props.onEditorFocusChange;
  const onSheetEditorFocusChange = settingsSheetPresentation.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onSheetEditorFocusChange(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange, onSheetEditorFocusChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onSheetEditorFocusChange(false);
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange, onSheetEditorFocusChange]);

  const handleSend = useCallback(
    async (followUp?: ActiveTurnComposerAction) => {
      if (!canSend || inFlightRef.current) return;
      inFlightRef.current = true;
      await inputRef.current?.flushPendingInput();
      if (queuedEdit) {
        await queuedEdit.save();
        inFlightRef.current = false;
        return;
      }
      const prompt = latestDraft.current.trim();
      // An explicit Queue answers no request: the text waits behind the turn.
      const feedbackTarget = followUp === "queue" ? null : permissionForFeedback(meta.permissions);
      if (feedbackTarget) {
        // The card's request waits on the agent that asked, a subagent's
        // included. The text goes with its denial to that agent; sent as a
        // prompt it would reach the parent while the request stayed open.
        if (!prompt || meta.attachments.length > 0 || meta.uploading > 0) {
          inFlightRef.current = false;
          Alert.alert("Feedback is text only", "Remove the attachments to send feedback on this request.");
          return;
        }
        try {
          const answered = await store.controller.answerPermission(feedbackTarget.questionId, feedbackTarget.denyOptionId, prompt);
          // A refused answer, or a draft edited meanwhile, keeps the draft.
          if (answered && latestDraft.current.trim() === prompt) {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            resetGeneration.current += 1;
            setDraftMessage("");
            latestDraft.current = "";
            app.saveDraft(hostId, props.draftKey, "");
          }
        } finally {
          inFlightRef.current = false;
        }
        return;
      }
      resetGeneration.current += 1;
      setDraftMessage("");
      latestDraft.current = "";
      if (saveTimer.current) clearTimeout(saveTimer.current);
      try {
        const sending = (props.sendStore?.() ?? store).controller.send(prompt, {
          delivery: followUp ?? sendPresentation.action ?? undefined,
        });
        props.onSent?.();
        await sending;
        app.saveDraft(hostId, props.draftKey, "");
      } finally {
        inFlightRef.current = false;
      }
    },
    [app, canSend, draftMessage, hostId, inputRef, meta.attachments.length, meta.permissions, props.draftKey, props.onSent, props.sendStore, queuedEdit, sendPresentation.action, store],
  );

  const attach = useCallback(
    async (pick: (existingCount: number) => Promise<PickedFile[]>) => {
      if (locked) return;
      try {
        if (queuedEdit) {
          const files = await pick(queuedEdit.attachments.length);
          if (files.length > 0) await queuedEdit.attach(files);
          return;
        }
        const files = await pick(meta.attachments.length + meta.uploading);
        if (files.length > 0) void store.controller.attach(files);
      } catch (error) {
        Alert.alert("Could not attach", error instanceof Error ? error.message : String(error));
      }
    },
    [locked, meta.attachments.length, meta.uploading, queuedEdit, store],
  );
  const onPickDraftMedia = useCallback(() => attach(pickComposerMedia), [attach]);
  const onPickDraftFiles = useCallback(() => attach(pickComposerFiles), [attach]);
  const onPasteDraftImages = useCallback((uris: string[]) => void attach(pastedComposerImages(uris)), [attach]);
  // Files a desktop or web copy named, when this session's host holds them.
  const onPasteAttachmentRefs = useCallback(
    async (refs: ClipboardAttachmentRef[], pastedText: string | null) => {
      if (locked || queuedEdit) return false;
      const attached = await store.controller.attachHostFiles(refs);
      if (attached && pastedText) onChangeDraftMessage(withoutPastedText(latestDraft.current, pastedText));
      return attached;
    },
    [locked, onChangeDraftMessage, queuedEdit, store],
  );

  // A pending sheet presentation or focus restore has no composer left to act on.
  useEffect(() => () => disposeSettingsSheetPresentation(), []);
  // The sheet is dismissed by Done, Cancel, or a swipe. The editor regains focus
  // only when it had focus, or the keyboard was up, before the sheet opened.
  const onSettingsSheetDismissed = settingsSheetPresentation.onDismissed;
  useFocusEffect(
    useCallback(() => {
      if (!settingsRoutePresentedRef.current) return;
      settingsRoutePresentedRef.current = false;
      onSettingsSheetDismissed();
    }, [onSettingsSheetDismissed]),
  );
  // The native-stack patch exposes UIKit dismissal completion; restore the keyboard then.
  const onStackTransitionsFinished = settingsSheetPresentation.onStackTransitionsFinished;
  useEffect(
    () =>
      navigation.addListener("finishTransitioning", onStackTransitionsFinished),
    [navigation, onStackTransitionsFinished],
  );

  // A hardware Return sends while the composer has focus; Command-Return
  // sends from anywhere; Command-L focuses the composer.
  const sendFromKeyboard = () => {
    if (canSend) void handleSend();
  };
  useKeyboardCommand("send", sendFromKeyboard);
  useKeyboardCommand("focusInput", () => inputRef.current?.focus());

  return (
    <Animated.View
      className="px-[12px]"
      onLayout={(event) => props.onHeightChange?.(event.nativeEvent.layout.height)}
      style={{
        paddingTop: 4,
        paddingBottom:
          (props.bottomInset ?? 0) +
          THREAD_COMPOSER_BOTTOM_GUTTER.row,
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
      {referencing ? (
        <SessionReferencePicker
          hostId={hostId}
          currentSessionId={conversationIdOf(store)}
          onPick={closeReferencePicker}
          onClose={() => closeReferencePicker(null)}
        />
      ) : null}
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        <ComposerSurface
          animateLayout={false}
          style={{
            borderRadius: usesLargeControls ? 31 : 27,
            borderCurve: "circular",
            overflow: "hidden",
            paddingVertical: usesLargeControls ? 9 : 2,
          }}
        >
          {isEditing && queuedAttachments !== null ? (
            <Animated.View className="px-[14px] pb-2.5 pt-2" entering={COMPOSER_ATTACHMENT_ENTERING} exiting={FadeOut.duration(120)}>
              <ComposerQueuedEditAttachments
                attachments={queuedAttachments.attachments}
                disabled={queuedAttachments.saving}
                onRemove={queuedAttachments.remove}
              />
            </Animated.View>
          ) : null}
          {isEditing && (stripAttachments.length > 0 || stripUploading > 0) ? (
            <Animated.View className="px-[14px] pb-2.5 pt-2" entering={COMPOSER_ATTACHMENT_ENTERING} exiting={FadeOut.duration(120)}>
              <ComposerAttachmentStrip
                attachments={stripAttachments}
                uploading={stripUploading}
                onRemove={(id) => store.controller.removeAttachment(id)}
                onPressDocument={(attachment) => openHostFile(attachment.hostPath)}
              />
            </Animated.View>
          ) : null}
          <View onLayout={(event) => {
            compactEditor.onRowLayout(event);
            setCompactRowWidth(event.nativeEvent.layout.width);
          }}>
            <View className="flex-row items-end">
              <ComposerAttachmentButton
                size={controlSize}
                disabled={locked}
                attachmentsFull={attachmentsFull}
                supportsFiles
                onPickMedia={onPickDraftMedia}
                onPickFiles={onPickDraftFiles}
                onReferenceSession={openReferencePicker}
              />
              <Animated.View
                className="min-w-0 flex-1"
                onLayout={compactEditor.onEditorLayout}
                style={[
                  { minWidth: compactEditor.isExpanded || stripAttachments.length > 0 ? 0 : ONE_ROW_MIN_EDITOR_SHARE },
                  compactEditor.containerStyle,
                  compactEditor.isExpanded ? { flex: 0, width: 0 } : undefined,
                ]}
              />
              <Animated.View style={compactEditor.editorStyle}>
                <ComposerEditor
                  ref={inputRef}
                  readResetGeneration={() => resetGeneration.current}
                  onSubmit={(alternate) => { if (canSend) void handleSend(alternate ? sendPresentation.alternate ?? undefined : undefined); }}
                  enterBehavior="send"
                  submitTitle={sendLabel}
                  alternateSubmitTitle={
                    sendPresentation.alternate === null
                      ? sendLabel
                      : FOLLOW_UP_ACTION_LABEL[sendPresentation.alternate]
                  }
                  multiline
                  value={text}
                  onChangeText={onChangeText}
                  readOnly={locked}
                  placeholder={props.placeholder}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                  onPasteImages={onPasteDraftImages}
                  onPasteAttachmentRefs={onPasteAttachmentRefs}
                  onSelectionChange={(selection) => { selectionRef.current = selection; }}
                  {...compactEditor.editorProps}
                  textStyle={editorTextStyle}
                />
              </Animated.View>
              {!isEditing && (stripAttachments.length > 0 || stripUploading > 0) ? (
                <View className="h-[44px] shrink-0 flex-row items-center gap-1 pl-1">
                  {stripAttachments.slice(0, compactAttachmentLimit).map((attachment) => (
                    <ComposerAttachmentThumbnail key={attachment.id} attachment={attachment} size={30} borderRadius={8} compact />
                  ))}
                  {stripAttachments.length === 0 ? <ComposerUploadingThumbnail size={30} borderRadius={8} /> : null}
                  {stripAttachments.length > compactAttachmentLimit ? (
                    <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                      <Text className="text-foreground-muted text-2xs font-t3-bold">+{stripAttachments.length - compactAttachmentLimit}</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <View
                className="min-w-0 shrink flex-row items-center"
                style={compactEditor.isExpanded ? { flex: 1, justifyContent: "flex-end" } : undefined}
              >
                <Animated.View
                  key={compactEditor.isExpanded ? "expanded" : "compact"}
                  className="min-w-0 shrink flex-row items-center"
                  entering={compactEditor.toolbarControlsEntering}
                >
                  <View className="min-w-0 shrink">
                    <ComposerInlineControl
                    size={controlSize}
                    accessibilityLabel="Model and reasoning settings"
                    emphasized
                    label={currentModelLabel}
                    iconOnly={!compactEditor.isExpanded}
                    renderIcon={(size) => <ProviderIcon provider={meta.run.provider} size={size} />}
                    summary={compactEditor.isExpanded ? modelOptionsSummary(meta.run) : undefined}
                    maxWidth="100%"
                    onPress={settingsSheetPresentation.open}
                    />
                  </View>
                </Animated.View>
                {showStopAction ? (
                  <ComposerActionButton actionKey={`${hostId}:${conversationIdOf(store)}`} size={controlSize} accessibilityLabel="Stop agent" icon="stop.fill" variant="stop" onPress={props.onStopThread} />
                ) : (
                  <SendActionButton actionKey={`${hostId}:${conversationIdOf(store)}`} size={controlSize} accessibilityLabel={sendBlockedReason ?? sendLabel} presentation={sendPresentation} disabled={!canSend} onSend={(followUp) => void handleSend(followUp)} />
                )}
              </View>
            </View>
          </View>
        </ComposerSurface>
      </Animated.View>
    </Animated.View>
  );
});
