<script lang="ts">
  import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
  import type { Message } from "@solus/contracts/types";
  import * as Carousel from "../ui/carousel";
  import MarkdownImage from "./MarkdownImage.svelte";
  import { getMarkdownImageContext } from "./lib/markdown-image";
  import { messageImages } from "./lib/turn-images";
  import { requestFilePreview } from "../../lib/filePreview";
  import BrowserSnapshots from "../browser/BrowserSnapshots.svelte";

  let { message, serverId, snapshots = [] }: { message: Message; serverId?: string; snapshots?: BrowserSnapshotRef[] } = $props();
  const context = getMarkdownImageContext();
  const images = $derived(messageImages(message));
</script>

{#if message.browserSnapshot}
  <BrowserSnapshots snapshots={snapshots.length ? snapshots : [message.browserSnapshot]} focusSnapshot={message.browserSnapshot} {serverId} />
{:else}
  {#each images as image, index (index)}
    <Carousel.Item class="basis-34 ps-2">
    <button
      type="button"
      class="my-1 w-32 shrink-0 cursor-zoom-in rounded-lg border border-border/50 bg-muted/20 p-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label="Open {image.label}"
      onclick={() => requestFilePreview({
        path: image.href,
        mediaKind: "image",
        source: { serverId: serverId ?? context?.serverId(), cwd: context?.cwd(), ctx: context?.ctx() },
      })}
    >
      <div class="h-14 [&>img]:h-full [&>img]:w-full [&>img]:object-contain [&>img]:rounded-sm">
        <MarkdownImage href={image.href} text={image.label} />
      </div>
      <span class="mt-1.5 block truncate text-chrome-dense" title={image.label}>{image.label}</span>
      <span class="block text-chrome-dense text-muted-foreground">{image.format}</span>
    </button>
    </Carousel.Item>
  {/each}
{/if}
