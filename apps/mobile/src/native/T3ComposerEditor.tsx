// Adapted from T3 Code (MIT, commit 1c01db02b3; see UPSTREAM.md).
/* eslint-disable complexity -- Keep the upstream native event bridge together for future ports. */
import { requireNativeView } from "expo";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { Platform, StyleSheet } from "react-native";

import { MOBILE_FONTS, MOBILE_TYPOGRAPHY } from "../lib/typography";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { createNativeComposerTheme } from "../lib/nativeComposerTheme";
import { TextInputWrapper } from "expo-paste-input";
import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";
import type { ComposerEditorProps, ComposerEditorSelection } from "../components/ComposerEditor";

const NATIVE_MODULE_NAME = "T3ComposerEditor";

type NativeEditorEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

type NativeSelectionEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

type NativePasteImagesEvent = NativeSyntheticEvent<{
  readonly uris: ReadonlyArray<string>;
}>;

type NativePasteTextEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly eventCount: number;
  readonly text: string;
  readonly selection: ComposerEditorSelection;
}>;

interface NativeComposerEditorRef {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  setSelection: (start: number, end: number) => Promise<void>;
}

interface NativeComposerEditorProps extends ViewProps {
  readonly ref?: Ref<NativeComposerEditorRef>;
  readonly controlledDocumentJson: string;
  readonly clipboardFragment: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly singleLineCentered: boolean;
  readonly editable: boolean;
  readonly readOnly: boolean;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  readonly enterBehavior: string;
  readonly submitEnabled: boolean;
  readonly onComposerChange: (event: NativeEditorEvent) => void;
  readonly onComposerSelectionChange?: (event: NativeSelectionEvent) => void;
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void;
  readonly onComposerContextPress?: (
    event: NativeSyntheticEvent<{ source: string; start: number; end: number }>,
  ) => void;
  readonly onComposerPasteContext?: (
    event: NativePasteTextEvent & NativeSyntheticEvent<{ fragment: string; html: string }>,
  ) => void;
  readonly textPasteThresholdBytes: number;
  readonly maxInputChars: number;
  readonly onComposerPasteText?: (event: NativePasteTextEvent) => void;
  readonly onComposerFocus?: () => void;
  readonly onComposerBlur?: () => void;
  readonly onComposerContentSizeChange?: (
    event: NativeSyntheticEvent<{ readonly width: number; readonly height: number }>,
  ) => void;
  readonly onComposerSubmit?: (event: NativeSyntheticEvent<{ alternate: boolean }>) => void;
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME);

// A view command rejects with "Unable to find the view" when the composer's native view is
// unmounted, which can happen while an open question hides the composer slot. There is nothing
// to act on then.
function settleViewCommand(command: Promise<void> | undefined): void {
  command?.catch(() => undefined);
}

