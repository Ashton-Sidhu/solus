<script lang="ts">
  /** A green line with a light fill under it, through percentages (0 to 100), the newest
   *  on the right. It keeps its size with fewer than two readings, so nothing moves when they come. */
  import { sparklinePath } from "./sparkline";

  interface Props {
    values: readonly number[];
    /** Size the line: the box stretches to it. */
    class?: string;
    /** Name what the line shows. Without it, the line is decoration. */
    label?: string;
  }

  let { values, class: className = "", label }: Props = $props();
  const path = $derived(sparklinePath(values));
</script>

<svg viewBox="0 0 100 24" preserveAspectRatio="none" class={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
  {#if path}
    <path d="{path} L 100 24 L 0 24 Z" style:fill="color-mix(in oklch, var(--success) 12%, transparent)" />
    <path d={path} fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke" style:stroke="var(--success)" />
  {/if}
</svg>
