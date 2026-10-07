<script lang="ts">
  import type { Snippet } from "svelte";

  /** An avatar with a status glyph on its lower-right rim — a reviewer's
   *  verdict, for one. The glyph sits on a disc of the surface behind it, so
   *  it reads as a mark on the person rather than a smudge over them. With no
   *  badge the avatar renders bare. The caller owns the avatar, the glyph, and
   *  the word for screen readers. */
  let {
    children,
    badge,
    surface = "bg-background",
    class: className = "",
  }: {
    children: Snippet;
    badge?: Snippet;
    /** The fill behind the glyph: the surface the avatar sits on. */
    surface?: string;
    class?: string;
  } = $props();
</script>

<span class="relative inline-grid shrink-0 place-items-center {className}">
  {@render children()}
  {#if badge}
    <span class="absolute -right-1 -bottom-1 grid place-items-center rounded-full p-px {surface}" aria-hidden="true">
      {@render badge()}
    </span>
  {/if}
</span>
