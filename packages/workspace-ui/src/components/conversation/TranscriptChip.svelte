<script lang="ts">
  import type { Snippet } from "svelte";

  /** The only tinted thing on a transcript card. The kicker states the type, so a
   *  chip is free to carry state and nothing else — one word, never a dot. */
  type ChipState =
    | "neutral"
    | "positive"
    | "active"
    | "warning"
    | "destructive";

  interface Props {
    state?: ChipState;
    class?: string;
    children: Snippet;
  }
  let { state = "neutral", class: extraClass = "", children }: Props = $props();

  const TINT = {
    neutral:
      "background:color-mix(in oklch, var(--foreground) 6%, transparent);color:var(--muted-foreground)",
    positive:
      "background:color-mix(in oklch, var(--chart-3) 18%, transparent);color:color-mix(in oklch, var(--chart-3) 70%, var(--foreground))",
    active:
      "background:color-mix(in oklch, var(--primary) 13%, transparent);color:color-mix(in oklch, var(--primary) 82%, var(--foreground))",
    warning:
      "background:color-mix(in oklch, var(--chart-2) 18%, transparent);color:color-mix(in oklch, var(--chart-2) 62%, var(--foreground))",
    destructive:
      "background:color-mix(in oklch, var(--destructive) 14%, transparent);color:color-mix(in oklch, var(--destructive) 78%, var(--foreground))",
  } satisfies Record<ChipState, string>;
</script>

<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-[0.125rem] text-transcript-meta leading-[1.35] font-medium {extraClass}"
  style={TINT[state]}
>
  {@render children()}
</span>
