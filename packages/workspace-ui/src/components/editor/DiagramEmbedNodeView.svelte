<script lang="ts">
  import { ExternalLink as ArrowSquareOutIcon, ChartNoAxesColumnIncreasing as GraphIcon, CircleAlert as WarningCircleIcon } from "@lucide/svelte";
  import type { DiagramEmbedWorkSource } from "./diagramEmbedExtension";

  interface Props {
    workId: string;
    fallbackTitle: string;
    worksStore: DiagramEmbedWorkSource;
    onOpen: (workId: string) => void;
  }

  let { workId, fallbackTitle, worksStore, onOpen }: Props = $props();
  let root: HTMLButtonElement | null = $state(null);
  let isNearViewport = $state(false);
  let loadFinished = $state(false);

  const work = $derived(worksStore.works[workId]);
  const title = $derived(work?.title || fallbackTitle || "Untitled diagram");
  const isWrongType = $derived(!!work && work.type !== "diagram");
  const isMissing = $derived(loadFinished && !work);

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

<button
  bind:this={root}
  type="button"
  class="diagram-embed group my-5 block w-full overflow-hidden rounded-xl border border-(--solus-tool-border) bg-(--solus-container-bg) text-left shadow-[shadow:var(--solus-tx-card-shadow)] transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-(--ease-premium) hover:-translate-y-px hover:border-(--solus-accent-border) hover:shadow-[shadow:var(--solus-tx-card-shadow-hover)] active:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
  aria-label={`Open diagram: ${title}`}
  onclick={() => !isMissing && !isWrongType && onOpen(workId)}
>
  <span class="flex items-center gap-2.5 border-b border-(--solus-tool-border) px-3 py-2.5">
    <span class="grid size-6 shrink-0 place-items-center rounded-lg bg-(--solus-accent-soft) text-(--solus-accent)">
      <GraphIcon size={13} weight="bold" />
    </span>
    <span class="min-w-0 flex-1 truncate text-sm font-medium tracking-[-0.005em] text-(--solus-text-primary)">{title}</span>
    {#if !isMissing && !isWrongType}
      <span class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-(--solus-text-tertiary) opacity-0 transition-opacity duration-(--duration-quick) ease-(--ease-premium) group-hover:opacity-100 group-focus-visible:opacity-100">
        Open
        <ArrowSquareOutIcon size={12} />
      </span>
    {/if}
  </span>

  {#if !isNearViewport || (!loadFinished && !work?.content)}
    <span class="flex h-52 items-center justify-center bg-(--solus-container-bg)" role="status">
      <span class="text-xs text-(--solus-text-tertiary)">Loading diagram…</span>
    </span>
  {:else if isMissing}
    <span class="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center">
      <WarningCircleIcon size={20} class="text-(--solus-status-error)" />
      <span class="text-sm font-medium text-(--solus-text-secondary)">Diagram no longer exists</span>
      <span class="text-xs text-(--solus-text-tertiary)">{fallbackTitle}</span>
    </span>
  {:else if isWrongType}
    <span class="flex h-40 flex-col items-center justify-center gap-2 px-6 text-center">
      <WarningCircleIcon size={20} class="text-(--solus-status-error)" />
      <span class="text-sm font-medium text-(--solus-text-secondary)">Referenced work is not a diagram</span>
    </span>
  {:else if work?.content}
    <span class="block h-64 max-h-[45cqh] min-h-48">
      {#await import("../diagram/DiagramThumbnail.svelte") then thumbnailModule}
        <thumbnailModule.default content={work.content} />
      {/await}
    </span>
  {:else}
    <span class="flex h-40 items-center justify-center text-sm text-(--solus-text-tertiary)">Empty diagram</span>
  {/if}
</button>
