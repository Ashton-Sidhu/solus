<script lang="ts">
  import { Brain as BrainIcon } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import ActivityRow from "./ActivityRow.svelte";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import { firstThoughtPreview } from "../../lib/thought-preview";
  import ThoughtText from "./ThoughtText.svelte";

  /**
   * What the agent thought before a prose block, on the same row every
   * activity takes. Collapsed to its first line — reasoning is context for the
   * answer, not the answer.
   */
  let { message, skipMotion = false }: { message: Message; skipMotion?: boolean } = $props();

  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`thought:${message.id}`));
  const thoughts = $derived(message.thoughts ?? []);
  const preview = $derived(firstThoughtPreview(thoughts));

  // No refocus: opening a thought means the user wants to read it.
  function toggle(): void {
    view.expanded = !view.expanded;
  }
</script>

{#snippet previewText()}{preview}{/snippet}

<!-- `activity-host` opts this row out of the transcript's paint containment,
     which would otherwise clip the row's rounded chassis flat. -->
<div class="activity-host {skipMotion ? '' : 'animate-msg-in-side'}">
  <ActivityRow
    expanded={view.expanded}
    nested
    onToggle={toggle}
    target={preview && !view.expanded ? previewText : undefined}
    proseTarget
    testid="thought-row"
  >
    {#snippet glyph()}<BrainIcon size={11} />{/snippet}
    {#snippet label()}Thought{/snippet}
    {#snippet detail()}<ThoughtText {thoughts} />{/snippet}
  </ActivityRow>
</div>
