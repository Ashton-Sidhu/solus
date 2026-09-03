<script lang="ts">
  import type { ReferenceListItem } from "./lib/symbol-card";
  import { previewSegments } from "./lib/symbol-card";
  import { runtime } from "../../contexts";
  import VirtualList from "../ui/list-page/VirtualList.svelte";

  interface Props {
    items: ReferenceListItem[];
    symbolName: string;
    error: string | null;
    onNavigate: (path: string, line: number) => void;
    onToggleFile: (path: string) => void;
    onLoadMore: () => void;
  }

  let { items, symbolName, error, onNavigate, onToggleFile, onLoadMore }: Props = $props();

  const VIRTUALIZE_AFTER = 80;
  const REFERENCE_ITEM_HEIGHT = 30;
  const referenceListHeight = $derived(
    runtime.isLaptopDisplay && !runtime.isTouchDevice ? 288 : 368,
  );
  const shouldVirtualize = $derived(items.length > VIRTUALIZE_AFTER);
</script>

{#snippet referenceItem(item: ReferenceListItem, style?: string)}
  <div {style} class="h-[30px]">
    {#if item.kind === "header"}
      <div class="flex h-full min-w-0 items-baseline gap-1.5 px-5 pt-2 pb-0.5 text-workspace-chrome pointer-fine:[.is-laptop-display_&]:px-4">
        <span class="shrink-0 font-medium text-(--solus-text-primary)">{item.group.name}</span>
        <span class="min-w-0 flex-1 truncate text-symbol-card-meta text-(--solus-text-tertiary)">{item.group.dir}</span>
        {#if item.group.isCurrentFile}
          <span class="shrink-0 rounded-sm bg-(--solus-accent-light) px-1 text-symbol-card-meta leading-4 text-(--solus-accent)">this file</span>
        {/if}
      </div>
    {:else if item.kind === "reference"}
      <button
        type="button"
        aria-label={`${item.fileName} line ${item.row.line}`}
        class="flex h-full min-w-0 w-full items-baseline gap-2.5 overflow-hidden px-5 py-1 text-left outline-hidden transition-[background-color] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) focus-visible:shadow-[shadow:inset_0_0_0_62rem_var(--solus-menu-hover-ink)] pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:px-4"
        onclick={() => onNavigate(item.row.path, item.row.line)}
      >
        <span class="w-6 shrink-0 text-right font-[family-name:var(--solus-code-font-family)] text-micro leading-[1.5] text-(--solus-text-tertiary) tabular-nums">{item.row.line}</span>
        {#if item.row.preview}
          {@const segments = previewSegments(item.row.preview)}
          <span class="min-w-0 flex-1 truncate font-[family-name:var(--solus-code-font-family)] text-symbol-card-code leading-[1.5] whitespace-pre text-(--solus-text-tertiary)">{segments.before}<span
              class="font-semibold text-(--solus-text-primary)">{segments.match}</span>{segments.after}</span>
        {:else}
          <span class="min-w-0 flex-1 truncate font-[family-name:var(--solus-code-font-family)] text-symbol-card-code leading-[1.5] font-semibold text-(--solus-text-primary)">{symbolName}</span>
        {/if}
      </button>
    {:else if item.kind === "toggle"}
      <button
        type="button"
        class="flex h-full w-full items-baseline gap-2.5 px-5 py-1 text-left text-symbol-card-meta text-(--solus-text-tertiary) outline-hidden transition-[color,background-color] duration-(--duration-quick) ease-(--ease-premium) hover:text-(--solus-text-primary) focus-visible:shadow-[shadow:inset_0_0_0_62rem_var(--solus-menu-hover-ink)] focus-visible:text-(--solus-text-primary) pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:px-4"
        onclick={() => onToggleFile(item.path)}
      >
        <span class="w-6 shrink-0"></span>
        <span class="min-w-0 flex-1 truncate tabular-nums">
          {item.isExpanded ? "Show fewer" : `${item.hiddenCount} more in this file`}
        </span>
      </button>
    {:else}
      <!-- The tail of the list, not a call site. It reads as a quiet centered
           line like every other paged tail in the app, so the last row does not
           look like one more reference. -->
      <button
        type="button"
        class="flex h-full w-full cursor-pointer items-center justify-center gap-1.5 overflow-hidden px-5 text-symbol-card-meta text-(--solus-text-tertiary) outline-hidden transition-[color,background-color] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[shadow:inset_0_0_0_62rem_var(--solus-menu-hover-ink)] focus-visible:text-(--solus-text-primary) aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-(--solus-text-tertiary) pointer-fine:[.is-laptop-display_&]:px-4"
        aria-disabled={item.isLoading}
        aria-busy={item.isLoading}
        onclick={onLoadMore}
      >
        {#if item.isLoading}
          <span class="truncate">Loading…</span>
        {:else if item.hasError}
          <span class="truncate">Try loading again</span>
        {:else}
          <span class="truncate">Load more</span>
          <span class="shrink-0 tabular-nums opacity-70">{item.remaining}</span>
        {/if}
      </button>
    {/if}
  </div>
{/snippet}

{#if shouldVirtualize}
  <VirtualList
    {items}
    height={referenceListHeight}
    itemSize={REFERENCE_ITEM_HEIGHT}
    keyOf={(item) => item.key}
  >
    {#snippet children(item, _index, style)}
      {@render referenceItem(item, style)}
    {/snippet}
  </VirtualList>
{:else}
  <div class="max-h-[23rem] overflow-auto pb-2 pointer-fine:[.is-laptop-display_&]:max-h-72">
    {#each items as item (item.key)}
      {@render referenceItem(item)}
    {/each}
  </div>
{/if}

{#if error}
  <div class="px-5 pb-2 text-symbol-card-meta text-(--solus-status-error) pointer-fine:[.is-laptop-display_&]:px-4">
    {error}
  </div>
{/if}
