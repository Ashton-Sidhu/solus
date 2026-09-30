<script lang="ts">
  import { tick } from "svelte";
  import { Minus as MinusIcon, Plus as PlusIcon, MoveHorizontal as FitWidthIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { FindBar } from "../ui/find-bar";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import type { PdfView, PdfViewState } from "./lib/pdf-view";

  let { src, title }: { src: string; title: string } = $props();

  let container: HTMLDivElement | undefined = $state();
  let viewerElement: HTMLDivElement | undefined = $state();
  let view: PdfView | null = null;
  let viewState = $state<PdfViewState | null>(null);
  let failed = $state(false);
  let findOpen = $state(false);
  let findQuery = $state("");
  let findBar: FindBar | null = $state(null);

  // One document per URL. pdf.js loads on the first PDF, not with the pane.
  $effect(() => {
    const url = src;
    if (!container || !viewerElement) return;
    let disposed = false;
    failed = false;
    viewState = null;
    void import("./lib/pdf-view")
      .then(({ openPdfView }) =>
        openPdfView(url, container!, viewerElement!, (state) => {
          if (!disposed) viewState = state;
        }),
      )
      .then((opened) => {
        if (disposed) opened.destroy();
        else view = opened;
      })
      .catch(() => {
        if (!disposed) failed = true;
      });
    return () => {
      disposed = true;
      view?.destroy();
      view = null;
    };
  });

  function openFind() {
    if (!viewState) return;
    findOpen = true;
    void tick().then(() => findBar?.focusInput());
  }

  function closeFind() {
    findOpen = false;
    findQuery = "";
    view?.find("");
    container?.focus();
  }

  useKeybinding("files-pane.find-in-pdf", openFind);
</script>

<div class="relative flex min-h-0 flex-1 flex-col" data-testid="pdf-file-preview">
  {#if failed}
    <p role="alert" class="m-auto p-6 text-center text-workspace-chrome text-(--solus-status-error)">
      This PDF could not be displayed. The file may be damaged or protected.
    </p>
  {:else}
    <div class="flex shrink-0 items-center gap-1 border-b border-(--solus-container-border) px-3 py-1 text-xs text-(--solus-text-tertiary)">
      <span class="min-w-0 flex-1 truncate tabular-nums" aria-live="polite">
        {#if viewState}
          Page {viewState.currentPage} of {viewState.pageCount}
        {/if}
      </span>
      <Button variant="ghost" size="icon-xs" aria-label="Zoom out" disabled={!viewState} onclick={() => view?.zoomOut()}>
        <MinusIcon />
      </Button>
      <span class="w-10 text-center tabular-nums">{viewState ? `${viewState.scalePercent}%` : ""}</span>
      <Button variant="ghost" size="icon-xs" aria-label="Zoom in" disabled={!viewState} onclick={() => view?.zoomIn()}>
        <PlusIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Fit to width" disabled={!viewState} onclick={() => view?.fitWidth()}>
        <FitWidthIcon />
      </Button>
    </div>
    <div class="relative min-h-0 flex-1 bg-(--solus-surface-secondary)">
      {#if findOpen}
        <div class="absolute top-2 right-3 z-20">
          <FindBar
            bind:this={findBar}
            query={findQuery}
            current={viewState?.matches?.current ?? 0}
            total={viewState?.matches?.total ?? 0}
            placeholder="Find in PDF"
            ariaLabel="Find in PDF"
            debounceMs={120}
            onQueryChange={(value) => {
              findQuery = value;
              view?.find(value);
            }}
            onNext={() => view?.find(findQuery, { again: true })}
            onPrev={() => view?.find(findQuery, { again: true, backwards: true })}
            onClose={closeFind}
          />
        </div>
      {/if}
      <!-- pdf.js positions pages against this box, so it must be absolute. -->
      <div
        bind:this={container}
        class="absolute inset-0 overflow-auto outline-none"
        tabindex="-1"
        role="document"
        aria-label={title}
        style="-webkit-overflow-scrolling:touch; overscroll-behavior:contain"
      >
        <div bind:this={viewerElement} class="pdfViewer"></div>
      </div>
      {#if !viewState}
        <div class="absolute inset-0 flex bg-(--solus-surface-secondary)">
          <ContentSkeleton label="Loading PDF" />
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* pdf.js creates the pages, so they cannot carry utility classes. Each page
     reads as a sheet of paper on the gutter, in light and dark mode alike. */
  [data-testid="pdf-file-preview"] :global(.pdfViewer .page) {
    margin: 12px auto;
    box-shadow:
      0 0 0 1px var(--solus-container-border),
      0 1px 3px rgb(0 0 0 / 0.08);
  }
</style>
