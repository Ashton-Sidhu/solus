<script lang="ts">
  import { cn } from "../../lib/utils";
  import { pickRandomTip } from "./lib/solus-tips";

  let { class: className }: { class?: string } = $props();

  // Picked once at mount; the home stays mounted per tab, so the tip does not
  // re-roll on every render.
  const tip = pickRandomTip();
</script>

<p
  class={cn(
    "flex items-baseline justify-center gap-1.5 whitespace-nowrap text-[0.8125rem] leading-relaxed text-(--solus-text-tertiary)",
    className,
  )}
>
  <span class="font-medium text-(--solus-text-secondary)">Tip</span>
  <span>{tip}</span>
</p>
