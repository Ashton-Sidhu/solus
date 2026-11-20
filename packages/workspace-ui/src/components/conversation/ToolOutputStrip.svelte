<script lang="ts">
  import { CircleAlert, Image as ImageIcon, Play } from "@lucide/svelte";
  import type { ReplyImage } from "@solus/client-core/reply-images";
  import type { ToolStrip } from "@solus/client-core/tool-outputs";
  import { SvelteSet } from "svelte/reactivity";
  import MarkdownImage from "./MarkdownImage.svelte";
  import { getMarkdownImageContext } from "./lib/markdown-image";
  import { requestFilePreview } from "../../lib/filePreview";
  import { nearViewport } from "../../lib/near-viewport";

  /**
   * What a folded row holds (docs/transcript-cards.md, "Tool outputs"): a
   * thumbnail for each image its calls returned, then one chip for each audio
   * clip and for each call's left-out notes. A thumbnail opens the image
   * viewer on the row's images; a chip opens the folds down to its tool line.
   */
  let { strip, onOpen }: { strip: ToolStrip; onOpen: (toolId: string, chip: HTMLElement) => void } = $props();
  const context = getMarkdownImageContext();
  // A thumbnail signs its URL only once it comes near the viewport.
  const nearHrefs = new SvelteSet<string>();

  function openImage(image: ReplyImage): void {
    requestFilePreview({
      path: image.href,
      mediaKind: "image",
      gallery: strip.images.map((each) => each.href),
      source: { serverId: context?.serverId(), cwd: context?.cwd(), ctx: context?.ctx() },
    });
  }
</script>

<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 pt-0.5" data-slot="tool-output-strip">
  {#each strip.thumbnails as thumbnail (thumbnail.key)}
    <button
      type="button"
      class="grid h-10 w-14 shrink-0 cursor-zoom-in place-items-center overflow-hidden rounded-md border border-border/60 bg-muted/20 text-muted-foreground transition-colors hover:border-border focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border-medium) [&>img]:size-full [&>img]:object-cover [&>img]:text-[length:0]"
      aria-label="Open {thumbnail.image.label}"
      title={thumbnail.image.label}
      onclick={() => openImage(thumbnail.image)}
      use:nearViewport={() => nearHrefs.add(thumbnail.image.href)}
    >
      {#if nearHrefs.has(thumbnail.image.href) && context?.serverId()}
        <MarkdownImage href={thumbnail.image.href} text={thumbnail.image.label} />
      {:else}
        <ImageIcon size={14} strokeWidth={1.75} aria-hidden="true" />
      {/if}
    </button>
  {/each}
  {#if strip.moreCount > 0}
    <button
      type="button"
      class="grid h-10 w-14 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border-medium)"
      aria-label="Open {strip.moreCount} more tool images"
      onclick={() => openImage(strip.images[strip.thumbnails.length])}
    >
      +{strip.moreCount}
    </button>
  {/if}
  {#each strip.chips as chip (chip.key)}
    <button
      type="button"
      class="inline-flex h-6 max-w-[min(14rem,100%)] min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-full border-0 bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] pr-2.5 pl-2 text-xs leading-[1.35] font-medium text-muted-foreground transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-8"
      aria-label={chip.kind === "audio" ? `Open the ${chip.server} audio` : `Open what was left out of the result`}
      onclick={(event) => onOpen(chip.toolId, event.currentTarget)}
    >
      {#if chip.kind === "audio"}
        <Play size={11} class="shrink-0 fill-current" aria-hidden="true" />
        <span class="min-w-0 truncate text-(--solus-text-primary)">{chip.server}</span>
        <span class="shrink-0 font-normal">{chip.format}</span>
      {:else}
        <CircleAlert size={13} strokeWidth={1.75} class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 truncate">{chip.count} left out</span>
      {/if}
    </button>
  {/each}
</div>
