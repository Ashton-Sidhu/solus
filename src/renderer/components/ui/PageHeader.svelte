<script lang="ts">
  import type { Snippet } from "svelte";

  /** Page identity block for library surfaces: an accent icon tile, title,
   *  quiet subtitle, and the page's actions on the right. */
  interface Props {
    title: string;
    subtitle?: string | Snippet;
    /** Glyph rendered inside the accent tile (size 18 reads best). */
    icon: Snippet;
    actions?: Snippet;
  }
  let { title, subtitle, icon, actions }: Props = $props();
</script>

<header class="flex items-center justify-between gap-4 pb-5">
  <div class="flex min-w-0 items-center gap-3">
    <span
      class="grid size-9 shrink-0 place-items-center rounded-[0.75rem] bg-(--solus-accent-light) text-(--solus-accent)"
      aria-hidden="true"
    >
      {@render icon()}
    </span>
    <div class="min-w-0">
      <h1
        class="truncate text-[1.0625rem] font-semibold tracking-[-0.02em] text-(--solus-text-primary)"
      >
        {title}
      </h1>
      {#if typeof subtitle === "string"}
        <p class="truncate text-xs text-(--solus-text-tertiary)">{subtitle}</p>
      {:else if subtitle}
        <p class="truncate text-xs text-(--solus-text-tertiary)">
          {@render subtitle()}
        </p>
      {/if}
    </div>
  </div>
  {#if actions}
    <div class="flex shrink-0 items-center gap-1.5">{@render actions()}</div>
  {/if}
</header>
