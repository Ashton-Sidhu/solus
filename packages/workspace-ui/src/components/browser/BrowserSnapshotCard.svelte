<script lang="ts">
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import {
    Camera as CameraIcon,
    Maximize2 as MaximizeIcon,
    Minimize2 as MinimizeIcon,
    TriangleAlert as TriangleAlertIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import {
    snapshotAddress,
    snapshotCaption,
    snapshotErrorLabel,
    snapshotFacts,
    snapshotStamp,
    snapshotTitle,
  } from "./lib/snapshot-card";

  /**
   * What the agent saw, shown to the person who asked.
   *
   * Tool output never reaches a client, so without this card a visual check
   * leaves nothing visual behind: the user gets a line saying the agent looked
   * at the page and has to take its word for it.
   *
   * Header, frame, footer. The header says who captured it and why; the frame is
   * the evidence, stamped with the viewport and the colour scheme it was taken
   * under; the footer carries the address and the two ways back — annotate the
   * page, or open it in the pane. A frame without that provenance is decoration.
   *
   * The image is fetched from the host asset store on demand — the wire carries
   * an id, never pixels — so a long transcript of captures costs a few hundred
   * bytes each until they are actually on screen.
   */
  interface Props {
    snapshot: BrowserSnapshotRef;
    /** The host the page lives on. A capture is only reopenable there. */
    serverId: string | undefined;
    skipMotion?: boolean;
  }

  let { snapshot, serverId, skipMotion = false }: Props = $props();
  const session = getWorkspaceContext();

  const facts = $derived(snapshotFacts(snapshot));
  const caption = $derived(snapshotCaption(snapshot));
  const address = $derived(snapshotAddress(snapshot));
  const stamp = $derived(snapshotStamp(snapshot));
  const errorLabel = $derived(snapshotErrorLabel(snapshot));
  const title = $derived(snapshotTitle(snapshot));

  /** The frame is a capped strip of the capture, top-anchored, until the reader
   *  asks for the whole thing. Ephemeral and this card's alone. */
  let expanded = $state(false);

  /** Whether the page this came from is still open. A capture outlives its page,
   *  and the two ways back only exist while there is something to go back to. */
  const pageKey = $derived(
    serverId ? browserStore.keyOf(serverId, snapshot.browserPageId) : null,
  );
  const pageIsOpen = $derived(pageKey ? browserStore.pages.has(pageKey) : false);

  function openPage() {
    session.openRoute(
      {
        name: "browser",
        params: serverId
          ? { browserPageId: snapshot.browserPageId, serverId }
          : { browserPageId: snapshot.browserPageId },
      },
      { via: "click" },
    );
  }

  /** The same way back, with the note tools already armed — so feedback lands on
   *  the element and not on the image. The pane opens its annotation bar for a
   *  page that already has a tool armed, so arming it is the whole handshake. */
  function annotatePage() {
    if (pageKey) void browserStore.setAnnotationTool(pageKey, "pick").catch(() => {});
    openPage();
  }
</script>

<div class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <div
    class="text-transcript-meta browser-snapshot-card group mx-auto w-[88%] overflow-hidden rounded-xl bg-[var(--card)] shadow-[shadow:0_0_0_0.5px_var(--hairline-strong),0_0.0625rem_0.125rem_-0.0625rem_rgba(0,0,0,0.05)]"
    data-testid="browser-snapshot-card"
  >
    <div class="flex items-center gap-2 px-3 py-2.5">
      <span
        class="flex size-[1.125rem] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] text-[var(--primary)]"
        aria-hidden="true"
      >
        <CameraIcon size={10} strokeWidth={1.9} />
      </span>
      <span class="shrink-0 font-medium text-(--solus-text-primary)">
        Snapshot
      </span>
      <span class="min-w-0 flex-1 truncate text-(--solus-text-tertiary)">
        {caption}
      </span>

      {#if errorLabel}
        <!-- A page can look right and be broken. This is the one fact the
             picture cannot carry, so it sits beside it rather than in the tool
             output — and it is the only colour on the card, so it is never
             competing with a badge that is always there. -->
        <span
          class="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] px-2 py-0.5 text-[color:color-mix(in_oklch,var(--destructive)_78%,var(--foreground))]"
        >
          <TriangleAlertIcon size={11} aria-hidden="true" />
          {errorLabel}
        </span>
      {/if}

      <span class="shrink-0 text-(--solus-text-tertiary)">
        {relativeTime(snapshot.capturedAt)}
      </span>
    </div>

    <!-- The evidence. Capped and top-anchored while it is a thumbnail — the top
         of a page is what a reader recognises it by — and released to the
         capture's own shape once expanded, which the ratio reserves so the
         transcript does not jump under the reader as the image resolves. -->
    <div
      class="browser-snapshot-card__frame relative overflow-hidden border-t border-[var(--hairline)] bg-[var(--wash-1)]"
      class:browser-snapshot-card__frame--expanded={expanded}
      class:browser-snapshot-card__frame--enters={!skipMotion}
      style:--snapshot-ratio={facts.aspectRatio}
    >
      <div
        class="flex h-full w-full justify-center {expanded
          ? 'items-center [&_img]:h-full [&_img]:w-full [&_img]:object-contain'
          : 'items-start [&_img]:w-full'}"
      >
        <MarkdownImage href={`asset://${snapshot.assetId}`} text={title} />
      </div>

      <span
        class="pointer-events-none absolute bottom-2 left-2 rounded-full bg-[color-mix(in_oklch,var(--foreground)_78%,transparent)] px-2 py-0.5 text-[color:var(--background)] tabular-nums"
      >
        {stamp}
      </span>

      <button
        type="button"
        class="absolute right-2 bottom-2 flex size-6 items-center justify-center rounded-lg bg-[color-mix(in_oklch,var(--background)_88%,transparent)] text-(--solus-text-secondary) opacity-0 shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:text-(--solus-text-primary) focus-visible:opacity-100"
        aria-label={expanded ? "Collapse this capture" : "Expand this capture"}
        aria-pressed={expanded}
        onclick={() => (expanded = !expanded)}
      >
        {#if expanded}
          <MinimizeIcon size={12} />
        {:else}
          <MaximizeIcon size={12} />
        {/if}
      </button>
    </div>

    <div
      class="flex items-center gap-1.5 border-t border-[var(--hairline)] py-2 pr-2 pl-3"
    >
      <span class="min-w-0 flex-1 truncate text-(--solus-text-tertiary)">
        {address}
      </span>
      {#if pageIsOpen}
        <button
          type="button"
          class="shrink-0 rounded-md px-2 py-1 font-medium text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
          onclick={annotatePage}
        >
          Annotate
        </button>
      {/if}
      <button
        type="button"
        class="shrink-0 rounded-md bg-[var(--wash-2)] px-2.5 py-1 font-medium text-(--solus-text-primary) shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] transition-colors hover:bg-[var(--wash-3)]"
        onclick={openPage}
      >
        Open in pane
      </button>
    </div>
  </div>
</div>

<style>
  /* Height, not a Tailwind rung: the cap is the spec's own number and it is
     released — not merely raised — once the reader expands the capture. */
  .browser-snapshot-card__frame {
    height: 9.375rem;
  }

  .browser-snapshot-card__frame--enters {
    animation: browser-frame-in 260ms ease-out;
  }

  .browser-snapshot-card__frame--expanded {
    height: auto;
    aspect-ratio: var(--snapshot-ratio);
  }

  @keyframes browser-frame-in {
    from {
      opacity: 0;
      transform: scale(1.03);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .browser-snapshot-card__frame--enters {
      animation: none;
    }
  }
</style>
