<script lang="ts">
  import { LoaderCircle } from "@lucide/svelte";
  import { Button } from "../ui/button";

  /** The end of the list: the next page loads when asked, never on
   *  scroll, so the list does not grow under the reader. Past the cap the
   *  answer is a narrower question, not another page. */
  let { loading, capped, onLoad }: {
    loading: boolean;
    /** The list holds as many rows as it will page to. */
    capped: boolean;
    onLoad: () => void;
  } = $props();
</script>

<div class="flex justify-center pt-3 pb-5 text-xs text-muted-foreground">
  {#if loading}
    <span class="flex items-center gap-2" role="status">
      <LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      Loading more
    </span>
  {:else if capped}
    <span>Narrow your search to find more pull requests.</span>
  {:else}
    <!-- Drawn like the toolbar's Sort and Filters: a card on the page's ring,
         muted until hovered, so the list's end reads as part of the list. -->
    <Button
      type="button"
      variant="ghost"
      size="xs"
      class="h-7 rounded-lg bg-card px-3 text-xs font-medium text-muted-foreground shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] hover:text-foreground pointer-coarse:h-10 pointer-coarse:px-4"
      onclick={onLoad}
    >
      Load more pull requests
    </Button>
  {/if}
</div>
