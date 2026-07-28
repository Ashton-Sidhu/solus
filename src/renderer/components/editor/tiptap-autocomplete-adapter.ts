import type { Editor } from "@tiptap/core";
import type { AutocompleteEditor } from "./autocomplete-editor";
import type { ReferenceToken } from "./reference-tokens";
import * as refs from "./references";

export function createTiptapAutocompleteAdapter(
  getEditor: () => Editor | null,
  focusEditor: () => void,
  getCursorRect: () => DOMRect | null,
): AutocompleteEditor {
  return {
    textBeforeCursor: () => refs.textBeforeCursor(getEditor()),
    cursorRect: getCursorRect,
    focus: focusEditor,
    replaceTrigger(pattern, replacement) {
      return refs.updateTriggerText(getEditor(), pattern, replacement);
    },
    insertReference(token, pattern) {
      return refs.insertReference(getEditor(), token, pattern);
    },
    unwrapFileReferenceBeforeCursor() {
      const editor = getEditor();
      const selection = editor?.state.selection;
      if (!editor || !selection?.empty) return false;
      const nodeBefore = selection.$from.nodeBefore;
      if (nodeBefore?.type.name !== "fileReference") return false;
      return refs.unwrapFileReference(
        editor,
        selection.from - nodeBefore.nodeSize,
      );
    },
    extractTrackedReferences: () => refs.extractRefs(getEditor()),
    isCaretAtStart: () => refs.isCaretAtStart(getEditor()),
  };
}
