<script lang="ts">
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import type { Message } from "@solus/contracts/types";
  import { browserSnapshotLabel } from "@solus/client-core/browser-snapshot-label";
  import * as Carousel from "../ui/carousel";
  import MarkdownImage from "./MarkdownImage.svelte";
  import { getMarkdownImageContext } from "./lib/markdown-image";
  import { messageImages } from "./lib/turn-images";
  import { requestFilePreview } from "../../lib/filePreview";
  import { snapshotHref } from "../browser/lib/snapshot-card";

  let { message, serverId, snapshots, getGallery }: { message: Message; serverId?: string; snapshots: readonly BrowserSnapshotRef[]; getGallery: () => string[] } = $props();
  const context = getMarkdownImageContext();
  /** A capture is one more picture in the gallery, with its page's name. */
  const tiles = $derived(message.browserSnapshot
    ? [{ href: snapshotHref(message.browserSnapshot), label: browserSnapshotLabel(message.browserSnapshot), format: "PNG" }]
    : messageImages(message));

  function open(href: string) {
    requestFilePreview({
      path: href,
      mediaKind: "image",
      gallery: getGallery(),
      snapshots,
      source: { serverId: serverId ?? context?.serverId(), cwd: context?.cwd(), ctx: context?.ctx() },
    });
  }
</script>

{#each tiles as tile, index (index)}
  <Carousel.Item class="basis-34 ps-2">
  <button
    type="button"
    class="my-1 w-32 shrink-0 cursor-zoom-in rounded-lg border border-border/50 bg-muted/20 p-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    aria-label="Open {tile.label}"
    onclick={() => open(tile.href)}
  >
    <div class="h-14 overflow-hidden rounded-sm [&_img]:h-full [&_img]:w-full [&_img]:object-contain">
      <MarkdownImage href={tile.href} text={tile.label} />
    </div>
    <span class="mt-1.5 block truncate text-chrome-dense" title={tile.label}>{tile.label}</span>
    <span class="block text-chrome-dense text-muted-foreground">{tile.format}</span>
  </button>
  </Carousel.Item>
{/each}
