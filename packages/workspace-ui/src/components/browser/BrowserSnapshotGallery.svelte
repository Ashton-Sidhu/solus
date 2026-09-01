<script lang="ts">
  import { tick } from "svelte";
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import {
    Camera as CameraIcon,
    TriangleAlert as TriangleAlertIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import BrowserSnapshotLightbox from "./BrowserSnapshotLightbox.svelte";
  import {
    galleryAddress,
    galleryAspect,
    galleryErrorLabel,
    galleryHeading,
    galleryLayout,
    gallerySharedPageId,
    gallerySubject,
    galleryTiles,
  } from "./lib/snapshot-gallery";

  /**
   * One capture pass, shown as one plate.
   *
   * Two or more frames from the same pass stop being two or more cards: they
   * become one sheet with a single header and a single footer, so a pass reads
   * as one act of looking regardless of how many frames it took.
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
  const subject = $derived(gallerySubject(snapshots));
  const address = $derived(galleryAddress(snapshots));
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

  /** Annotate and Open in pane name one page; a multi-page pass has none to
   *  name, and there the tiles and the reel carry the per-frame way back. The
   *  footer is absent rather than empty when it has nothing to offer. */
  const sharedPageId = $derived(gallerySharedPageId(snapshots));
  const sharedPageKey = $derived(
    serverId && sharedPageId ? browserStore.keyOf(serverId, sharedPageId) : null,
  );
  const sharedPageIsOpen = $derived(
    sharedPageKey ? browserStore.pages.has(sharedPageKey) : false,
  );

  function openPage(browserPageId: string) {
    session.openRoute(
      {
        name: "browser",
        params: serverId ? { browserPageId, serverId } : { browserPageId },
      },
      { via: "click" },
    );
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

  function onPlateKeydown(event: KeyboardEvent) {
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

<div class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <div
    class="text-transcript-meta group mx-auto w-[88%] overflow-hidden rounded-xl bg-[var(--card)] shadow-[shadow:0_0_0_0.5px_var(--hairline-strong),0_0.0625rem_0.125rem_-0.0625rem_rgba(0,0,0,0.05)]"
    data-testid="browser-snapshot-gallery"
  >
    <div class="flex items-center gap-2 px-3 py-2.5">
      <span
        class="flex size-[1.125rem] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] text-[var(--primary)]"
        aria-hidden="true"
      >
        <CameraIcon size={10} strokeWidth={1.9} />
      </span>
      <span class="shrink-0 font-medium text-(--solus-text-primary)">
        {heading}
      </span>
      <span class="min-w-0 flex-1 truncate text-(--solus-text-tertiary)">
        {subject}
      </span>

      {#if errorLabel}
        <!-- The pass's total, not a badge per tile: at this size a per-frame
             count is unreadable, and a badge that is always there teaches
             people to stop reading it. The reel attributes it to a frame. -->
        <span
          class="text-review-meta flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklch,var(--destructive)_8%,transparent)] px-1.5 py-0.5 text-[color:color-mix(in_oklch,var(--destructive)_70%,var(--foreground))]"
        >
          <TriangleAlertIcon size={10} aria-hidden="true" />
          {errorLabel}
        </span>
      {/if}

      {#if !sharedPageId}
        <!-- With no single page to act on there is no footer, so the extent of
             the pass is stated here rather than on a bar of its own. -->
        <span class="shrink-0 text-(--solus-text-tertiary)">{address}</span>
      {/if}

      <span class="shrink-0 text-(--solus-text-tertiary) opacity-70">
        {relativeTime(capturedAt)}
      </span>
    </div>

    <!-- Grid: the seam is the plate's own ground showing through a 1px gap, so
         the grid is drawn once. Rail: the frames are separate objects on a light
         table, so they are spaced and softened rather than butted together. -->
    <div
      bind:this={plateEl}
      class="browser-snapshot-plate border-t border-[var(--hairline)] focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-[color:var(--ring)] {layout.mode ===
      'rail'
        ? 'flex items-center justify-center gap-2 bg-[var(--wash-1)] p-3'
        : 'grid gap-px bg-[var(--hairline-strong)]'}"
      data-mode={layout.mode}
      data-columns={layout.columns}
      style:--plate-columns={layout.columns}
      style:--plate-tile-height={layout.tileHeight}
      role="group"
      aria-label={heading}
      onkeydown={onPlateKeydown}
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
          class="browser-snapshot-tile relative block overflow-hidden bg-[var(--wash-1)] text-left transition-[filter] duration-[90ms] hover:brightness-[1.03] focus-visible:outline-none {layout.mode ===
          'rail'
            ? 'rounded-lg shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]'
            : ''}"
          aria-label="Open {tile.alt}"
          onclick={() => (openIndex = index)}
          onfocus={() => (rovingIndex = index)}
        >
          <div
            class="flex h-full w-full items-start justify-center [&_img]:w-full {layout.mode ===
            'rail'
              ? '[&_img]:h-full [&_img]:object-cover [&_img]:object-top'
              : ''}"
          >
            <MarkdownImage
              href={`asset://${tile.snapshot.assetId}`}
              text={tile.alt}
            />
          </div>

          <!-- One quiet line. The header already carries the viewport and the
               colour scheme for the whole plate, so the tile only has to say
               which frame this is — and a caption that shouts drowns the
               picture it is a caption for. -->
          <span
            class="text-review-meta pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-[linear-gradient(180deg,transparent,color-mix(in_oklch,var(--foreground)_58%,transparent))] px-2 py-1 text-[color:var(--background)]"
          >
            {#if tile.label && layout.mode === "grid"}
              <span class="min-w-0 truncate">{tile.label}</span>
              <span class="flex-1"></span>
            {/if}
            <span class="min-w-0 shrink truncate font-mono opacity-80">
              {tile.detail}
            </span>
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

    {#if sharedPageId}
      <div
        class="flex items-center gap-1.5 border-t border-[var(--hairline)] py-2 pr-2 pl-3"
      >
        <span class="min-w-0 flex-1 truncate text-(--solus-text-tertiary)">
          {address}
        </span>
        {#if sharedPageIsOpen}
          <button
            type="button"
            class="shrink-0 rounded-md px-2 py-1 font-medium text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
            onclick={() => annotatePage(sharedPageId)}
          >
            Annotate
          </button>
        {/if}
        <button
          type="button"
          class="shrink-0 rounded-md bg-[var(--wash-2)] px-2.5 py-1 font-medium text-(--solus-text-primary) shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] transition-colors hover:bg-[var(--wash-3)]"
          onclick={() => openPage(sharedPageId)}
        >
          Open in pane
        </button>
      </div>
    {/if}
  </div>
</div>

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
