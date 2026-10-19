// Adapted from T3 Code apps/mobile/src/components/ComposerEditor.tsx (MIT, see UPSTREAM.md).
import { TextInputWrapper, type PasteEventPayload } from "expo-paste-input";
import { useImperativeHandle, useRef, type Ref } from "react";
import { Platform, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputInstance, type TextStyle, type ViewStyle } from "react-native";

import { MOBILE_FONTS } from "../lib/typography";

/**
 * T3's composer runs on its own native text editor (`t3-composer-editor`),
 * which this app does not ship. This is the same surface on a React Native
 * TextInput: the props the thread and new-task composers pass and the
 * imperative handle they hold. A hardware Return sends through the app's
 * `send` keyboard command. As in T3, `expo-paste-input` hands images pasted
 * with the system Paste command to `onPasteImages`; text pastes natively.
 * Context chips and skills are not part of it.
 */
export interface ComposerEditorSelection {
  readonly start: number;
  readonly end: number;
}

export interface ComposerEditorHandle {
  focus(): void;
  blur(): void;
  isFocused(): boolean;
  setSelection(selection: ComposerEditorSelection): void;
}

export interface ComposerEditorProps {
  readonly ref?: Ref<ComposerEditorHandle>;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly autoFocus?: boolean;
  readonly editable?: boolean;
  readonly readOnly?: boolean;
  readonly scrollEnabled?: boolean;
  /** A collapsed one-line field centers its text in the pill. */
  readonly singleLineCentered?: boolean;
  readonly contentInsetVertical?: number;
  readonly selection?: ComposerEditorSelection;
  readonly onSelectionChange?: (selection: ComposerEditorSelection) => void;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  /** Local file URIs of images the user pasted. */
  readonly onPasteImages?: (uris: string[]) => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly textStyle?: TextStyle;
}

/** The editor's font: the measurement below must lay text out exactly as the editor does. */
function editorFont(textStyle: TextStyle | undefined): TextStyle {
  return {
    fontFamily: MOBILE_FONTS.regular,
    ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
    ...textStyle,
  };
}

export function ComposerEditor(props: ComposerEditorProps) {
  // Read apart from the other props: the React Compiler treats every read of
  // an object that holds a ref as a ref read during render.
  const { ref } = props;
  const inputRef = useRef<TextInputInstance>(null);
  const inputStyle = {
    paddingHorizontal: 0,
    paddingTop: props.contentInsetVertical ?? 0,
    paddingBottom: props.contentInsetVertical ?? 0,
    ...editorFont(props.textStyle),
    ...StyleSheet.flatten(props.style),
  };

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      isFocused: () => inputRef.current?.isFocused() ?? false,
      setSelection: (selection) => inputRef.current?.setSelection(selection.start, selection.end),
    }),
    [],
  );

  const onPaste = (payload: PasteEventPayload) => {
    if (payload.type === "images" && payload.uris.length > 0) props.onPasteImages?.(payload.uris);
  };

  return (
    <TextInputWrapper onPaste={onPaste}>
      <View>
        <TextInput
          ref={inputRef}
          accessibilityLabel={props.placeholder ?? "Message"}
          autoFocus={props.autoFocus}
          editable={props.editable !== false && props.readOnly !== true}
          multiline={props.multiline}
          scrollEnabled={props.scrollEnabled}
          value={props.value}
          onChangeText={props.onChangeText}
          selection={props.selection}
          onSelectionChange={(event) => props.onSelectionChange?.(event.nativeEvent.selection)}
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          textAlignVertical={props.singleLineCentered ? "center" : "top"}
          style={inputStyle}
        />
        {props.value.length === 0 && props.placeholder ? (
          <View
            pointerEvents="none"
            accessible={false}
            style={[StyleSheet.absoluteFill, {
              justifyContent: props.singleLineCentered ? "center" : "flex-start",
              paddingTop: inputStyle.paddingVertical ?? inputStyle.paddingTop,
              paddingBottom: inputStyle.paddingVertical ?? inputStyle.paddingBottom,
              paddingHorizontal: inputStyle.paddingHorizontal,
            }]}
          >
            <Text
              className="text-placeholder"
              numberOfLines={1}
              ellipsizeMode="tail"
              accessible={false}
              style={{
                fontFamily: inputStyle.fontFamily,
                fontSize: inputStyle.fontSize,
                fontWeight: inputStyle.fontWeight,
                lineHeight: inputStyle.lineHeight,
                letterSpacing: inputStyle.letterSpacing,
                includeFontPadding: inputStyle.includeFontPadding,
              }}
            >
              {props.placeholder}
            </Text>
          </View>
        ) : null}
      </View>
    </TextInputWrapper>
  );
}

/**
 * A hidden copy of an editor's text, laid out by the platform text engine
 * (TextKit on iOS, StaticLayout on Android) in the editor's font, inside a
 * frame the caller positions. `onLines` receives each layout's lines with
 * their exact substrings, so a caller can tell which text a layout measured.
 * Fabric sends a text layout only when the lines change.
 */
export function ComposerTextMeasure(props: {
  readonly text: string;
  readonly textStyle?: TextStyle;
  readonly frameStyle: ViewStyle;
  readonly onLines: (lines: ReadonlyArray<{ readonly text: string }>) => void;
}) {
  const font = editorFont(props.textStyle);
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[props.frameStyle, { opacity: 0 }]}
    >
      <Text
        accessible={false}
        style={{
          fontFamily: font.fontFamily,
          fontSize: font.fontSize,
          fontStyle: font.fontStyle,
          fontWeight: font.fontWeight,
          letterSpacing: font.letterSpacing,
          includeFontPadding: font.includeFontPadding,
        }}
        onTextLayout={(event) => props.onLines(event.nativeEvent.lines)}
      >
        {props.text}
      </Text>
    </View>
  );
}
