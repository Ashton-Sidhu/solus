<script lang="ts">
  import { Brain as BrainIcon } from "@lucide/svelte";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import { clickEndsTextSelection } from "./lib/text-selection";
  import { firstThoughtPreview } from "../../lib/thought-preview";
  import ThoughtText from "./ThoughtText.svelte";

  /**
   * One step in an open tool group: what the agent thought before the tool
   * call below it. Collapsed to its first line; opening it shows the full text.
   */
  let { messageId, thoughts }: { messageId: string; thoughts: string[] } = $props();

  // The open state belongs to the conversation, so it survives the virtual
  // row being recycled.
  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`thought:${messageId}`));
  const preview = $derived(firstThoughtPreview(thoughts));
</script>

<div class="flex flex-col py-1">
  <button
    type="button"
    class="flex min-w-0 items-center gap-2.5 overflow-hidden rounded-sm border-0 bg-transparent p-0 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium)"
    aria-expanded={view.expanded}
    data-testid="thought-step"
    onclick={(e) => {
      if (clickEndsTextSelection(e.currentTarget)) return;
      view.expanded = !view.expanded;
    }}
  >
    <span class="inline-flex h-4.5 w-5.5 shrink-0 items-center justify-center text-(--muted-foreground) opacity-50">
      <BrainIcon class="size-(--text-tool-step)" />
    </span>
    <!-- Same face, size, and tone as the tool steps around it. -->
    <span class="truncate text-tool-step font-mono opacity-80">
      {view.expanded || !preview ? "Thought" : preview}
    </span>
  </button>
  {#if view.expanded}
    <div class="ml-8 mt-1">
      <ThoughtText {thoughts} step />
    </div>
  {/if}
</div>
