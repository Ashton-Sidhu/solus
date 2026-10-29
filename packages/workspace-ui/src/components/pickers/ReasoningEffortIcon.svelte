<script lang="ts">
  import type { ReasoningEffort } from "@solus/contracts/types";
  import { reasoningEffortBars } from "./lib/reasoning-effort-level";

  /** Reasoning effort as four rising bars, the filled ones counting the level:
   *  the state is on the row without a word, and the word is in the tooltip. */
  interface Props {
    effort: ReasoningEffort | null | undefined;
    size?: number;
    class?: string;
  }
  let { effort, size = 16, class: className }: Props = $props();
  const filled = $derived(reasoningEffortBars(effort));
  const heights = [8, 12, 16, 20];
</script>

<svg width={size} height={size} viewBox="0 0 24 24" class={className} aria-hidden="true">
  {#each heights as height, index (index)}
    <rect
      x={3 + index * 5}
      y={22 - height}
      width="3.6"
      height={height}
      rx="1"
      fill="currentColor"
      opacity={index < filled ? 1 : 0.28}
    />
  {/each}
</svg>
