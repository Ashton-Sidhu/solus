<script lang="ts">
  import { tick } from "svelte";
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import {
    Camera as CameraIcon,
    ChevronLeft as ChevronLeftIcon,
    ChevronRight as ChevronRightIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { relativeTime } from "../../lib/relative-time";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import BrowserSnapshotLightbox from "./BrowserSnapshotLightbox.svelte";
  import { snapshotStamp } from "./lib/snapshot-card";
  import {
    galleryErrorLabel,
    galleryHeading,
    gallerySharedPageId,
    galleryTarget,
    galleryTiles,
  } from "./lib/snapshot-gallery";

  /**
   * What the agent saw, shown inline as the pictures themselves.
   *
   * Tool output never reaches a client, so without this a visual check leaves
   * nothing visual behind. A picture the reader has to open before they can read
   * it is barely better, so there is no card around it and the frame takes the
   * whole column: a desktop page at a third of its size is a thumbnail, not
   * evidence. Several captures are one frame at that size with thumbnails under
   * it, stepped with the arrows or ← →, because frames side by side can only be
   * as wide as the column divided between them. One line under the pictures
   * says what they are and carries the two ways back — annotate the page, or
   * open it in the pane.
   *
   * The images are fetched from the host asset store on demand — the wire
   * carries an id, never pixels — and the frame holds its shape before its image
   * arrives, so a capture landing mid-turn never shoves the transcript.
   */
  interface Props {
    /** The pass, in capture order. One or more. */
    snapshots: BrowserSnapshotRef[];
    /** The host the pages live on. A capture is only reopenable there. */
    serverId: string | undefined;
  }

  let { snapshots, serverId }: Props = $props();
  const session = getWorkspaceContext();

  const tiles = $derived(galleryTiles(snapshots));
  const hasSeveral = $derived(snapshots.length > 1);
  const heading = $derived(galleryHeading(snapshots));
  const target = $derived(galleryTarget(snapshots));
  const errorLabel = $derived(galleryErrorLabel(snapshots));
  const capturedAt = $derived(
    snapshots.reduce((latest, snapshot) => Math.max(latest, snapshot.capturedAt), 0),
  );

  /** The frame the reader picked, or null to follow the newest capture — a
   *  pass grows while the turn runs, and the latest frame is the one the agent
   *  most recently looked at. */
  let picked = $state<number | null>(null);
  const selected = $derived(picked ?? snapshots.length - 1);
  const current = $derived(tiles[Math.min(selected, tiles.length - 1)]);

  /** The frame the reel is open at, or null while the pictures are just inline. */
  let openIndex = $state<number | null>(null);
  let frameEl: HTMLButtonElement | null = $state(null);

  /** Annotate and Open name one page; a multi-page pass has none to name, and
   *  there the frames and the reel carry the per-frame way back. */
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

  function step(delta: number) {
    picked = (selected + delta + tiles.length) % tiles.length;
  }

  /** The reel is a layer over the conversation, so closing it has to leave the
   *  reader exactly where the frame was — including the keyboard, which would
   *  otherwise be dropped back at the top of the document. */
  async function closeReel() {
    openIndex = null;
    // After the reel has actually gone: focusing a node the browser is about to
    // see torn down hands focus straight back to the document body.
    await tick();
    frameEl?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (!hasSeveral) return;
    const delta = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    step(delta);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="browser-snapshots my-2"
  data-testid="browser-snapshots"
  role="group"
  aria-label={heading}
  onkeydown={onKeydown}
>
  {#if current}
    <div class="relative">
      <button
        bind:this={frameEl}
        type="button"
        style:--frame-aspect={current.aspect}
        class="browser-snapshots-frame block cursor-zoom-in overflow-hidden rounded-lg bg-muted shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_img]:h-full [&_img]:w-full [&_img]:object-contain"
        aria-label="Open {current.alt}"
        onclick={() => (openIndex = selected)}
      >
        <!-- Keyed by position: the asset id is a content hash, so two frames of
             a page that did not change are the same asset. -->
        {#key selected}
          <MarkdownImage href={`asset://${current.snapshot.assetId}`} text={current.alt} />
        {/key}
      </button>
      {#if hasSeveral}
        <button
          type="button"
          class="absolute top-1/2 left-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-(--solus-tx-card-bg) text-(--solus-text-secondary) shadow-[shadow:var(--solus-tx-quiet-ring)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-9"
          aria-label="Previous snapshot"
          onclick={() => step(-1)}
        >
          <ChevronLeftIcon class="size-4" />
        </button>
        <button
          type="button"
          class="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-(--solus-tx-card-bg) text-(--solus-text-secondary) shadow-[shadow:var(--solus-tx-quiet-ring)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-9"
          aria-label="Next snapshot"
          onclick={() => step(1)}
        >
          <ChevronRightIcon class="size-4" />
        </button>
      {/if}
    </div>

    {#if hasSeveral}
      <div class="mt-2 flex min-w-0 items-center gap-1.5">
        <div class="flex min-w-0 items-center gap-1.5 overflow-x-auto p-0.5">
          {#each tiles as tile, index (index)}
            <button
              type="button"
              style:--frame-aspect={tile.aspect}
              class="browser-snapshots-thumb block h-11 shrink-0 overflow-hidden rounded-md transition-opacity duration-150 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring [&_img]:h-full [&_img]:w-full [&_img]:object-cover [&_img]:object-top {index ===
              selected
                ? 'opacity-100 shadow-[shadow:0_0_0_2px_var(--primary)]'
                : 'opacity-60 shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]'}"
              aria-label="Show {tile.alt}"
              aria-current={index === selected}
              onclick={() => (picked = index)}
            >
              <MarkdownImage href={`asset://${tile.snapshot.assetId}`} text={tile.alt} />
            </button>
          {/each}
        </div>
        <span
          class="ml-1 min-w-0 truncate text-transcript-meta text-(--muted-foreground) tabular-nums"
          aria-live="polite"
        >
          {selected + 1} / {tiles.length}
          {#if current.label}· <span class="text-(--solus-text-secondary)">{current.label}</span>{/if}
          · {current.detail} · {snapshotStamp(current.snapshot)}
        </span>
      </div>
    {/if}
  {/if}

  <!-- The facts the pictures cannot carry: what they are, where they came from,
       and whether the page was broken under a correct-looking surface. -->
  <div
    class="mt-1.5 flex min-w-0 items-center gap-1.5 text-transcript-meta text-(--muted-foreground) tabular-nums"
  >
    <CameraIcon class="size-3.5 shrink-0" aria-hidden="true" />
    <span class="shrink-0 font-medium text-(--solus-text-secondary)">{heading}</span>
    <span class="min-w-0 truncate">{target}</span>
    {#if errorLabel}
      <span class="shrink-0 text-destructive">{errorLabel}</span>
    {/if}
    <span class="shrink-0">{relativeTime(capturedAt)}</span>
    {#if sharedPageId}
      <span class="ml-auto flex shrink-0 items-center gap-1">
        {#if sharedPageIsOpen}
          <TranscriptCardAction kind="ghost" onclick={() => annotatePage(sharedPageId)}>
            Annotate
          </TranscriptCardAction>
        {/if}
        <TranscriptCardAction kind="ghost" onclick={() => openPage(sharedPageId)}>
          {openingPage ? "Opening…" : "Open"}
        </TranscriptCardAction>
      </span>
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
  /* The frame takes the whole column at its own shape, read against the
     column rather than the window so a narrow pane shrinks it without slicing
     the page. A tall capture stops at 36rem, or one phone frame would be a
     page of transcript on its own. */
  .browser-snapshots {
    container-type: inline-size;
  }

  .browser-snapshots-frame {
    aspect-ratio: var(--frame-aspect);
    height: min(36rem, calc(100cqi / var(--frame-aspect)));
    width: auto;
  }

  .browser-snapshots-thumb {
    aspect-ratio: var(--frame-aspect);
  }

  @media (prefers-reduced-motion: reduce) {
    .browser-snapshots-thumb {
      transition: none;
    }
  }
</style>
