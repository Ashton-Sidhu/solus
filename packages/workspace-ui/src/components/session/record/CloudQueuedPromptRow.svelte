<script lang="ts">
  import type { CloudQueuedPrompt } from "@solus/contracts/types";
  import { Button } from "../../ui/button";
  import { queuedPromptStateLabel } from "./lib/cloud-queue";

  /** One prompt on the cloud's queue: the bubble, where it is, and the way to take it back. */
  let { prompt, canCancel, onCancel }: { prompt: CloudQueuedPrompt; canCancel: boolean; onCancel: () => void } = $props();

  const label = $derived(queuedPromptStateLabel(prompt));
  const settled = $derived(prompt.state === "cancelled" || prompt.state === "failed");
</script>

<div class="flex flex-col items-end gap-1 py-1.5" data-testid="cloud-queued-prompt" data-state={prompt.state}>
  <div class="max-w-[85%] rounded-2xl rounded-br-md border border-(--solus-container-border) bg-(--solus-container-bg) px-4 py-2.5 whitespace-pre-wrap text-(--solus-text-primary) {settled ? 'opacity-60' : ''}">{prompt.text}</div>
  <div class="flex min-h-7 items-center gap-2 text-[0.875em] text-(--solus-text-tertiary)">
    {#if prompt.author.displayName}
      <span class="truncate">{prompt.author.displayName}</span>
      <span aria-hidden="true">·</span>
    {/if}
    <span class={prompt.state === "failed" ? "text-destructive" : ""} data-testid="cloud-queued-prompt-state">{label}</span>
    {#if canCancel}
      <Button size="xs" variant="ghost" onclick={onCancel} aria-label="Cancel this prompt">Cancel</Button>
    {/if}
  </div>
</div>
