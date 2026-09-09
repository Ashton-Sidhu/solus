import { untrack } from "svelte";
import { getWorkspaceContext, runtime } from "../../../contexts";
import type { Prompt } from "@solus/contracts/types";
import type PromptEditor from "../../ui/PromptEditor.svelte";
import { localApi } from "@solus/client-core/local-api";
import { FOCUS_INPUT_EVENT, requestInputFocus } from "../../../lib/inputFocus";
import { quotedReplyDraft } from "../../../lib/quoted-reply";

interface ComposerFocusOptions {
  active: () => boolean;
  isPrimary: () => boolean;
  isReadOnly: () => boolean;
  ownsVoice: () => boolean;
  voiceState: () => "idle" | "recording" | "transcribing";
  showWaveform: () => boolean;
  session: () => ReturnType<ReturnType<typeof getWorkspaceContext>["sessionFor"]>;
  editor: () => ReturnType<typeof PromptEditor> | null;
  prompt: () => Prompt;
  tabId: () => string | undefined;
  receivesFocusedInput: () => boolean;
  isFocusedPaneComposer: () => boolean;
  refocusComposer: () => void;
}

/** Routes focus and quote requests only to the visible, addressed composer. */
export function useComposerFocus(options: ComposerFocusOptions) {
  const session = getWorkspaceContext();
  // Recording replaces the editor with the waveform. Once the recorder settles
  // and the editor is visible again, return keyboard input to the composer.
  // The mic stops holding the bar open in this same flush and the focus lands
  // a frame later, well inside the bar's fold grace (ADR-0027), so the bar
  // never folds on its own after a dictation.
  let previousVoiceStateForFocus = untrack(() => options.voiceState());
  $effect(() => {
    const previousState = previousVoiceStateForFocus;
    const currentState = options.voiceState();
    previousVoiceStateForFocus = currentState;

    if (
      !options.active() ||
      !options.ownsVoice() ||
      previousState === "idle" ||
      currentState !== "idle" ||
      options.showWaveform()
    )
      return;

    requestAnimationFrame(() => {
      if (options.active() && options.ownsVoice() && options.voiceState() === "idle" && !options.showWaveform()) {
        options.refocusComposer();
      }
    });
  });

  let prevFocusable = untrack(() => options.active() && !session.unifiedPickerOpen);
  $effect(() => {
    if (!options.isPrimary()) return;
    void options.session()?.run.workingDirectory;
    void options.session()?.readOnlyReason;
    const isFocusable = options.active() && !session.unifiedPickerOpen;
    const justBecameFocusable = isFocusable && !prevFocusable;
    prevFocusable = isFocusable;

    if (!isFocusable || options.isReadOnly() || runtime.shouldSuppressFocus) return;

    if (justBecameFocusable) {
      // rAF ensures focus lands after display:none → visible transitions
      requestAnimationFrame(() => {
        if (options.active() && !session.unifiedPickerOpen && !options.isReadOnly()) {
          options.editor()?.focus();
        }
      });
      return;
    }

    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (
      focusedElement &&
      focusedElement !== document.body &&
      (focusedElement.tagName === "INPUT" ||
        focusedElement.tagName === "TEXTAREA" ||
        focusedElement.isContentEditable)
    ) {
      return;
    }
    options.editor()?.focus();
  });

  // "Quote in reply": main sends the selected conversation text when the user
  // picks it from the native right-click menu. Prepend it as a markdown
  // blockquote so they can type their message addressing that snippet. Only the
  // active-mode bar subscribes (both pill+editor instances stay mounted).
  function insertQuote(text: string) {
    const quoted = quotedReplyDraft(text);
    if (!quoted) return;
    const existing = options.prompt().text;
    const next = existing.trim() ? `${existing}\n\n${quoted}` : quoted;
    options.prompt().text = next;
    options.editor()?.setValueAndCursor(next, true, true);
    requestInputFocus();
  }

  $effect(() => {
    if (!options.active()) return;
    return localApi.onQuoteSelection((text, sourceTabId) => {
      if (sourceTabId !== options.tabId() || options.isReadOnly()) return;
      insertQuote(text);
    });
  });

  $effect(() => {
    if (!options.active() || !options.receivesFocusedInput()) return;
    const p = session.pendingInput;
    if (!p) return;
    if (options.isReadOnly()) {
      session.update({ pendingInput: null });
      return;
    }
    options.prompt().text = p;
    session.update({ pendingInput: null });
    requestInputFocus();
  });

  $effect(() => {
    const handleFocusRequest = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      const requestedTabId = detail?.tabId;
      if (
        requestedTabId === undefined
          ? !options.isFocusedPaneComposer()
          : requestedTabId !== options.tabId()
      )
        return;
      if (!options.active() || session.unifiedPickerOpen || options.isReadOnly()) return;
      requestAnimationFrame(() => {
        if (options.active() && !session.unifiedPickerOpen && !options.isReadOnly()) {
          options.editor()?.focus();
        }
      });
    };
    window.addEventListener(FOCUS_INPUT_EVENT, handleFocusRequest);
    return () =>
      window.removeEventListener(FOCUS_INPUT_EVENT, handleFocusRequest);
  });

}
