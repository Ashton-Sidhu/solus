<script lang="ts">
  import { tick } from "svelte";
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import { getWorkspaceContext } from "../../contexts";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { toasts } from "../../lib/toasts";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import BrowserSnapshotLightbox from "./BrowserSnapshotLightbox.svelte";
  import * as Carousel from "../ui/carousel";
  import { galleryTiles } from "./lib/snapshot-gallery";

  interface Props {
    snapshots: BrowserSnapshotRef[];
    focusSnapshot?: BrowserSnapshotRef;
    serverId: string | undefined;
  }

  let { snapshots, serverId, focusSnapshot }: Props = $props();
  const session = getWorkspaceContext();

  const tiles = $derived(galleryTiles(snapshots).filter((tile) => !focusSnapshot || tile.snapshot === focusSnapshot));
  let openIndex = $state<number | null>(null);
  let frameEl: HTMLButtonElement | null = $state(null);

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

</script>

  {#each tiles as tile, index (index)}
    <Carousel.Item class="basis-34 ps-2">
    <button
      type="button"
      class="my-1 w-32 shrink-0 cursor-zoom-in rounded-lg border border-border/50 bg-muted/20 p-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label="Open {tile.alt}"
      onclick={(event) => { frameEl = event.currentTarget; openIndex = snapshots.indexOf(tile.snapshot); }}
    >
      <div class="h-14 overflow-hidden rounded-sm [&_img]:h-full [&_img]:w-full [&_img]:object-contain">
        <MarkdownImage href={`asset://${tile.snapshot.assetId}`} text={tile.alt} />
      </div>
      <span class="mt-1.5 block truncate text-chrome-dense" title={tile.alt}>{tile.snapshot.title || "Browser screenshot"}</span>
      <span class="block text-chrome-dense text-muted-foreground">PNG</span>
    </button>
    </Carousel.Item>
  {/each}
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
