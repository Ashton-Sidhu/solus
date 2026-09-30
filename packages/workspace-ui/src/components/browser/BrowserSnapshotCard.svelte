<script lang="ts">
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import { Camera as CameraIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { relativeTime } from "../../lib/relative-time";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import {
    snapshotAddress,
    snapshotCaption,
    snapshotErrorLabel,
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
   * One card line and one frame (docs/transcript-cards.md). The line says what
   * was captured and carries the two ways back — annotate the page, or open it
   * in the pane. The frame is the evidence, stamped with the address, the
   * viewport, and the colour scheme it was taken under. A frame without that
   * provenance is decoration.
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

  const caption = $derived(snapshotCaption(snapshot));
  const address = $derived(snapshotAddress(snapshot));
  const stamp = $derived(snapshotStamp(snapshot));
  const errorLabel = $derived(snapshotErrorLabel(snapshot));
  const title = $derived(snapshotTitle(snapshot));

  /** Whether the page this came from is still open. A capture outlives its page,
   *  and the two ways back only exist while there is something to go back to. */
  const pageKey = $derived(
    serverId ? browserStore.keyOf(serverId, snapshot.browserPageId) : null,
  );
  const pageIsOpen = $derived(pageKey ? browserStore.pages.has(pageKey) : false);

  let openingPage = $state(false);

  async function openPage() {
    if (openingPage) return;
    openingPage = true;
    try {
      const host = serverId ?? session.fallbackServerId;
      const browserPageId = await browserStore.openSnapshot(host, snapshot);
      session.openRoute(
        { name: "browser", params: { browserPageId, serverId: host } },
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

  /** The same way back, with the note tools already armed — so feedback lands on
   *  the element and not on the image. The pane opens its annotation bar for a
   *  page that already has a tool armed, so arming it is the whole handshake. */
  function annotatePage() {
    if (pageKey) void browserStore.setAnnotationTool(pageKey, "pick").catch(() => {});
    openPage();
  }
</script>

<TranscriptCard
  title="Snapshot"
  target={caption}
  actionLabel={openingPage ? "Opening…" : "Open"}
  ariaLabel={`Open captured page: ${title}`}
  onOpen={openPage}
  bodyLayout="media"
  data-testid="browser-snapshot-card"
  {skipMotion}
>
  {#snippet glyph()}<CameraIcon />{/snippet}
  {#snippet rail()}
    <!-- A page can look right and be broken. This is the one fact the picture
         cannot carry, so it is the only colour on the card, and absent at zero. -->
    {#if errorLabel}
      <span class="text-destructive">{errorLabel}</span>
    {/if}
    <span>{relativeTime(snapshot.capturedAt)}</span>
  {/snippet}
  {#snippet actions()}
    {#if pageIsOpen}
      <TranscriptCardAction kind="ghost" onclick={annotatePage}>Annotate</TranscriptCardAction>
    {/if}
  {/snippet}
  {#snippet body()}
    <div class="relative h-[9.375rem]">
      <div
        class="flex h-full w-full items-center justify-center [&_img]:h-full [&_img]:w-full [&_img]:object-contain"
      >
        <MarkdownImage href={`asset://${snapshot.assetId}`} text={title} />
      </div>
      <span
        class="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-full bg-(--solus-tx-card-bg) px-2 py-0.5 text-review-meta text-(--muted-foreground) tabular-nums shadow-[shadow:var(--solus-tx-quiet-ring)]"
      >
        {address} · {stamp}
      </span>
    </div>
  {/snippet}
</TranscriptCard>