export function ComposerEditor({
  ref,
  selection,
  style,
  textStyle,
  onChangeText,
  onSelectionChange,
  onPasteImages,
  onPasteText,
  onFocus,
  onBlur,
  onContentSizeChange,
  onSubmit,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps) {
  const focusedRef = useRef(false);
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [, forceNativeEventRender] = useState(0);
  // Start history empty so restored drafts or recycled views receive a non-echo controlled payload.
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([]);
  const theme = useUniwindTheme();
  useImperativeHandle(ref, () => ({
    focus: () => settleViewCommand(nativeRef.current?.focus()),
    blur: () => settleViewCommand(nativeRef.current?.blur()),
    isFocused: () => focusedRef.current,
    setSelection: (next) => settleViewCommand(nativeRef.current?.setSelection(next.start, next.end)),
    flushPendingInput: async () => {},
  }), []);
  const tokensJson = "[]";
  const handlePaste = (payload: import("expo-paste-input").PasteEventPayload) => {
    if (payload.type === "images") onPasteImages?.(payload.uris);
  };
  // Every render resolves against the snapshot history, so a render whose
  // (value, selection) lags the acknowledged native state is stamped behind
  // the native revision and rejected by the editor instead of re-applying a
  // stale caret or stale text mid-typing.
  /* oxlint-disable react/refs -- Native controlled edits must reconcile against the last acknowledged native event before sending the next payload. */
  const controlledEventCount = resolveComposerControlledEventCount(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    props.value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );
  /* oxlint-enable react/refs */
  const isNativeEcho =
    controlledEventCount === mostRecentEventCount && acknowledgesLatestNativeEvent;
  const controlledDocumentJson = JSON.stringify({
    value: props.value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prunes native editor event snapshots once a committed payload acknowledges them
  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;
    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(
      nativeEventSnapshotsRef.current,
      mostRecentEventCount,
    );
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount, nativeEventSnapshotsRef]);
  const assumedValue = props.value;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the committed controlled payload as the native editor's assumed state
  useEffect(() => {
    // Newer native events make this payload stale; do not record it as applied.
    if (isNativeEcho || controlledEventCount !== mostRecentEventCountRef.current) return;
    nativeEventSnapshotsRef.current = assumeComposerControlledState(
      nativeEventSnapshotsRef.current,
      controlledEventCount,
      assumedValue,
    );
  }, [
    assumedValue,
    controlledEventCount,
    isNativeEcho,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Every changed native payload, including selection-only changes, must update the assumed native snapshot.
    controlledDocumentJson,
    nativeEventSnapshotsRef,
  ]);
  const acceptNativeEvent = useCallback(
    (eventCount: number, value: string, nextSelection: ComposerEditorSelection) => {
      const acknowledgedEventCount = acknowledgeComposerNativeEvent(
        mostRecentEventCountRef.current,
        eventCount,
      );
      if (acknowledgedEventCount === null) {
        return false;
      }
      mostRecentEventCountRef.current = acknowledgedEventCount;
      nativeEventSnapshotsRef.current.push({
        eventCount: acknowledgedEventCount,
        value,
        selection: nextSelection,
      });
      return acknowledgedEventCount;
    },
    [nativeEventSnapshotsRef],
  );
  const themeJson = JSON.stringify({
    ...createNativeComposerTheme(theme),
    selection: Platform.OS === "android" ? theme["--color-focus"] : null,
  });
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  return (
    <TextInputWrapper onPaste={handlePaste} style={[{ minHeight: 0 }, style]}>
      <NativeView
        ref={nativeRef}
        controlledDocumentJson={controlledDocumentJson}
        clipboardFragment={props.clipboardFragment ?? ""}
        themeJson={themeJson}
        placeholder={props.placeholder ?? ""}
        fontFamily={
          resolvedTextStyle.fontFamily ?? MOBILE_FONTS.regular
        }
        fontSize={
          resolvedTextStyle.fontSize ?? MOBILE_TYPOGRAPHY.body.fontSize
        }
        lineHeight={
          resolvedTextStyle.lineHeight ?? MOBILE_TYPOGRAPHY.body.lineHeight
        }
        contentInsetVertical={contentInsetVertical}
        singleLineCentered={props.singleLineCentered ?? false}
        editable={props.editable ?? true}
        readOnly={props.readOnly ?? false}
        scrollEnabled={props.scrollEnabled ?? true}
        autoFocus={props.autoFocus ?? false}
        autoCorrect={props.autoCorrect ?? true}
        spellCheck={props.spellCheck ?? true}
        enterBehavior={props.enterBehavior ?? (Platform.OS === "ios" ? "newline" : "send")}
        submitEnabled={onSubmit !== undefined}
        textPasteThresholdBytes={onPasteText ? 0 : 0}
        maxInputChars={2147483647}
        style={{ flex: 1, minHeight: 0 }}
        onComposerChange={(event) => {
          const acknowledgedEventCount = acceptNativeEvent(
            event.nativeEvent.eventCount,
            event.nativeEvent.value,
            event.nativeEvent.selection,
          );
          if (acknowledgedEventCount === false) return;
          onChangeText(event.nativeEvent.value);
          onSelectionChange?.(event.nativeEvent.selection);
          setMostRecentEventCount(acknowledgedEventCount);
          forceNativeEventRender((sequence) => sequence + 1);
        }}
        onComposerSelectionChange={(event) => {
          const acknowledgedEventCount = acceptNativeEvent(
            event.nativeEvent.eventCount,
            event.nativeEvent.value,
            event.nativeEvent.selection,
          );
          if (acknowledgedEventCount === false) return;
          // Android selection events may precede text changes; publish text and revision together to reject stale drafts.
          if (event.nativeEvent.value !== props.value) {
            onChangeText(event.nativeEvent.value);
          }
          onSelectionChange?.(event.nativeEvent.selection);
          setMostRecentEventCount(acknowledgedEventCount);
          forceNativeEventRender((sequence) => sequence + 1);
        }}
        onComposerPasteImages={(event) => onPasteImages?.([...event.nativeEvent.uris])}
        onComposerContextPress={(event) => props.onContextPress?.(event.nativeEvent)}
        onComposerPasteContext={(event) => {
          const paste = event.nativeEvent;
          const acknowledgedEventCount = acceptNativeEvent(
            paste.eventCount,
            paste.value,
            paste.selection,
          );
          if (acknowledgedEventCount === false) return;
          onChangeText(paste.value);
          onSelectionChange?.(paste.selection);
          props.onPasteContext?.(paste);
          setMostRecentEventCount(acknowledgedEventCount);
          forceNativeEventRender((sequence) => sequence + 1);
        }}
        onComposerPasteText={(event) => {
          const paste = event.nativeEvent;
          const acknowledgedEventCount = acceptNativeEvent(
            paste.eventCount,
            paste.value,
            paste.selection,
          );
          if (acknowledgedEventCount === false) return;
          // Sync before capturing async paste targets; props may lag the last native keystroke.
          onChangeText(paste.value);
          onSelectionChange?.(paste.selection);
          onPasteText?.(paste);
          setMostRecentEventCount(acknowledgedEventCount);
          forceNativeEventRender((sequence) => sequence + 1);
        }}
        onComposerFocus={() => { focusedRef.current = true; onFocus?.(); }}
        onComposerBlur={() => { focusedRef.current = false; onBlur?.(); }}
        onComposerContentSizeChange={
          onContentSizeChange === undefined
            ? undefined
            : (event) => onContentSizeChange(event.nativeEvent)
        }
        onComposerSubmit={
          onSubmit === undefined
            ? undefined
            : (event) => onSubmit(event.nativeEvent.alternate === true)
        }
      />
    </TextInputWrapper>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "../components/ComposerEditor";
