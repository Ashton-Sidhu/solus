<script lang="ts">
  import type { Message } from "@solus/contracts/types";
  import * as Carousel from "../ui/carousel";
  import type { CarouselAPI } from "../ui/carousel/context";
  import TurnImages from "./TurnImages.svelte";
  import { hasGallerySlides } from "./lib/turn-images";

  let { messages, serverId }: { messages: Message[]; serverId?: string } = $props();
  let api = $state<CarouselAPI>();
  let count = $state(0);
  const snapshots = $derived(messages.flatMap((message) => message.browserSnapshot ? [message.browserSnapshot] : []));
  const options = { align: "start" as const, slidesToScroll: "auto" as const };
  const hasSlides = $derived(hasGallerySlides(messages));

  // The children read their own messages. Count mounted slides rather than
  // parsing every reply again when one message streams or a capture arrives.
  $effect(() => {
    const gallery = api;
    if (!gallery) return;
    const update = () => { count = gallery.slideNodes().length; };
    update();
    gallery.on("reInit", update);
    return () => { gallery.off("reInit", update); };
  });
</script>

{#if hasSlides}
<Carousel.Root opts={options} setApi={(value) => { api = value; }} class="my-1 w-full min-w-0 [&:not(:has([data-embla-slide]))]:hidden" aria-label="Turn image gallery">
  <div class="mb-1 flex items-center justify-between gap-2 text-chrome-dense text-muted-foreground">
    <span>Images <span class="tabular-nums">{count}</span></span>
    <div class="flex gap-1">
      <Carousel.Previous class="static size-6 border-0 bg-transparent shadow-none" />
      <Carousel.Next class="static size-6 border-0 bg-transparent shadow-none" />
    </div>
  </div>
  <Carousel.Content class="-ms-2">
    {#each messages as message (message.id)}
      <TurnImages {message} {serverId} {snapshots} />
    {/each}
  </Carousel.Content>
</Carousel.Root>
{/if}
