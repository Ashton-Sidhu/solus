<script lang="ts">
  import type { Snippet } from "svelte";

  /** A filter miss: a quiet statement where the rows would be, with the way
   *  back out. No panel and no fill, so it reads as the list saying it is
   *  empty rather than as a box placed on the page. */
  interface Props {
    title: string;
    children?: Snippet;
    actions?: Snippet;
  }
  let { title, children, actions }: Props = $props();
</script>

<div class="flex flex-col items-center gap-1 px-4 pt-20 pb-10 text-center">
  <span class="text-sm font-medium text-foreground">{title}</span>
  {#if children}
    <span class="max-w-[25rem] text-sm text-muted-foreground">{@render children()}</span>
  {/if}
  {#if actions}
    <div class="mt-3 flex flex-wrap items-center justify-center gap-2">{@render actions()}</div>
  {/if}
</div>
