import { EditorView } from "@codemirror/view";
import { HTML_ANCHOR } from "@solus/client-core/composer-rich-text";
import type { ReferenceParseOptions } from "../../../editor/reference-tokens";
import { isPasteAsTextChord, readComposerPaste, type ComposerPaste } from "../../../input/lib/composer-clipboard";

export function richTextInput(
  enabled: () => boolean,
  getReferences: () => ReferenceParseOptions | undefined,
  onPaste: (event: ClipboardEvent, paste: ComposerPaste) => void,
  onDrop: (event: DragEvent) => void,
) {
  let pasteAsText = false;
  return EditorView.domEventHandlers({
    keydown(event) {
      // The browser still dispatches paste. ClipboardEvent carries no modifiers.
      pasteAsText = isPasteAsTextChord(event);
      return false;
    },
    blur() {
      pasteAsText = false;
      return false;
    },
    paste(event, view) {
      const literal = pasteAsText;
      pasteAsText = false;
      const data = event.clipboardData;
      if (!enabled() || !data || !view.state.facet(EditorView.editable)) return false;
      const { from, to } = view.state.selection.main;
      const paste = readComposerPaste(data, view.state.doc.toString(), from, to, literal, getReferences());
      onPaste(event, paste);
      if (event.defaultPrevented) return true;
      if ((!paste.restored && !paste.literal) || !paste.text) return false;
      view.dispatch({ ...view.state.replaceSelection(paste.text), userEvent: "input.paste", scrollIntoView: true });
      return true;
    },
    drop(event, view) {
      onDrop(event);
      const data = event.dataTransfer;
      if (
        event.defaultPrevented || !enabled() || !data || data.files.length ||
        !view.state.facet(EditorView.editable) || !HTML_ANCHOR.test(data.getData("text/html"))
      ) return event.defaultPrevented;
      const from = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
      if (from === null) return false;
      const paste = readComposerPaste(data, view.state.doc.toString(), from, from, false, getReferences());
      if (!paste.restored) return false;
      const insert = view.state.toText(paste.text);
      view.focus();
      view.dispatch({
        changes: { from, insert },
        selection: { anchor: from, head: from + insert.length },
        userEvent: "input.drop",
      });
      return true;
    },
  });
}
