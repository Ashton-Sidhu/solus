import { untrack } from "svelte";
import { getSettingsContext, getWorkspaceContext, getClientShellContext, getVoiceModelStore } from "../../../contexts";
import type { PromptDelivery } from "@solus/contracts/types";
import type PromptEditor from "../../ui/PromptEditor.svelte";
import { dictation, isDictationTarget } from "../../../lib/dictation.svelte";
import { useKeybinding } from "../../../lib/keybindings/use-keybinding.svelte";
import { requestInputFocus } from "../../../lib/inputFocus";
import { toasts } from "../../../lib/toasts";
import { VoiceRetryTracker } from "./voice-retry.svelte";

interface ComposerVoiceOptions {
  ownerId: string;
  active: () => boolean;
  isPrimary: () => boolean;
  isReadOnly: () => boolean;
  isConnecting: () => boolean;
  isBusy: () => boolean;
  text: () => string;
  editor: () => ReturnType<typeof PromptEditor> | null;
  sendPrompt: (text: string, options?: { refocus?: boolean; delivery?: PromptDelivery; background?: boolean }) => boolean;
}

/** Binds the shared recorder to one mounted composer and its visibility. */
export function useComposerVoice(options: ComposerVoiceOptions) {
  const theme = getSettingsContext();
  const session = getWorkspaceContext();
  const clientShell = getClientShellContext();
  const voiceModel = getVoiceModelStore();
  const voiceModeEnabled = $derived(theme.voiceModeEnabled);
  // The app-wide voice controller owns the single recorder, shared with plain
  // fields' dictation. This bar drives its conversational ('message') mode.
  const voice = dictation;
  const voiceRetry = new VoiceRetryTracker();
  let retryClock = $state(Date.now());

  // The recorder is shared, so gate this bar's voice UI on conversational mode:
  // a plain field dictating elsewhere must not light up the input bar. Primary
  // and split composers claim ownership on focus so transcripts land in the
  // draft the user is actually working in.
  const voiceOwnerId = options.ownerId;
  const ownsVoice = $derived(voice.messageOwner === voiceOwnerId);
  const voiceState = $derived(
    ownsVoice && voice.mode === "message" ? voice.state : "idle",
  );

  // Lazy-mount the waveform: once true, never resets so the canvas stays alive.
  let hasMountedWaveform = $state(false);
  $effect(() => {
    if (voiceState === "recording") hasMountedWaveform = true;
  });

  // Pure derived — no timers. Covers the full recording→transcribing→idle→
  // recording cycle without flickering because the Dictation layer re-arms
  // synchronously in onIdle (setting voice.starting=true in the same microtask
  // as the idle transition, before any Svelte render).
  const showWaveform = $derived(
    voiceState === "recording" ||
      (voiceState === "transcribing" && voiceModeEnabled) ||
      (voiceState === "idle" && voiceModeEnabled && voice.starting),
  );
  const voiceControlState = $derived<"idle" | "recording" | "transcribing">(
    voice.starting && showWaveform ? "recording" : voiceState,
  );

  // The whole mic cycle holds the bar open, not only the frames the waveform
  // is on screen: the mic-permission wait before it, and the transcription
  // after it, when the editor is back but disabled. Folding in either gap and
  // unfolding when the transcript landed read as a stutter after every
  // dictation.
  const micHoldsBarOpen = $derived(
    showWaveform ||
      voiceState !== "idle" ||
      (ownsVoice && voice.mode === "message" && voice.starting),
  );

  function handleVoiceTranscript(transcript: string) {
    const text = transcript.trim();
    if (!text || options.isConnecting() || options.isReadOnly()) return;
    if (theme.autoSendVoiceTranscripts) {
      options.sendPrompt(text, { refocus: false });
    } else {
      options.editor()?.insertTranscript(text);
    }
  }

  function claimVoice(startIfEnabled = false) {
    if (!options.active() || options.isReadOnly()) return;
    const claimed = voice.claimMessageConsumer(
      voiceOwnerId,
      handleVoiceTranscript,
      () => canAutoStart(),
    );
    if (claimed && startIfEnabled && canAutoStart())
      voice.startConversational();
  }

  function toggleVoice() {
    voice.toggleConversationalFor(voiceOwnerId, handleVoiceTranscript, () =>
      canAutoStart(),
    );
  }

  // The visible primary composer is the default owner. A split composer takes
  // over when the user focuses or activates its controls.
  $effect(() => {
    if (!options.active()) return;
    const ownerId = voiceOwnerId;
    // Claiming reads recorder state to decide whether auto-start is allowed.
    // Keep those reads out of this ownership effect: otherwise starting the
    // recorder reruns the effect, whose cleanup immediately cancels it.
    if (options.isPrimary()) untrack(() => claimVoice(true));
    return () => voice.releaseMessageConsumer(ownerId);
  });

  // ─── Voice mode effects ───

  // Conditions under which conversational voice mode may (re)arm the mic. Note
  // there is NO `isBusy` gate: voice stays live while Claude is running so the
  // user can keep dictating follow-ups, which queue as messages. We yield the
  // mic whenever a plain-input field owns dictation (dictation.focusedTarget).
  function canAutoStart(): boolean {
    const errorAllowsStart =
      voice.errorKind === null ||
      (voice.errorKind === "transient" && voiceRetry.canRetry(retryClock));
    return (
      voiceModeEnabled &&
      voiceModel.ready &&
      options.active() &&
      ownsVoice &&
      clientShell.visible &&
      !options.isReadOnly() &&
      errorAllowsStart &&
      voice.state === "idle" &&
      options.text().trim().length === 0 &&
      dictation.focusedTarget === null
    );
  }

  let prevVoiceErrorKind = untrack(() => voice.errorKind);
  $effect(() => {
    const kind = voice.errorKind;
    if (kind === prevVoiceErrorKind) return;
    prevVoiceErrorKind = kind;
    if (kind === null) voiceRetry.reset();
    else voiceRetry.note(kind);
  });

  let prevVoiceError = untrack(() => voice.error);
  $effect(() => {
    const error = voice.error;
    if (error === prevVoiceError) return;
    prevVoiceError = error;
    if (error && options.active() && ownsVoice) {
      toasts.error("Dictation unavailable", { description: error });
    }
  });

  $effect(() => {
    const nextRetryAt = voiceRetry.nextRetryAt;
    if (!nextRetryAt) return;
    const delayMs = Math.max(0, nextRetryAt - Date.now());
    const timer = window.setTimeout(() => {
      retryClock = Date.now();
    }, delayMs);
    return () => window.clearTimeout(timer);
  });

  $effect(() => {
    // Only the active bar cancels; the inactive instance must not touch the
    // shared recorder — it would immediately kill the active bar's recording.
    if (
      options.active() &&
      ownsVoice &&
      options.isReadOnly() &&
      (voiceState === "recording" || voice.starting)
    )
      voice.cancel();
    if (options.isReadOnly()) options.editor()?.clearCompletions();
  });

  let previousShellVisible = untrack(() => clientShell.visible);
  $effect(() => {
    const visible = clientShell.visible;
    const becameVisible = visible && !previousShellVisible;
    previousShellVisible = visible;
    if (!options.active()) return;
    if (becameVisible && options.isPrimary() && !session.unifiedPickerOpen && !options.isReadOnly())
      requestInputFocus();
    if (!visible && ownsVoice && (voiceState === "recording" || voice.starting))
      voice.cancel();
  });

  // Single source of truth for (re)arming the recorder. Fires on any rising
  // edge that should resume listening: voice mode enabled, window shown, a turn
  // finishing, or a transcript completing (transcribing → idle) so the next
  // utterance can be queued even mid-turn. A user cancel goes recording → idle
  // (never through "transcribing"), so it does NOT re-arm — that's the escape
  // hatch to type instead of talk.
  let prevVoiceMode = untrack(() => voiceModeEnabled);
  let prevVisible = untrack(() => clientShell.visible);
  let prevIsBusy = untrack(() => options.isBusy());
  let prevVoiceState = untrack(() => voiceState);
  let prevDictationFocus = untrack(() => dictation.focusedTarget);
  let prevVoiceModelReady = untrack(() => voiceModel.ready);
  $effect(() => {
    if (!ownsVoice) return;
    const enabled = voiceModeEnabled;
    const visible = clientShell.visible;
    const busy = options.isBusy();
    const vstate = voiceState;
    const dictationFocus = dictation.focusedTarget;
    const modelReady = voiceModel.ready;
    const retryReady =
      voice.errorKind === "transient" && voiceRetry.canRetry(retryClock);

    if (prevVoiceMode && !enabled && (vstate === "recording" || voice.starting))
      voice.cancel();
    if (!prevVoiceMode && enabled) {
      voiceRetry.reset();
      voice.clearError();
    }

    const shouldArm =
      (enabled && !prevVoiceMode) ||
      (visible && !prevVisible) ||
      (prevIsBusy && !busy) ||
      (!prevVoiceModelReady && modelReady) ||
      retryReady ||
      (prevVoiceState === "transcribing" && vstate === "idle") ||
      (prevDictationFocus !== null && dictationFocus === null); // plain field released the mic

    prevVoiceMode = enabled;
    prevVisible = visible;
    prevIsBusy = busy;
    prevVoiceState = vstate;
    prevDictationFocus = dictationFocus;
    prevVoiceModelReady = modelReady;

    if (shouldArm && canAutoStart()) voice.startConversational();
  });

  useKeybinding(
    "voice.toggle-mode",
    () => theme.update({ voiceModeEnabled: !theme.voiceModeEnabled }),
    {
      enabled: () => options.active() && ownsVoice && !options.isReadOnly(),
    },
  );
  useKeybinding("voice.toggle-recorder", toggleVoice, {
    enabled: () =>
      options.active() &&
      ownsVoice &&
      !options.isReadOnly() &&
      // The mic is hidden on a host that cannot transcribe, so the shortcut
      // that toggles it must go quiet too rather than opening a recording no
      // one can finish.
      voiceModel.supported &&
      !isDictationTarget(document.activeElement),
  });

  return {
    get retryExhausted() { return voiceRetry.exhausted; },
    get ownsVoice() { return ownsVoice; },
    get state() { return voiceState; },
    get hasMountedWaveform() { return hasMountedWaveform; },
    get showWaveform() { return showWaveform; },
    get controlState() { return voiceControlState; },
    get holdsBarOpen() { return micHoldsBarOpen; },
    claim: claimVoice,
    toggle: toggleVoice,
  };
}
