/*
 * The grey completion the selected match draws ahead of the caret, with the → badge
 * that says how to take it. The text is supplied by the autocomplete controller
 * and always equals what pressing → produces, so the preview is the outcome.
 *
 * It is a widget rather than real document text: nothing about it is editable,
 * it never enters the value the composer emits, and deleting the trigger simply
 * stops it being drawn.
 */
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

const setGhost = StateEffect.define<string>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const host = document.createElement("span");
    host.className = "solus-ghost";
    host.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "solus-ghost__text";
    text.textContent = this.text;
    const key = document.createElement("span");
    key.className = "solus-ghost__key";
    key.textContent = "→";
    host.append(text, key);
    return host;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export const ghostCompletion = StateField.define<{
  text: string;
  decorations: DecorationSet;
}>({
  create() {
    return { text: "", decorations: Decoration.none };
  },
  update(value, transaction) {
    let text = value.text;
    for (const effect of transaction.effects) {
      if (effect.is(setGhost)) text = effect.value;
    }
    // Any edit invalidates the completion until the controller recomputes it,
    // so a stale suggestion never trails a caret that has moved on.
    if (transaction.docChanged && text === value.text) text = "";
    if (text === value.text && !transaction.docChanged && !transaction.selection)
      return value;
    if (!text) return { text: "", decorations: Decoration.none };
    const head = transaction.state.selection.main.head;
    return {
      text,
      decorations: Decoration.set([
        Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(head),
      ]),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

export function showGhost(view: EditorView, text: string): void {
  if (view.state.field(ghostCompletion).text === text) return;
  view.dispatch({ effects: setGhost.of(text) });
}
