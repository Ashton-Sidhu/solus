<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { uuid } from "@solus/contracts/uuid";
  import { hosts } from "../../contexts";
  import { dictation } from "../../lib/dictation.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import RecordingControls from "./RecordingControls.svelte";
  import VoiceTranscriptPreview from "./VoiceTranscriptPreview.svelte";

  interface Props {
    onTranscript: (transcript: string) => void;
    focused: boolean;
    disabled?: boolean;
    showMic?: boolean;
  }

  let { onTranscript, focused, disabled = false, showMic = true }: Props = $props();

  const voiceHost = $derived(hosts.transcription);
  const voiceReady = $derived(voiceHost?.voiceReady ?? false);
  // A host with no transcription backend gets no mic, whatever the caller asked for.
  const micShown = $derived(showMic && voiceHost?.transcribes === true);
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
    if (!voiceReady || disabled) return;
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
      voiceReady &&
      !disabled &&
      dictation.focusedTarget === null,
  });

  onDestroy(() => dictation.releaseMessageConsumer(voiceOwnerId));
</script>

<div class="relative flex shrink-0 items-center gap-1">
  {#if voiceState !== "idle" && (dictation.partialTranscript.stable || dictation.partialTranscript.tentative)}
    <div class="absolute bottom-full right-0 z-20 mb-2 w-64 max-w-[80vw] rounded-lg border border-(--solus-popover-border) bg-(--solus-popover-bg) p-3 text-workspace-chrome shadow-(--solus-popover-shadow)">
      <VoiceTranscriptPreview partial={dictation.partialTranscript} />
    </div>
  {/if}
  <RecordingControls
    variant="bar"
    state={voiceState}
    rmsRef={dictation.rmsRef}
    disabled={!voiceReady || disabled}
    showMic={micShown}
    progressPct={voiceReady ? null : voiceHost?.voiceProgressPct ?? null}
    idleTooltip={voiceReady
      ? `Voice input (${comboHint("voice.toggle-recorder")})`
      : "Voice model is preparing"}
    onCancel={() => dictation.cancel()}
    onConfirm={() => dictation.stop()}
    onToggle={toggle}
  />
</div>
