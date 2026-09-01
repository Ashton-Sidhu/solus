<script lang="ts">
  // The review guide's own layout, drawn small: the sticky "why" column on the
  // left — a title and a line of prose — beside the stacked diff cards it
  // explains. Every stock icon we tried named a *metaphor* for reviewing
  // (a book, a map, glasses); this names the thing you actually open.
  //
  // Two weights, on the phosphor contract the call sites already use, so the
  // mark keeps its silhouette between states: `regular` for a guide still being
  // written, `fill` for one ready to read.
  interface Props {
    size?: number;
    weight?: "regular" | "fill";
    class?: string;
  }
  let { size = 16, weight = "regular", class: className = "" }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="currentColor"
  class={className}
  aria-hidden="true"
  focusable="false"
>
  <!-- The "why" column. Its bars stay solid in both weights: at 14px a hollow
       1px bar is a smudge, not a line of text. They are also drawn heavier than
       the layout would suggest — a mark sitting beside phosphor glyphs has to
       match their *ink*, not their bounding box, or it reads as an absence. -->
  <rect x="1.3" y="5.8" width="5" height="2" rx="0.7" />
  <rect x="1.3" y="8.7" width="3.5" height="1.7" rx="0.65" opacity="0.7" />

  <!-- The diffs. Same outer bounds in both weights, so only the ink changes. -->
  {#if weight === "fill"}
    <rect x="8" y="2.7" width="6.8" height="4.6" rx="1.2" />
    <rect x="8" y="8.7" width="6.8" height="4.6" rx="1.2" />
  {:else}
    <g fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="8.75" y="3.45" width="5.3" height="3.1" rx="0.9" />
      <rect x="8.75" y="9.45" width="5.3" height="3.1" rx="0.9" />
    </g>
  {/if}
</svg>
