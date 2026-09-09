<script lang="ts">
  import { Skeleton } from "./skeleton";

  let { label = "Loading content", preview = false }: {
    label?: string;
    preview?: boolean;
  } = $props();
</script>

<div class="flex w-full flex-col gap-3 p-3" role="status" aria-busy="true" aria-label={label}>
  {#if preview}
    <Skeleton class="h-32 w-full rounded-lg" />
  {:else}
    <Skeleton class="h-3 w-3/4" />
    <Skeleton class="h-3 w-full" />
    <Skeleton class="h-3 w-1/2" />
  {/if}
</div>
