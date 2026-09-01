<script lang="ts">
  import { Network as ArchitectureIcon, CircleAlert as WarningCircleIcon, PanelRight as PanelRightIcon } from "@lucide/svelte";
  import type { DiagramEmbedWorkSource } from "./diagramEmbedExtension";

  interface Props {
    workId: string;
    fallbackTitle: string;
    worksStore: DiagramEmbedWorkSource;
    onOpen: (workId: string) => void;
    onOpenSecondary: (workId: string) => void;
  }

  let { workId, fallbackTitle, worksStore, onOpen, onOpenSecondary }: Props = $props();
  let root: HTMLDivElement | null = $state(null);
  let isNearViewport = $state(false);
  let loadFinished = $state(false);

  const work = $derived(worksStore.works[workId]);
  const title = $derived(work?.title || fallbackTitle || "Untitled diagram");
  const isWrongType = $derived(!!work && work.type !== "diagram");
  const isMissing = $derived(loadFinished && !work);
  const canOpen = $derived(!isMissing && !isWrongType);

  $effect(() => {
    const element = root;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      isNearViewport = true;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          isNearViewport = true;
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!isNearViewport) return;
    let current = true;
    void worksStore.ensureContent(workId, "diagram-embed").finally(() => {
      if (current) loadFinished = true;
    });
    return () => {
      current = false;
    };
  });
</script>

<!-- The card is a frame, not a button: the canvas inside it is read and
     navigated in place, so opening is what the two header actions are for. -->
<div
  bind:this={root}
  class="diagram-embed group my-5 block w-full overflow-hidden rounded-xl border border-(--solus-tool-border) bg-(--solus-container-bg) text-left shadow-[shadow:var(--solus-tx-card-shadow)] transition-[border-color,box-shadow] duration-(--duration-base) ease-(--ease-premium) hover:border-(--solus-accent-border) hover:shadow-[shadow:var(--solus-tx-card-shadow-hover)]"
>
  <div class="flex items-center gap-2.5 border-b border-(--solus-tool-border) px-3 py-2.5">
    <span class="grid size-6 shrink-0 place-items-center rounded-lg bg-(--solus-accent-soft) text-(--solus-accent)">
      <ArchitectureIcon size={13} />
    </span>
    <span class="min-w-0 flex-1 truncate text-sm font-medium tracking-[-0.005em] text-(--solus-text-primary)">{title}</span>
    {#if canOpen}
      <button
        type="button"
        class="grid size-6 shrink-0 place-items-center rounded-md text-(--solus-text-tertiary) transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        title="Open in split"
        aria-label={`Open diagram in split: ${title}`}
        onclick={() => onOpenSecondary(workId)}
      >
        <PanelRightIcon size={13} />
      </button>
      <button
        type="button"
        class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-secondary) transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        aria-label={`Open diagram: ${title}`}
        onclick={() => onOpen(workId)}
      >
        Open
      </button>
    {/if}
  </div>

  {#if !isNearViewport || (!loadFinished && !work?.content)}
    <div class="flex h-52 items-center justify-center bg-(--solus-container-bg)" role="status">
      <span class="text-xs text-(--solus-text-tertiary)">Loading diagram…</span>
    </div>
  {:else if isMissing}
    <div class="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center">
      <WarningCircleIcon size={20} class="text-(--solus-status-error)" />
      <span class="text-sm font-medium text-(--solus-text-secondary)">Diagram no longer exists</span>
      <span class="text-xs text-(--solus-text-tertiary)">{fallbackTitle}</span>
    </div>
  {:else if isWrongType}
    <div class="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center">
      <WarningCircleIcon size={20} class="text-(--solus-status-error)" />
      <span class="text-sm font-medium text-(--solus-text-secondary)">Referenced work is not a diagram</span>
    </div>
  {:else if work?.content}
    <!-- Mounted only once the card is near the viewport, so a document full of
         embeds costs one canvas per diagram the reader actually reaches. -->
    <div class="diagram-embed__canvas max-h-[55cqh]" draggable="false">
      {#await import("../diagram/DiagramPreview.svelte") then previewModule}
        <previewModule.default content={work.content} {title} />
      {/await}
    </div>
  {:else}
    <div class="flex h-40 items-center justify-center text-sm text-(--solus-text-tertiary)">Empty diagram</div>
  {/if}
</div>

<style>
  /* Geometry, so it follows the monitor rather than the window (ADR-0010): a
     desktop display has the room to read a graph without zooming, a laptop
     does not and keeps the shorter frame. `max-height` is what protects a
     short pane and a phone. */
  .diagram-embed__canvas {
    height: 28rem;
    min-height: 14rem;
  }

  :global(html.is-laptop-display) .diagram-embed__canvas {
    height: 20rem;
  }
</style>
