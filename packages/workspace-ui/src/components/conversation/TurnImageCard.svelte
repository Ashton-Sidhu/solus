<script lang="ts">
  import type { ReplyImage } from "@solus/client-core/reply-images";
  import * as Carousel from "../ui/carousel";
  import MarkdownImage from "./MarkdownImage.svelte";
  import { getMarkdownImageContext } from "./lib/markdown-image";
  import { requestFilePreview } from "../../lib/filePreview";
  import { nearViewport } from "../../lib/near-viewport";

  /** One image of a turn's gallery. It signs its URL only once it comes near the viewport. */
  let { image, serverId, gallery }: { image: ReplyImage; serverId?: string; gallery?: readonly string[] } = $props();
  const context = getMarkdownImageContext();
  let isNear = $state(false);
</script>

<Carousel.Item class="basis-34 ps-2">
  <button
    type="button"
    class="my-1 w-32 shrink-0 cursor-zoom-in rounded-lg border border-border/50 bg-muted/20 p-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    aria-label="Open {image.label}"
    onclick={() => requestFilePreview({
      path: image.href,
      mediaKind: "image",
      gallery,
      source: { serverId: serverId ?? context?.serverId(), cwd: context?.cwd(), ctx: context?.ctx() },
    })}
  >
    <div class="h-14 [&>img]:h-full [&>img]:w-full [&>img]:object-contain [&>img]:rounded-sm" use:nearViewport={() => (isNear = true)}>
      {#if isNear}<MarkdownImage href={image.href} text={image.label} />{/if}
    </div>
    <span class="mt-1.5 block truncate text-chrome-dense" title={image.label}>{image.label}</span>
    <span class="block text-chrome-dense text-muted-foreground">{image.format}</span>
  </button>
</Carousel.Item>
