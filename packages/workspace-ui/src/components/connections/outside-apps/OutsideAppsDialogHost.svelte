<script lang="ts">
  /** Mounts "Use Solus in other apps" once for the client. The dialog loads when
   *  something first opens it: the palette, the host's Access tab, or the host
   *  menu. The copy-by-hand dialog shows over it, and after the host menu's copy. */
  import { outsideAppsDialog } from "./outside-apps-dialog.svelte";
</script>

{#if outsideAppsDialog.serverId}
  {@const serverId = outsideAppsDialog.serverId}
  {#await import("./OutsideAppsDialog.svelte") then { default: OutsideAppsDialog }}
    {#key serverId}
      <OutsideAppsDialog {serverId} />
    {/key}
  {/await}
{/if}

{#if outsideAppsDialog.copyFallback}
  {@const fallback = outsideAppsDialog.copyFallback}
  {#await import("./OutsideAppsCopyFallback.svelte") then { default: OutsideAppsCopyFallback }}
    <OutsideAppsCopyFallback kind={fallback.kind} value={fallback.value} onClose={() => outsideAppsDialog.closeCopyFallback()} />
  {/await}
{/if}
