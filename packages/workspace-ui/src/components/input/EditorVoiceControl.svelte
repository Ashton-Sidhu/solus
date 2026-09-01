<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { uuid } from "@solus/contracts/uuid";
  import { getVoiceModelStore } from "../../contexts";
  import { dictation } from "../../lib/dictation.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import RecordingControls from "./RecordingControls.svelte";

  interface Props {
    onTranscript: (transcript: string) => void;
    focused: boolean;
    disabled?: boolean;
    showMic?: boolean;
  }

  let { onTranscript, focused, disabled = false, showMic = true }: Props = $props();

  const voiceModel = getVoiceModelStore();
  // A host with no transcription backend gets no mic, whatever the caller asked for.
  const micShown = $derived(showMic && voiceModel.supported);
  const voiceOwnerId = `editor-voice:${untrack(uuid)}`;
  const ownsVoice = $derived(dictation.messageOwner === voiceOwnerId);
  const voiceState = $derived(
    ownsVoice && dictation.mode === "message"
      ? (dictation.starting ? "recording" : dictation.state)
      : "idle",
  );

  function receiveTranscript(transcript: string): void {
    const text = transcript.trim();
    if (text) onTranscript(text);
  }

  function claim(): void {
    dictation.focusMessageConsumer(voiceOwnerId, receiveTranscript, () => false);
  }

  function toggle(): void {
    if (!voiceModel.ready || disabled) return;
    dictation.toggleConversationalFor(voiceOwnerId, receiveTranscript, () => false);
  }

  $effect(() => {
    if (focused) {
      claim();
      return;
    }
    if (
      ownsVoice &&
      (dictation.starting || dictation.state === "recording" || dictation.state === "transcribing")
    ) {
      return;
    }
    dictation.blurMessageConsumer(voiceOwnerId);
    if (ownsVoice) dictation.releaseMessageConsumer(voiceOwnerId);
  });

  useKeybinding("voice.toggle-recorder", toggle, {
    enabled: () =>
      ownsVoice &&
      focused &&
      voiceModel.ready &&
      !disabled &&
      dictation.focusedTarget === null,
  });

  onDestroy(() => dictation.releaseMessageConsumer(voiceOwnerId));
</script>

<RecordingControls
  variant="bar"
  state={voiceState}
  rmsRef={dictation.rmsRef}
  disabled={!voiceModel.ready || disabled}
  showMic={micShown}
  progressPct={voiceModel.ready ? null : voiceModel.progressPct}
  idleTooltip={voiceModel.ready
    ? `Voice input (${comboHint("voice.toggle-recorder")})`
    : "Voice model is preparing"}
  onCancel={() => dictation.cancel()}
  onConfirm={() => dictation.stop()}
  onToggle={toggle}
/>
