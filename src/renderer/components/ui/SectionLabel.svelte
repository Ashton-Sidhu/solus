<script lang="ts">
  import type { Snippet } from "svelte";

  /** Micro-caps group header with a hairline rule that fades out to the right
   *  (same treatment as the builder card titles). `first:pt-1` tightens the
   *  first section when the label leads its list wrapper. */
  interface Props {
    label: string;
    count?: number;
    icon?: Snippet;
  }
  let { label, count, icon }: Props = $props();
</script>

<div
  class="flex items-center gap-2.5 pb-2 pt-6 text-[0.625rem] font-semibold uppercase tracking-[0.09em] text-(--solus-text-tertiary) first:pt-1"
>
  {#if icon}
    <span class="inline-flex shrink-0 items-center">{@render icon()}</span>
  {/if}
  <span>{label}</span>
  {#if count !== undefined}
    <span class="tabular-nums opacity-70">{count}</span>
  {/if}
  <span
    class="h-px flex-1 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--solus-container-border)_70%,transparent),transparent)]"
    aria-hidden="true"
  ></span>
</div>
