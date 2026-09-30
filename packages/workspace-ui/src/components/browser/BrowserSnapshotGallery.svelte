<script lang="ts">
  import { tick } from "svelte";
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import { Camera as CameraIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { relativeTime } from "../../lib/relative-time";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import BrowserSnapshotLightbox from "./BrowserSnapshotLightbox.svelte";
  import {
    galleryAspect,
    galleryErrorLabel,
    galleryHeading,
    galleryLayout,
    gallerySharedPageId,
    galleryTarget,
    galleryTiles,
  } from "./lib/snapshot-gallery";

  /**
   * One capture pass, shown as one plate.
   *
   * Two or more frames from the same pass stop being two or more cards: they
   * become one card with a single line (docs/transcript-cards.md), so a pass
   * reads as one act of looking regardless of how many frames it took.
   *
   * A frame is never blown up past its own size to fill a cell. Landscape
   * captures sit in equal cells cropped to the top of the page, where the crop
   * costs the bottom of the page rather than the sense of it; portrait captures
   * keep their true proportion on the plate ground, because a phone page forced
   * into a landscape cell is a doubled, blurry close-up of a nav bar.
   */
  interface Props {
    /** The pass, in capture order. Two or more — one frame keeps the card. */
    snapshots: BrowserSnapshotRef[];
    /** The host the pages live on. A capture is only reopenable there. */
    serverId: string | undefined;
    skipMotion?: boolean;
  }

  let { snapshots, serverId, skipMotion = false }: Props = $props();
  const session = getWorkspaceContext();

  const plateAspect = $derived(galleryAspect(snapshots));
  const layout = $derived(galleryLayout(snapshots.length, plateAspect));
  const tiles = $derived(galleryTiles(snapshots));
  const heading = $derived(galleryHeading(snapshots));
  const target = $derived(galleryTarget(snapshots));
  const errorLabel = $derived(galleryErrorLabel(snapshots));
  const capturedAt = $derived(
    snapshots.reduce((latest, snapshot) => Math.max(latest, snapshot.capturedAt), 0),
  );

  /** The frame the reel is open at, or null while the plate is just a plate. */
  let openIndex = $state<number | null>(null);

  /** The plate is one tab stop with arrow-key roving inside it, so a six-frame
   *  pass costs the keyboard one stop rather than six. */
  let rovingIndex = $state(0);
  let plateEl: HTMLDivElement | null = $state(null);

  /** Annotate and Open name one page; a multi-page pass has none to name, and
   *  there the tiles and the reel carry the per-frame way back. */
  const sharedPageId = $derived(gallerySharedPageId(snapshots));
  const sharedPageKey = $derived(
    serverId && sharedPageId ? browserStore.keyOf(serverId, sharedPageId) : null,
  );
  const sharedPageIsOpen = $derived(
    sharedPageKey ? browserStore.pages.has(sharedPageKey) : false,
  );

  let openingPage = $state(false);

  async function openPage(browserPageId: string) {
    if (openingPage) return;
    const snapshot = snapshots.find((frame) => frame.browserPageId === browserPageId);
    if (!snapshot) return;
    openingPage = true;
    try {
      const host = serverId ?? session.fallbackServerId;
      const openedPageId = await browserStore.openSnapshot(host, snapshot);
      openIndex = null;
      session.openRoute(
        { name: "browser", params: { browserPageId: openedPageId, serverId: host } },
        { via: "click" },
      );
    } catch (error) {
      toasts.error("Could not open the captured page", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      openingPage = false;
    }
  }

  /** The same way back with the note tools already armed, so feedback lands on
   *  the element rather than on the image. */
  function annotatePage(browserPageId: string) {
    if (serverId) {
      const key = browserStore.keyOf(serverId, browserPageId);
      void browserStore.setAnnotationTool(key, "pick").catch(() => {});
    }
    openPage(browserPageId);
  }

  function tileAt(index: number): HTMLButtonElement | null {
    return (
      plateEl?.querySelectorAll<HTMLButtonElement>("[data-snapshot-tile]").item(index) ??
      null
    );
  }

  function moveRoving(delta: number) {
    const next = rovingIndex + delta;
    if (next < 0 || next >= tiles.length) return;
    rovingIndex = next;
    tileAt(next)?.focus();
  }

  /** The reel is a layer over the conversation, so closing it has to leave the
   *  reader exactly where the plate was — including the keyboard, which would
   *  otherwise be dropped back at the top of the document. */
  async function closeReel() {
    const opened = openIndex;
    openIndex = null;
    // After the reel has actually gone: focusing a node the browser is about to
    // see torn down hands focus straight back to the document body.
    await tick();
    if (opened !== null) tileAt(opened)?.focus();
  }

  function onTileKeydown(event: KeyboardEvent) {
    const columns = layout.mode === "rail" ? tiles.length : layout.columns;
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
    }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    moveRoving(step);
  }
</script>

<TranscriptCard
  title={heading}
  {target}
  actionLabel={sharedPageId ? (openingPage ? "Opening…" : "Open") : undefined}
  ariaLabel={`Open captured page: ${heading}`}
  onOpen={sharedPageId ? () => openPage(sharedPageId) : undefined}
  bodyLayout="media"
  data-testid="browser-snapshot-gallery"
  {skipMotion}
>
  {#snippet glyph()}<CameraIcon />{/snippet}
  {#snippet rail()}
    <!-- The pass's total, not a count per tile: at this size a per-frame count
         is unreadable. The reel attributes it to a frame. -->
    {#if errorLabel}
      <span class="text-destructive">{errorLabel}</span>
    {/if}
    <span>{relativeTime(capturedAt)}</span>
  {/snippet}
  {#snippet actions()}
    {#if sharedPageId && sharedPageIsOpen}
      <TranscriptCardAction kind="ghost" onclick={() => annotatePage(sharedPageId)}>
        Annotate
      </TranscriptCardAction>
    {/if}
  {/snippet}
  {#snippet body()}
    <!-- No ground of its own: each frame sits on the card surface. On the grid a
         1px divider shows through the gap between cells; on the rail the frames
         are spaced and ringed instead. -->
    <div
      bind:this={plateEl}
      class="browser-snapshot-plate focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-[color:var(--ring)] {layout.mode ===
      'rail'
        ? 'flex items-center justify-center gap-2 p-3'
        : 'grid gap-px bg-(--solus-tx-divider)'}"
      data-mode={layout.mode}
      data-columns={layout.columns}
      style:--plate-columns={layout.columns}
      style:--plate-tile-height={layout.tileHeight}
      role="group"
      aria-label={heading}
    >
      <!-- Keyed by position, not by asset: the asset id is a content hash, so two
           frames of a page that did not change are the same asset. The pass is a
           fixed list in capture order that never reorders, so position is the
           frame's identity here. -->
      {#each tiles as tile, index (index)}
        <button
          type="button"
          data-snapshot-tile
          tabindex={index === rovingIndex ? 0 : -1}
          style:--tile-aspect={plateAspect}
          class="browser-snapshot-tile relative block overflow-hidden bg-(--solus-tx-card-bg) text-left transition-[filter] duration-[90ms] hover:brightness-[1.03] focus-visible:outline-none {layout.mode ===
          'rail'
            ? 'rounded-lg shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]'
            : ''}"
          aria-label="Open {tile.alt}"
          onclick={() => (openIndex = index)}
          onfocus={() => (rovingIndex = index)}
          onkeydown={onTileKeydown}
        >
          <div
            class="flex h-full w-full items-start justify-center {layout.mode === 'rail'
              ? '[&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top'
              : tile.portrait
                ? '[&_img]:h-full [&_img]:w-auto'
                : '[&_img]:w-full'}"
          >
            <MarkdownImage
              href={`asset://${tile.snapshot.assetId}`}
              text={tile.alt}
            />
          </div>

          <!-- One quiet pill, not a scrim: the tile only says which frame this
               is, on the card's own surface, so the picture is never darkened
               to make room for its caption. -->
          <span
            class="text-review-meta pointer-events-none absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-full bg-(--solus-tx-card-bg) px-2 py-0.5 text-(--muted-foreground) tabular-nums shadow-[shadow:var(--solus-tx-quiet-ring)]"
          >
            {#if tile.label && layout.mode === "grid"}
              <span class="min-w-0 truncate text-(--solus-text-secondary)">{tile.label}</span>
            {/if}
            <span class="min-w-0 shrink truncate">{tile.detail}</span>
          </span>

          {#if tile.overflow > 0}
            <!-- The cell it would have shown anyway, dimmed and counted, so
                 the header's total and the cells always add up. -->
            <span
              class="text-transcript-card absolute inset-0 flex items-center justify-center bg-[color-mix(in_oklch,var(--foreground)_62%,transparent)] font-semibold text-[color:var(--background)]"
            >
              +{tile.overflow}
            </span>
          {/if}
        </button>
      {/each}
    </div>
  {/snippet}
</TranscriptCard>

{#if openIndex !== null}
  <BrowserSnapshotLightbox
    {snapshots}
    startIndex={openIndex}
    onClose={closeReel}
    onOpenPage={openPage}
    onAnnotatePage={annotatePage}
    {serverId}
  />
{/if}

<style>
  /* Height and column count are the plate's own numbers rather than Tailwind
     rungs: the cells are equal by construction, and the height steps down with
     the row count so the plate stays a card in a conversation. */
  .browser-snapshot-plate[data-mode="grid"] {
    grid-template-columns: repeat(var(--plate-columns), minmax(0, 1fr));
  }

  .browser-snapshot-tile {
    height: var(--plate-tile-height);
  }

  /* The plate sets its own height from its row count (galleryLayout). The
     shell's 150px media cap would crop the second row, so the plate lifts it. */
  :global(.tx-card__body.is-media:has(> .browser-snapshot-plate)) {
    max-height: none;
  }

  /* On the rail the frame's own proportion sets its width, so a phone capture
     is a phone-shaped frame rather than a page stretched to fill a cell.

     The height is the smaller of the plate's own number and what this plate is
     actually wide enough for — read from the plate, not the window, because a
     companion pane can put this card at a third of the display it was measured
     on. Without that the frames would shrink in width alone and `object-cover`
     would quietly slice the sides off every page. `1.5rem` is the rail's
     padding; `0.5rem` is one gap, and there is one fewer gap than frames. */
  .browser-snapshot-plate[data-mode="rail"] {
    container-type: inline-size;
  }

  .browser-snapshot-plate[data-mode="rail"] .browser-snapshot-tile {
    --plate-gutter: calc(1.5rem + 0.5rem * (var(--plate-columns) - 1));
    aspect-ratio: var(--tile-aspect);
    height: min(
      var(--plate-tile-height),
      calc(
        (100cqi - var(--plate-gutter)) / var(--plate-columns) / var(--tile-aspect)
      )
    );
    width: auto;
    flex: 0 0 auto;
  }

  /* Width is declared by the pane, never the window: a companion pane can put
     this card at a third of the display it looked fine on. */
  @container pane (max-width: 30rem) {
    .browser-snapshot-plate[data-mode="grid"][data-columns="3"] {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .browser-snapshot-tile {
      transition: none;
    }
  }
</style>
