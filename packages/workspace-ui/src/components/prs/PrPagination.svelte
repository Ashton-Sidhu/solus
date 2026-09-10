<script lang="ts">
  import { LoaderCircle } from "@lucide/svelte";
  import { Button } from "../ui/button";

  let { loading, onLoad }: { loading: boolean; onLoad: () => void } = $props();
</script>

<!-- Kept outside the virtual list; 56px is reserved from its viewport. -->
<div class="flex h-14 shrink-0 items-center justify-center border-t border-border bg-background">
  <Button
    type="button"
    class="inline-flex h-8 w-56 cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10"
    disabled={loading}
    aria-busy={loading}
    onclick={onLoad}
  >
    <span class="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
      {#if loading}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />{/if}
    </span>
    <span>{loading ? "Loading pull requests…" : "Load more pull requests"}</span>
  </Button>
</div>
