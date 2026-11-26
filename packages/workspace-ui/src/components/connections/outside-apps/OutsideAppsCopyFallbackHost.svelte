<script lang="ts">
  /** Mounts the copy-by-hand dialog of "Use Solus from your other apps" once
   *  for the client: it shows when the clipboard did not take a value, on
   *  Settings › Sharing & access or after the host menu's copy. */
  import { outsideApps } from "./outside-apps.svelte";
</script>

{#if outsideApps.copyFallback}
  {@const fallback = outsideApps.copyFallback}
  {#await import("./OutsideAppsCopyFallback.svelte") then { default: OutsideAppsCopyFallback }}
    <OutsideAppsCopyFallback kind={fallback.kind} value={fallback.value} onClose={() => outsideApps.closeCopyFallback()} />
  {/await}
{/if}
