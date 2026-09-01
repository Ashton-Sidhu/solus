<script lang="ts">
  import { Folder as FolderIcon, Library as LibraryIcon } from "@lucide/svelte";
  import type { DocDestination } from "@solus/contracts/docs";

  /**
   * The mark before a publish destination.
   *
   * Only the root of a Drive earns the brand logo — it *is* the account, and
   * naming it "My Drive" in a menu that also lists Confluence spaces is not
   * enough on its own. Everything below it is a container, drawn in the neutral
   * chrome colour so a hundred folders read as one list rather than a hundred
   * badges.
   *
   * The logo is inlined rather than pulled from Iconify: the menu opens on a
   * machine that may have no network, and a mark that sometimes fails to arrive
   * is worse than one that never moves.
   */
  interface Props {
    destination: DocDestination;
  }
  let { destination }: Props = $props();

  const isDriveRoot = $derived(destination.provider === "gdrive" && destination.scope === "root");
</script>

{#if isDriveRoot}
  <svg width="14" height="14" viewBox="0 0 87.3 78" aria-hidden="true" class="shrink-0">
    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
    <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47" />
    <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
    <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
    <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
    <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
  </svg>
{:else if destination.provider === "confluence"}
  <!-- A Confluence space is a library of pages, not a folder; the glyph says so
       rather than borrowing Drive's vocabulary. -->
  <LibraryIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
{:else}
  <FolderIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
{/if}
