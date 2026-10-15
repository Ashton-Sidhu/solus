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

export function ComposerEditor(props: ComposerEditorProps) {
  const inputRef = useRef<TextInputInstance>(null);
  const inputStyle = {
    fontFamily: MOBILE_FONTS.regular,
    paddingHorizontal: 0,
    paddingTop: props.contentInsetVertical ?? 0,
    paddingBottom: props.contentInsetVertical ?? 0,
    ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
    ...props.textStyle,
    ...StyleSheet.flatten(props.style),
  };

  useImperativeHandle(
    props.ref,
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
