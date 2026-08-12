<script lang="ts">
  import type { Snippet } from "svelte";

  /** A filter miss, rendered as a washed panel rather than a bare column, so it
   *  reads as a state of the list rather than an empty page. */
  interface Props {
    title: string;
    children?: Snippet;
    actions?: Snippet;
  }
  let { title, children, actions }: Props = $props();
</script>

<div
  class="mt-2.5 flex flex-col items-center gap-1.5 rounded-2xl bg-[var(--wash-1)] py-[70px]"
>
  <span class="text-sm font-medium ">{title}</span>
  {#if children}
    <span class="text-xs text-muted-foreground">{@render children()}</span>
  {/if}
  {#if actions}
    <div class="mt-2 flex items-center gap-2">{@render actions()}</div>
  {/if}
</div>
