<script lang="ts">
  import TranscriptCard from "../conversation/TranscriptCard.svelte";

  interface Props {
    title?: string;
    workType?: "doc" | "slides" | "diagram" | "artifact";
    /** The content written so far, for the word count. */
    content?: string;
  }
  let { title, workType = "doc", content = "" }: Props = $props();

  const words = $derived(content.trim() ? content.trim().split(/\s+/).length : 0);
</script>

<!-- The same 40px line as the card that lands, so nothing reflows when it
     swaps in. -->
<div role="status" aria-label="Writing {workType}" data-testid="work-generating">
  <TranscriptCard title={title || "Untitled"} type="writing {workType}">
    {#snippet glyph()}<span class="activity-spinner"></span>{/snippet}
    {#snippet rail()}
      <span class="flex w-[4.375rem] flex-col gap-[0.1875rem]" aria-hidden="true">
        <span class="h-[0.1875rem] rounded-sm bg-[color-mix(in_oklch,var(--foreground)_9%,transparent)]"></span>
        <span class="h-[0.1875rem] w-12 rounded-sm bg-[color-mix(in_oklch,var(--foreground)_9%,transparent)]"></span>
      </span>
      {#if words > 0}<span>{words} words</span>{/if}
    {/snippet}
  </TranscriptCard>
</div>
