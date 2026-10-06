// Adapted from T3 Code apps/mobile/src/components/ComposerEditor.tsx (MIT, see UPSTREAM.md).
import { useImperativeHandle, useRef, type Ref } from "react";
import { Platform, TextInput, type StyleProp, type TextInputInstance, type TextStyle, type ViewStyle } from "react-native";

import { MOBILE_FONTS } from "../lib/typography";

/**
 * T3's composer runs on its own native text editor (`t3-composer-editor`),
 * which this app does not ship. This is the same surface on a React Native
 * TextInput: the props the thread and new-task composers pass and the
 * imperative handle they hold. A hardware Return sends through the app's
 * `send` keyboard command. Context chips, skills, and rich paste are not part
 * of it.
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
  readonly style?: StyleProp<ViewStyle>;
  readonly textStyle?: TextStyle;
}

export function ComposerEditor(props: ComposerEditorProps) {
  const inputRef = useRef<TextInputInstance>(null);

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

  return (
    <TextInput
      ref={inputRef}
      accessibilityLabel={props.placeholder ?? "Message"}
      autoFocus={props.autoFocus}
      editable={props.editable !== false && props.readOnly !== true}
      multiline={props.multiline}
      scrollEnabled={props.scrollEnabled}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColorClassName="accent-placeholder"
      selectionColorClassName="accent-focus/32"
      cursorColorClassName="accent-focus"
      selectionHandleColorClassName={Platform.OS === "android" ? "accent-focus" : undefined}
      selection={props.selection}
      onSelectionChange={(event) => props.onSelectionChange?.(event.nativeEvent.selection)}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      textAlignVertical={props.singleLineCentered ? "center" : "top"}
      style={[
        {
          fontFamily: MOBILE_FONTS.regular,
          paddingHorizontal: 0,
          paddingTop: props.contentInsetVertical ?? 0,
          paddingBottom: props.contentInsetVertical ?? 0,
          ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
        },
        props.textStyle,
        props.style,
      ]}
    />
  );
}
