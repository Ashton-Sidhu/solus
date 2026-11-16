<script lang="ts">
  import { Download, Ellipsis, RotateCcw, ZoomIn, ZoomOut } from "@lucide/svelte";
  import { browserZoomOf, stepBrowserZoom, type BrowserPage } from "@solus/contracts/browser-types";
  import { downloadSizeLabel } from "@solus/client-core/browser-page-requests";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { toasts } from "../../lib/toasts";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as TooltipUI from "../ui/tooltip";

  /**
   * The page's own browser controls that are not used often enough for a
   * button: a reload that skips the cache, zoom, and the files the page
   * downloaded. A zoomed page shows its zoom beside the menu, which resets it,
   * so a page that looks wrong says why.
   */

  interface Props {
    pageKey: string;
    page: BrowserPage;
  }

  let { pageKey, page }: Props = $props();

  const zoom = $derived(browserZoomOf(page));
  const zoomLabel = $derived(`${Math.round(zoom * 100)}%`);
  const downloads = $derived([...(page.downloads ?? [])].reverse());

  function act(label: string, work: () => Promise<void>) {
    void work().catch((error: Error) => toasts.error(label, { description: error.message }));
  }
  const setZoom = (next: number) => act("Couldn't zoom the page", () => browserStore.setZoom(pageKey, next));
</script>

{#if zoom !== 1}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="text-workspace-chrome flex h-6.5 shrink-0 items-center rounded-full px-2 text-(--solus-text-secondary) tabular-nums transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
          aria-label="Zoom {zoomLabel}. Reset to 100%."
          onclick={() => setZoom(1)}
        >
          {zoomLabel}
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content side="bottom" value="Reset zoom to 100%" />
  </TooltipUI.Root>
{/if}

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) aria-expanded:bg-[var(--wash-2)] aria-expanded:text-(--solus-text-primary)"
        aria-label="More page controls"
      >
        <Ellipsis class="size-3.5" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(16rem,calc(100vw-2rem))]">
    <DropdownMenu.Item onSelect={() => act("Couldn't reload the page", () => browserStore.navigate(pageKey, { kind: "reload", ignoreCache: true }))}>
      <RotateCcw class="size-3.5" />
      Hard reload
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Label>Zoom {zoomLabel}</DropdownMenu.Label>
    <DropdownMenu.Item disabled={stepBrowserZoom(zoom, 1) === zoom} closeOnSelect={false} onSelect={() => setZoom(stepBrowserZoom(zoom, 1))}>
      <ZoomIn class="size-3.5" />
      Zoom in
    </DropdownMenu.Item>
    <DropdownMenu.Item disabled={stepBrowserZoom(zoom, -1) === zoom} closeOnSelect={false} onSelect={() => setZoom(stepBrowserZoom(zoom, -1))}>
      <ZoomOut class="size-3.5" />
      Zoom out
    </DropdownMenu.Item>
    <DropdownMenu.Item disabled={zoom === 1} onSelect={() => setZoom(1)}>Actual size</DropdownMenu.Item>
    {#if downloads.length > 0}
      <DropdownMenu.Separator />
      <DropdownMenu.Label>Downloads</DropdownMenu.Label>
      {#each downloads as download (download.downloadId)}
        <DropdownMenu.Item onSelect={() => void browserStore.saveDownload(pageKey, download)}>
          <Download class="size-3.5" />
          <span class="min-w-0 flex-1 truncate">{download.fileName}</span>
          <span class="shrink-0 text-(--solus-text-tertiary) tabular-nums">{downloadSizeLabel(download.sizeBytes)}</span>
        </DropdownMenu.Item>
      {/each}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
