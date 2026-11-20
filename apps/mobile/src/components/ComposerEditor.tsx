// Adapted from T3 Code apps/mobile/src/components/ComposerEditor.tsx (MIT, see UPSTREAM.md).
import { type Ref } from "react";
import { type StyleProp, type TextStyle, type ViewStyle } from "react-native";

import type { ClipboardAttachmentRef } from "@solus/client-core/attachment-clipboard";
import { parseAttachmentClipboardHtml } from "@solus/client-core/attachment-clipboard";
import { ComposerEditor as NativeComposerEditor } from "../native/T3ComposerEditor";

export interface ComposerEditorSelection {
  readonly start: number;
  readonly end: number;
}

export interface ComposerEditorHandle {
  focus(): void;
  blur(): void;
  isFocused(): boolean;
  flushPendingInput(): Promise<void>;
  setSelection(selection: ComposerEditorSelection): void;
}

export interface ComposerEditorProps {
  readonly ref?: Ref<ComposerEditorHandle>;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onContentSizeChange?: (size: { readonly width: number; readonly height: number }) => void;
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
  /**
   * Host files a Solus copy named, read from the clipboard's HTML. Answers true
   * when they were attached; then a pasted image does not upload again.
   * `pastedText` is the copy's plain text the field inserted, for the composer
   * to take back out.
   */
  readonly onPasteAttachmentRefs?: (refs: ClipboardAttachmentRef[], pastedText: string | null) => Promise<boolean>;
  readonly readResetGeneration?: () => number;
  readonly enterBehavior?: "send" | "newline";
  readonly submitTitle?: string;
  readonly alternateSubmitTitle?: string;
  readonly onSubmit?: (alternate: boolean) => void;
  readonly autoCorrect?: boolean;
  readonly spellCheck?: boolean;
  readonly clipboardFragment?: string;
  readonly onContextPress?: (selection: ComposerEditorSelection & { source: string }) => void;
  readonly onPasteText?: (paste: { value: string; text: string; selection: ComposerEditorSelection }) => void;
  readonly onPasteContext?: (paste: { value: string; text: string; html: string; fragment: string; selection: ComposerEditorSelection }) => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly textStyle?: TextStyle;
}

export function ComposerEditor(props: ComposerEditorProps) {
  return <NativeComposerEditor {...props} onPasteContext={(paste) => {
    // Insert text before asynchronous attachment work so later typing is preserved.
    const next = paste.value.slice(0, paste.selection.start) + paste.text + paste.value.slice(paste.selection.end);
    props.onChangeText(next);
    const refs = parseAttachmentClipboardHtml(paste.html);
    if (refs) void props.onPasteAttachmentRefs?.(refs, paste.text);
  }} />;
}
