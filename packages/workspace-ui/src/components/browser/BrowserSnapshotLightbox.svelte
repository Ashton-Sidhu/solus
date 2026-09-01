<script lang="ts">
  import { untrack } from "svelte";
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import {
    Camera as CameraIcon,
    Check as CheckIcon,
    ChevronLeft as ChevronLeftIcon,
    ChevronRight as ChevronRightIcon,
    Copy as CopyIcon,
    PanelRight as PanelRightIcon,
    PenLine as PenLineIcon,
    TriangleAlert as TriangleAlertIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { portal } from "../portal";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import * as Carousel from "../ui/carousel";
  import type { CarouselAPI } from "../ui/carousel/context";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import {
    snapshotAddress,
    snapshotErrorLabel,
    snapshotStamp,
    snapshotTitle,
    snapshotWidth,
  } from "./lib/snapshot-card";
  import { galleryAspect, isFrameNear, isStripFrameNear } from "./lib/snapshot-gallery";

  /**
   * The pass as a reel, open at one frame.
   *
   * A tile click opens the pass, not the tile. The plate trades size for the
   * shape of the pass — several recognisable thumbnails instead of one readable
   * page — and this is where that trade is paid back: the clicked frame at full
   * size, with the whole plate laid out beneath it as a filmstrip, so stepping
   * through a comparison never means closing this and going back to the card.
   *
   * Paying the trade back is not the same as filling the display. A capture has
   * a true size, and a phone page stretched across a 27-inch monitor is the same
   * pixels, bigger and blurrier, with the app it belongs to hidden behind it. So
   * this is a card the size of the capture, on the workspace it came from, not a
   * takeover of the screen.
   *
   * Stepping is a carousel rather than a swapped `src` because a capture pass is
   * most often read on a phone, where the gesture for "the next one" is a swipe
   * and there was previously nothing to swipe. The arrow keys, the header
   * buttons and the filmstrip drive the same reel, so all four agree about which
   * frame is up.
   */
  interface Props {
    snapshots: BrowserSnapshotRef[];
    /** The frame the reader clicked. The reel owns which frame is up after that,
     *  so this is read once, at open, and never fed back in. */
    startIndex: number;
    onClose: () => void;
    onOpenPage: (browserPageId: string) => void;
    onAnnotatePage: (browserPageId: string) => void;
    serverId: string | undefined;
  }

  let {
    snapshots,
    startIndex,
    onClose,
    onOpenPage,
    onAnnotatePage,
    serverId,
  }: Props = $props();

  let api = $state<CarouselAPI | undefined>(undefined);
  let selected = $state(untrack(() => startIndex));
  /** The reader's ask, not the state: a frame already at or below its own size
   *  has nothing to zoom to, and `viewing` is what actually applies. */
  let wantsZoom = $state(false);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let reelEl: HTMLElement | null = $state(null);
  let stripEl: HTMLDivElement | null = $state(null);
  /** Read from the card, never the window: a companion pane can put this at a
   *  third of the display it was measured on, and whether zoom has anything to
   *  offer is a question about the frame's width here. */
  let frameWidth = $state(0);

  // Captured once, deliberately: the carousel re-initialises when its options
  // change identity, which would yank the reel back to the opening frame every
  // time the reader steps. `watchDrag` is a stable function reading live state,
  // so a zoomed frame pans under the pointer instead of stepping the reel.
  const carouselOptions = {
    loop: true,
    startIndex: untrack(() => startIndex),
    watchDrag: () => !zoomed,
  };

  const snapshot = $derived(snapshots[selected]);
  const title = $derived(snapshotTitle(snapshot));
  const address = $derived(snapshotAddress(snapshot));
  const errorLabel = $derived(snapshotErrorLabel(snapshot));
  /** The card is cut to the pass's shape, so a phone reel is a phone-shaped card
   *  and a desktop reel is a wide one. Taken from the pass rather than the frame
   *  so the card does not resize under the reader mid-step. */
  const aspect = $derived(galleryAspect(snapshots));

  const nativeWidth = $derived(snapshotWidth(snapshot));
  /** Only offered where it magnifies. Zooming a frame the card is already wide
   *  enough for would shrink the picture and call it actual size. */
  const canZoom = $derived(nativeWidth > frameWidth + 1);
  const zoomed = $derived(wantsZoom && canZoom);

  const pageKey = $derived(
    serverId ? browserStore.keyOf(serverId, snapshot.browserPageId) : null,
  );
  const pageIsOpen = $derived(pageKey ? browserStore.pages.has(pageKey) : false);

  function onApi(carousel: CarouselAPI | undefined) {
    api = carousel;
    if (!carousel) return;
    carousel.on("select", () => {
      selected = carousel.selectedScrollSnap();
      // A frame stepped into is a frame nobody has asked to magnify yet, and
      // landing zoomed means landing on a corner of a page.
      wantsZoom = false;
      revealInStrip(selected);
    });
  }

  function pickFrame(index: number) {
    api?.scrollTo(index);
  }

  /** The strip carries every frame of the pass, so on a long pass the frame the
   *  reel just landed on can be off the end of it. */
  function revealInStrip(index: number) {
    stripEl
      ?.querySelectorAll<HTMLButtonElement>("[data-strip-frame]")
      .item(index)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /**
   * The frame as a picture, on the clipboard.
   *
   * The rendered `<img>` is the source rather than a second resolution of the
   * asset: it is already the signed URL this client was allowed to fetch, and
   * minting another one here would be a copy of the loader that would drift.
   */
  async function copyFrame() {
    const image = reelEl?.querySelector<HTMLImageElement>(
      `[data-frame="${selected}"] img`,
    );
    if (!image?.currentSrc) return;
    try {
      const blob = await fetch(image.currentSrc).then((response) => {
        if (!response.ok) throw new Error("Capture not available");
        return response.blob();
      });
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch {}
  }

  // The reel only exists while a frame is open, so the scope is the mount. It is
  // exclusive: while a capture is up the arrows step the reel rather than also
  // moving the transcript underneath it.
  useScope("snapshot-lightbox", { exclusive: true });
  useKeybinding("snapshot-lightbox.close", () => onClose());
  useKeybinding("snapshot-lightbox.previous", () => api?.scrollPrev());
  useKeybinding("snapshot-lightbox.next", () => api?.scrollNext());

  let dialogEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    dialogEl?.focus();
    return () => clearTimeout(copyTimer);
  });
</script>

<!-- The scrim is the backdrop, not the dialog: it only dismisses on a click
     that lands on itself, so it stays presentational and the card below is the
     thing screen readers enter. Escape is bound above for the keyboard. -->
<div
  data-solus-ui
  use:portal={document.body}
  role="presentation"
  class="fixed inset-0 z-[9999] grid place-items-center bg-[color-mix(in_oklch,var(--foreground)_28%,transparent)] p-6 backdrop-blur-[2px] focus-visible:outline-none"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <!-- Cut to the capture, bounded by the window: the width follows the frame's
       own proportion until the display runs out, and the height follows from
       it, so the card never letterboxes and never scales a page past its size. -->
  <div
    bind:this={dialogEl}
    role="dialog"
    aria-modal="true"
    aria-label="{title} — capture {selected + 1} of {snapshots.length}"
    tabindex="-1"
    class="text-transcript-meta browser-snapshot-reel @container flex max-w-full flex-col overflow-hidden rounded-2xl bg-[var(--card)] shadow-[shadow:var(--elev-lift),0_0_0_0.5px_var(--hairline-strong)] focus-visible:outline-none"
    style:--frame-aspect={aspect}
  >
    <div class="flex items-center gap-1.5 px-3 py-2.5">
      <!-- The plate's own mark, so the viewer reads as the card opened rather
           than as a second surface that arrived from somewhere. -->
      <span
        class="flex size-[1.125rem] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] text-[var(--primary)]"
        aria-hidden="true"
      >
        <CameraIcon size={10} strokeWidth={1.9} />
      </span>
      <span class="min-w-0 shrink truncate font-medium text-(--solus-text-primary)">
        {title}
      </span>
      <span
        class="@max-[32rem]:hidden min-w-0 flex-1 truncate font-mono text-(--solus-text-tertiary)"
      >
        {address}
      </span>
      <span class="flex-1"></span>

      {#if errorLabel}
        <span
          class="text-review-meta @max-[28rem]:hidden flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklch,var(--destructive)_8%,transparent)] px-1.5 py-0.5 text-[color:color-mix(in_oklch,var(--destructive)_70%,var(--foreground))]"
        >
          <TriangleAlertIcon size={10} aria-hidden="true" />
          {errorLabel}
        </span>
      {/if}

      <span
        class="@max-[24rem]:hidden shrink-0 font-mono text-(--solus-text-tertiary) tabular-nums opacity-70"
      >
        {selected + 1} / {snapshots.length}
      </span>
      <button
        type="button"
        class="flex size-6 shrink-0 items-center justify-center rounded-md text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
        aria-label="Previous capture"
        onclick={() => api?.scrollPrev()}
      >
        <ChevronLeftIcon size={13} />
      </button>
      <button
        type="button"
        class="flex size-6 shrink-0 items-center justify-center rounded-md text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
        aria-label="Next capture"
        onclick={() => api?.scrollNext()}
      >
        <ChevronRightIcon size={13} />
      </button>

      <span
        class="mx-1 h-4 w-px shrink-0 bg-[var(--hairline-strong)]"
        aria-hidden="true"
      ></span>

      <!-- The two ways out of the picture and the one way back to the page. They
           lose their labels before they lose themselves: a phone-width card
           keeps every action, as glyphs. -->
      <button
        type="button"
        class="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
        aria-label="Copy capture"
        onclick={copyFrame}
      >
        {#if copied}
          <CheckIcon size={12} />
        {:else}
          <CopyIcon size={12} />
        {/if}
        <span class="@max-[38rem]:hidden">{copied ? "Copied" : "Copy"}</span>
      </button>
      {#if pageIsOpen}
        <button
          type="button"
          class="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
          aria-label="Annotate page"
          onclick={() => onAnnotatePage(snapshot.browserPageId)}
        >
          <PenLineIcon size={12} />
          <span class="@max-[38rem]:hidden">Annotate</span>
        </button>
      {/if}
      <button
        type="button"
        class="flex h-6 shrink-0 items-center gap-1 rounded-md bg-[var(--wash-2)] px-1.5 font-medium text-(--solus-text-primary) shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] transition-colors hover:bg-[var(--wash-3)]"
        aria-label="Open in pane"
        onclick={() => onOpenPage(snapshot.browserPageId)}
      >
        <PanelRightIcon size={12} />
        <span class="@max-[38rem]:hidden">Open in pane</span>
      </button>
      <button
        type="button"
        class="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
        aria-label="Close capture"
        onclick={onClose}
      >
        <XIcon size={12} />
      </button>
    </div>

    <Carousel.Root
      bind:ref={reelEl}
      opts={carouselOptions}
      setApi={onApi}
      class="browser-snapshot-reel__frame border-y border-[var(--hairline)] [&>[data-slot=carousel-content]]:h-full"
    >
      <Carousel.Content class="h-full">
        <!-- Position, not asset: the asset id is a content hash, so an unchanged
             page captured twice is the same asset in two frames. -->
        {#each snapshots as frame, index (index)}
          <Carousel.Item class="h-full">
            <!-- Every slide is the card's width, so any of them answers what
                 the frame is wide enough for.

                 The ground is deliberately deeper than the card. The card is cut
                 to the pass's shape and a mixed pass has frames of other shapes,
                 so a short capture in a tall frame leaves real empty ground. At
                 `--wash-1` that ground was the same value as the card and the
                 picture read as the container, which made every frame look like
                 a differently sized card. A matte the reader can see is what
                 makes the leftover space read as leftover space. -->
            <div
              class="relative h-full overflow-hidden bg-[var(--wash-3)]"
              data-frame={index}
              bind:clientWidth={frameWidth}
            >
              <!-- A full-page capture is many screens tall, so the frame scrolls
                   rather than shrinking the page to something nobody can read.
                   The workspace's own bar, revealed on hover because this
                   scroller is small and bounded. Embla claims horizontal drags
                   only, so a vertical drag still scrolls the page. -->
              <div class="scrollbar-on-hover h-full overflow-auto">
                <!-- A second click is the reader asking to read, not to look:
                     the page goes to the width its own browser drew it at and
                     pans under the pointer. `w-max min-w-full` is what keeps a
                     magnified page reachable — a centred flex child wider than
                     its scroller has its left edge cut off, not scrolled to.

                     `min-h-full items-center` places a picture shorter than the
                     frame in the middle of the matte instead of hanging it from
                     the top rail, so the ground reads as margin on both sides
                     rather than as the card having run out. It cannot clip a
                     tall page: once the picture is taller than the frame the
                     button grows with it and centring has no free space to
                     distribute. The hairline is what keeps a pale capture from
                     dissolving into the matte at its own edges. -->
                <button
                  type="button"
                  class="flex min-h-full items-center justify-center [&_img]:shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] {zoomed &&
                  index === selected
                    ? 'w-max min-w-full cursor-zoom-out [&_img]:w-(--frame-native-width) [&_img]:max-w-none'
                    : `w-full [&_img]:w-full ${canZoom ? 'cursor-zoom-in' : 'cursor-default'}`}"
                  style:--frame-native-width="{snapshotWidth(frame)}px"
                  aria-label={zoomed ? "Fit capture to the card" : "Zoom capture to actual size"}
                  aria-pressed={zoomed}
                  disabled={!canZoom}
                  onclick={() => (wantsZoom = !wantsZoom)}
                >
                  {#if isFrameNear(index, selected, snapshots.length)}
                    <MarkdownImage
                      href={`asset://${frame.assetId}`}
                      text={snapshotTitle(frame)}
                    />
                  {/if}
                </button>
              </div>
              <!-- The stamp rides the frame, not the picture: it has to stay
                   readable at any scroll position of a page many screens long. -->
              <span
                class="text-review-meta pointer-events-none absolute bottom-2 left-2 rounded-full bg-[color-mix(in_oklch,var(--foreground)_72%,transparent)] px-1.5 py-0.5 text-[color:var(--background)] tabular-nums"
              >
                {snapshotStamp(frame)}
              </span>
            </div>
          </Carousel.Item>
        {/each}
      </Carousel.Content>
    </Carousel.Root>

    <!-- The whole pass, under the frame. The plate the reader clicked is behind
         this card and they cannot reach it, so the strip is what keeps the pass
         a set rather than a frame with two arrows on it. -->
    <div
      bind:this={stripEl}
      class="scrollbar-on-hover flex items-center gap-2 overflow-x-auto py-2 pr-2 pl-3"
      role="group"
      aria-label="Captures in this pass"
    >
      {#each snapshots as frame, index (index)}
        <button
          type="button"
          data-strip-frame
          aria-current={index === selected}
          aria-label="Capture {index + 1}, {snapshotTitle(frame)}"
          class="browser-snapshot-strip__frame relative shrink-0 overflow-hidden rounded-md bg-[var(--wash-1)] transition-opacity duration-150 hover:opacity-100 focus-visible:outline-none {index ===
          selected
            ? 'opacity-100 shadow-[shadow:0_0_0_2px_var(--primary)]'
            : 'opacity-60 shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]'}"
          onclick={() => pickFrame(index)}
        >
          <div class="h-full w-full [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top">
            {#if isStripFrameNear(index, selected, snapshots.length)}
              <MarkdownImage
                href={`asset://${frame.assetId}`}
                text={snapshotTitle(frame)}
              />
            {/if}
          </div>
        </button>
      {/each}
      <span class="flex-1"></span>
      <span
        class="@max-[26rem]:hidden shrink-0 font-mono text-(--solus-text-tertiary) opacity-70"
      >
        ← → step · Esc close
      </span>
    </div>
  </div>
</div>

<style>
  /* The card arrives where the tile was, quickly and once. A capture opened
     from a plate the reader is still looking at should read as that tile coming
     forward, not as a window appearing over the conversation. */
  /* The card declares its own width rather than taking it from the frame inside
     it. `@container` on this element is `container-type: inline-size`, which is
     inline-size containment: the card's width has to be resolvable without
     looking at its contents, and a content-sized container resolves to zero. So
     the width lives here and the frame fills it. */
  .browser-snapshot-reel {
    --frame-width: min(
      88vw,
      64rem,
      calc((88vh - 9.5rem) * var(--frame-aspect))
    );
    width: var(--frame-width);
    animation: snapshot-reel-in 180ms cubic-bezier(0.2, 0, 0, 1);
  }

  @keyframes snapshot-reel-in {
    from {
      opacity: 0;
      transform: translateY(0.375rem) scale(0.985);
    }
  }

  .browser-snapshot-reel__frame {
    width: 100%;
    height: calc(var(--frame-width) / var(--frame-aspect));
  }

  /* Equal cells, cut to the pass's shape, with a floor so a phone pass is a
     strip of frames rather than a row of slivers. */
  .browser-snapshot-strip__frame {
    height: 3.25rem;
    width: max(2.75rem, calc(3.25rem * var(--frame-aspect)));
  }

  @media (prefers-reduced-motion: reduce) {
    .browser-snapshot-reel {
      animation: none;
    }

    .browser-snapshot-strip__frame {
      transition: none;
    }
  }
</style>
