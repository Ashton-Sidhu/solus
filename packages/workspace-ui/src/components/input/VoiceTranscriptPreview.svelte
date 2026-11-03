<script lang="ts">
  import type { VoicePartial } from "@solus/contracts/voice-stream";

  let { partial, compact = false }: { partial: VoicePartial; compact?: boolean } = $props();
  let content: HTMLSpanElement | undefined = $state();

  // Keep the newest words in view without moving focus or editing the draft.
  $effect(() => {
    partial;
    if (!content) return;
    if (compact) content.scrollLeft = content.scrollWidth;
    else content.scrollTop = content.scrollHeight;
  });
</script>

<span
  bind:this={content}
  class="block min-w-0 text-(--solus-text-primary) {compact ? 'overflow-hidden whitespace-pre' : 'max-h-32 overflow-y-auto whitespace-pre-wrap wrap-anywhere'}"
  aria-label="Live transcription preview"
><span>{partial.stable}</span><span class="text-(--solus-text-tertiary)">{partial.tentative}</span></span>
