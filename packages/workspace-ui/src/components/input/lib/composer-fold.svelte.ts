import { untrack } from "svelte";
import { getSettingsContext, runtime } from "../../../contexts";
import {
  COMPOSER_REFOCUS_GRACE_MS,
  floatingLayerOf,
  keyboardHoldsComposerOpen,
  selectionHoldsComposerOpen,
  shouldCollapseComposer,
} from "./composer-collapse";
import {
  COMPOSER_COLLAPSED_ATTRIBUTE,
  composerSurfaceOf, measureFold, tweenComposerFold,
  type ComposerFoldTween, type FoldGeometry,
} from "./composer-fold";

interface ComposerFoldOptions {
  root: () => HTMLElement | null;
  tabId: () => string | undefined;
  enabled: () => boolean;
  recording: () => boolean;
  claimVoice: () => void;
}

/**
 * Owns focus, pointer and selection holds, and the fold animation (ADR-0027).
 * Ordinary focus changes settle after the current event, with no timed grace.
 * A closing menu or recorder gets time to return focus on a later frame.
 */
export function useComposerFold(options: ComposerFoldOptions) {
  const theme = getSettingsContext();
  // The bar has the keyboard: focus is in it or in a menu it opened, or it
  // is returning from a closing menu or recorder. Tracked on the bar's own box rather than the
  // host card so every host — dock, split pane, draft, web — gets the same
  // answer.
  let keyboardHeld = $state(false);
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  // A press that began outside the bar and has not been released. The leave
  // decision waits for the release, so a drag-select in the transcript never
  // folds the bar under the gesture, and a click's consequences — the focus
  // it asks for — can complete in the same event.
  let outsidePointerInFlight = false;
  let outsidePointerReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  // A live selection in the transcript is holding the bar open; it lets go
  // when the selection does.
  let heldBySelection = $state(false);

  function transcriptEl(): Element | null {
    const tabId = options.tabId();
    return tabId
      ? document.querySelector(
          `[data-conversation-tab-id="${CSS.escape(tabId)}"]`,
        )
      : null;
  }

  /** Defer the focus read until the current event has completed. */
  function scheduleSettle(delay = 0) {
    cancelSettle();
    settleTimer = setTimeout(settle, delay);
  }

  function cancelSettle() {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  }

  function settle() {
    settleTimer = null;
    if (outsidePointerInFlight) return;
    const root = options.root();
    if (!root) return;
    if (
      keyboardHoldsComposerOpen({
        root,
        activeElement: document.activeElement,
        documentHasFocus: document.hasFocus(),
      })
    )
      return;
    if (selectionHoldsComposerOpen(document.getSelection(), transcriptEl())) {
      heldBySelection = true;
      return;
    }
    heldBySelection = false;
    keyboardHeld = false;
  }

  $effect(() => {
    if (!heldBySelection) return;
    const release = () => {
      if (selectionHoldsComposerOpen(document.getSelection(), transcriptEl())) return;
      heldBySelection = false;
      scheduleSettle();
    };
    document.addEventListener("selectionchange", release);
    return () => document.removeEventListener("selectionchange", release);
  });

  // While the bar holds the keyboard, focus is watched on the document, not
  // on the bar: a menu that closes by letting go — a click on the transcript
  // with no return target — fires nothing on the bar's box, and a picker's
  // content is portalled outside it. Read focus after the event completes.
  $effect(() => {
    if (!keyboardHeld) return;
    const handleFocusChange = (event: FocusEvent) => {
      const isMenuClosing = event.type === "focusout" &&
        event.target instanceof Node && floatingLayerOf(event.target) !== null;
      scheduleSettle(isMenuClosing ? COMPOSER_REFOCUS_GRACE_MS : 0);
    };
    const releaseOutsidePointer = () => {
      if (!outsidePointerInFlight) return;
      outsidePointerInFlight = false;
      if (outsidePointerReleaseTimer !== null) clearTimeout(outsidePointerReleaseTimer);
      outsidePointerReleaseTimer = null;
      scheduleSettle();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (options.root()?.contains(target) || floatingLayerOf(target)) return;
      outsidePointerInFlight = true;
      // A release the page never sees — the pointer left the window — must
      // not hold the bar open for good.
      if (outsidePointerReleaseTimer !== null) clearTimeout(outsidePointerReleaseTimer);
      outsidePointerReleaseTimer = setTimeout(releaseOutsidePointer, 1500);
    };
    document.addEventListener("focusin", handleFocusChange, true);
    document.addEventListener("focusout", handleFocusChange, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", releaseOutsidePointer, true);
    document.addEventListener("pointercancel", releaseOutsidePointer, true);
    return () => {
      document.removeEventListener("focusin", handleFocusChange, true);
      document.removeEventListener("focusout", handleFocusChange, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", releaseOutsidePointer, true);
      document.removeEventListener("pointercancel", releaseOutsidePointer, true);
      cancelSettle();
      if (outsidePointerReleaseTimer !== null) clearTimeout(outsidePointerReleaseTimer);
      outsidePointerReleaseTimer = null;
      outsidePointerInFlight = false;
    };
  });

  // The mic gets a refocus grace. The keyboard is handed back
  // to the editor a frame later (composer-focus), inside the grace, so the
  // bar never folds on its own after a dictation. Should nothing hand it
  // back — the keyboard was elsewhere for the whole recording — it folds
  // once that refocus grace is up.
  let wasRecording = untrack(() => options.recording());
  $effect(() => {
    const recording = options.recording();
    const stopped = wasRecording && !recording;
    wasRecording = recording;
    if (!stopped) return;
    untrack(() => {
      keyboardHeld = true;
      scheduleSettle(COMPOSER_REFOCUS_GRACE_MS);
    });
  });

  function handleComposerFocusIn() {
    cancelSettle();
    keyboardHeld = true;
    options.claimVoice();
  }

  // The document watcher above attaches on the flush after the keyboard is
  // taken, so a leave in the same task as the focusin — a shortcut that
  // focuses the editor and opens a picker in one go — is caught here.
  function handleComposerFocusOut(event: FocusEvent) {
    const root = options.root();
    if (root && event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
    scheduleSettle();
  }

  // A phone keeps its toolbar: the `+` there is the only way to attach,
  // capture, or change the run, and collapsing it would cost a tap into the
  // field and a soft-keyboard pop before each. Same predicate as auto-focus.
  const isCollapsed = $derived(
    shouldCollapseComposer({
      enabled:
        options.enabled() &&
        theme.collapseComposerWhenIdle &&
        !runtime.shouldSuppressFocus,
      focused: keyboardHeld,
      recording: options.recording(),
    }),
  );

  // The fold tween is a FLIP: the layout flips in one step, and the card,
  // the prompt line, and the toolbar are animated from where they were to
  // where they are. The conversation column lays out once per fold instead
  // of once per frame. Hosts that mark no surface get the cut.
  let foldTween: ComposerFoldTween | null = null;
  let geometryBeforeFold: FoldGeometry | null = null;
  // Read before the DOM flips, so the tween starts from where the card is —
  // mid-tween, if the last fold was interrupted.
  $effect.pre(() => {
    void isCollapsed;
    geometryBeforeFold = untrack(() => {
      const root = options.root();
      const surface = root && composerSurfaceOf(root);
      return surface ? measureFold(surface) : null;
    });
  });
  $effect(() => {
    const collapsed = isCollapsed;
    untrack(() => {
      const root = options.root();
      const surface = root && composerSurfaceOf(root);
      // Written before the browser lays out, so the dock's resize observer —
      // which runs after layout — reads the flag belonging to the height it
      // just measured, and never holds a reservation against an expansion.
      surface?.toggleAttribute(COMPOSER_COLLAPSED_ATTRIBUTE, collapsed);
      foldTween = surface
        ? tweenComposerFold(surface, geometryBeforeFold, collapsed)
        : null;
    });
    return () => foldTween?.cancel();
  });

  return {
    get collapsed() { return isCollapsed; },
    handleFocusIn: handleComposerFocusIn,
    handleFocusOut: handleComposerFocusOut,
  };
}
