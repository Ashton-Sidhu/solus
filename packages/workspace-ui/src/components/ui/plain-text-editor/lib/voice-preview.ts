/*
 * The words dictation has heard so far, drawn where the transcript will land.
 * Like the completion ghost it is a widget, not document text: it never enters
 * the value the composer emits, and the final transcript replaces it in place.
 */
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { VoicePartial } from "@solus/contracts/voice-stream";
import { dictationInsertion } from "../../../input/lib/dictation-text";

export const setVoicePreview = StateEffect.define<VoicePartial | null>();

class VoicePreviewWidget extends WidgetType {
  constructor(
    readonly stable: string,
    readonly tentative: string,
  ) {
    super();
  }

  eq(other: VoicePreviewWidget): boolean {
    return other.stable === this.stable && other.tentative === this.tentative;
  }

  toDOM(): HTMLElement {
    const host = document.createElement("span");
    host.className = "solus-voice-preview";
    host.setAttribute("aria-hidden", "true");
    const tentative = document.createElement("span");
    tentative.className = "solus-voice-preview__tentative";
    tentative.append(document.createTextNode(this.tentative));
    host.append(document.createTextNode(this.stable), tentative);
    return host;
  }

  updateDOM(host: HTMLElement): boolean {
    const stable = host.firstChild;
    const tentative = host.lastChild?.firstChild;
    if (!(stable instanceof Text) || !(tentative instanceof Text)) return false;
    if (this.stable !== stable.data) {
      if (this.stable.startsWith(stable.data)) stable.appendData(this.stable.slice(stable.length));
      else stable.data = this.stable;
    }
    if (this.tentative !== tentative.data) tentative.data = this.tentative;
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function previewAt(state: EditorState, partial: VoicePartial | null): DecorationSet {
  const spoken = partial ? (partial.stable + partial.tentative).trim() : "";
  if (!partial || !spoken) return Decoration.none;
  const { from, to } = state.selection.main;
  // The same separators `insertTranscript` adds, so the final text does not shift.
  const spaced = dictationInsertion(
    spoken,
    state.doc.sliceString(Math.max(0, from - 1), from),
    state.doc.sliceString(to, to + 1),
  );
  const stableEnd = spaced.indexOf(spoken) + partial.stable.trimStart().length;
  // Side -1 keeps the caret after the words, and scrolling follows their end.
  const widget = new VoicePreviewWidget(spaced.slice(0, stableEnd), spaced.slice(stableEnd));
  return Decoration.set([Decoration.widget({ widget, side: -1 }).range(to)]);
}

export const voicePreview = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setVoicePreview)) return previewAt(transaction.state, effect.value);
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function showVoicePreview(view: EditorView, partial: VoicePartial | null): void {
  if (!partial && view.state.field(voicePreview).size === 0) return;
  view.dispatch({
    effects: partial
      ? [setVoicePreview.of(partial), EditorView.scrollIntoView(view.state.selection.main.to, { y: "nearest" })]
      : setVoicePreview.of(null),
  });
}
