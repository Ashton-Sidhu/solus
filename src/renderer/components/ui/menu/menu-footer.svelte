<script lang="ts">
  import type { Snippet } from "svelte";
  import Kbd from "../Kbd.svelte";

  /** Teaches the keys. Pairs with `MenuSearch` on every list menu so the
   *  surface reads the same wherever it opens. Like `MenuSearch` it spans the
   *  full surface, so it sits beside the padded body in a `p-0` menu. */
  interface Props {
    /** Key/label pairs, left to right — `[["⏎", "check out"]]`. */
    hints: [key: string, label: string][];
    /** Right-aligned tally, e.g. "18 branches". */
    summary?: string;
    children?: Snippet;
  }
  let { hints, summary, children }: Props = $props();
</script>

<div
  class="flex items-center gap-4 rounded-b-[inherit] border-t border-(--solus-menu-hairline) bg-(--solus-menu-footer-bg) px-2.5 py-1.5"
>
  {#each hints as [key, label] (key)}
    <span class="flex items-center gap-1.5 text-menu-meta text-(--solus-text-tertiary)">
      <Kbd variant="hint">{key}</Kbd>{label}
    </span>
  {/each}
  <span class="flex-1"></span>
  {#if children}{@render children()}{/if}
  {#if summary}
    <span class="shrink-0 text-menu-meta tabular-nums text-(--solus-text-tertiary)">{summary}</span>
  {/if}
</div>
