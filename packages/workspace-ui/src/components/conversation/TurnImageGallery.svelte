<script lang="ts">
  import type { Message } from "@solus/contracts/types";
  import * as Carousel from "../ui/carousel";
  import type { CarouselAPI } from "../ui/carousel/context";
  import TurnImages from "./TurnImages.svelte";
  import TurnImageCard from "./TurnImageCard.svelte";
  import { getMarkdownImageContext } from "./lib/markdown-image";
  import { hasGallerySlides, turnGallery } from "./lib/turn-images";
  import { requestFilePreview } from "../../lib/filePreview";

  /** `messages` are the turn's replies and captures; `tools` its calls, whose images join at their call. */
  let { messages, tools = [], serverId }: { messages: Message[]; tools?: Message[]; serverId?: string } = $props();
  const context = getMarkdownImageContext();
  let api = $state<CarouselAPI>();
  let count = $state(0);
  const snapshots = $derived(messages.flatMap((message) => message.browserSnapshot ? [message.browserSnapshot] : []));
  const options = { align: "start" as const, slidesToScroll: "auto" as const };
  const gallery = $derived(turnGallery(messages, tools));
  const toolHrefs = $derived(gallery.toolImages.map((image) => image.href));
  const hasSlides = $derived(gallery.toolImages.length > 0 || hasGallerySlides(messages));

  // The children read their own messages. Count mounted slides rather than
  // parsing every reply again when one message streams or a capture arrives.
  $effect(() => {
    const carousel = api;
    if (!carousel) return;
    const update = () => { count = carousel.slideNodes().length; };
    update();
    carousel.on("reInit", update);
    return () => { carousel.off("reInit", update); };
  });

  function openMore() {
    const first = gallery.toolImages[gallery.toolImages.length - gallery.moreCount];
    if (!first) return;
    requestFilePreview({
      path: first.href,
      mediaKind: "image",
      gallery: toolHrefs,
      source: { serverId: serverId ?? context?.serverId(), cwd: context?.cwd(), ctx: context?.ctx() },
    });
  }
</script>

{#if hasSlides}
<Carousel.Root opts={options} setApi={(value) => { api = value; }} class="my-1 w-full min-w-0 [&:not(:has([data-embla-slide]))]:hidden" aria-label="Turn image gallery">
  <div class="mb-1 flex items-center justify-between gap-2 text-chrome-dense text-muted-foreground">
    <!-- The last card stands for the images past the limit. -->
    <span>Images <span class="tabular-nums">{gallery.moreCount > 0 ? count - 1 + gallery.moreCount : count}</span></span>
    <div class="flex gap-1">
      <Carousel.Previous class="static size-6 border-0 bg-transparent shadow-none" />
      <Carousel.Next class="static size-6 border-0 bg-transparent shadow-none" />
    </div>
  </div>
  <Carousel.Content class="-ms-2">
    {#each gallery.entries as entry (entry.key)}
      {#if entry.kind === "message"}
        <TurnImages message={entry.message} {serverId} {snapshots} />
      {:else}
        <TurnImageCard image={entry.image} {serverId} gallery={toolHrefs} />
      {/if}
    {/each}
    {#if gallery.moreCount > 0}
      <Carousel.Item class="basis-34 ps-2">
        <button
          type="button"
          class="my-1 flex h-[calc(100%-0.5rem)] w-32 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-border/50 p-2 text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label="Open {gallery.moreCount} more tool images"
          onclick={openMore}
        >
          <span class="text-workspace-chrome tabular-nums text-foreground">+{gallery.moreCount}</span>
          <span class="text-chrome-dense">more images</span>
        </button>
      </Carousel.Item>
    {/if}
  </Carousel.Content>
</Carousel.Root>
{/if}
