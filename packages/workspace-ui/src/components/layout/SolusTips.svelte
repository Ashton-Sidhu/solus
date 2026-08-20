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
    "flex max-w-full items-baseline justify-center gap-1.5 whitespace-normal text-center text-pretty text-workspace-chrome leading-relaxed text-(--solus-text-tertiary)",
    className,
  )}
>
  <span class="font-medium text-(--solus-text-secondary)">Tip</span>
  <span class="min-w-0">{tip}</span>
</p>
