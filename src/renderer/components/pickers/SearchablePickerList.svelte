<script lang="ts">
  import { tick } from "svelte";
  import { CheckIcon, MagnifyingGlassIcon } from "phosphor-svelte";
  import VirtualList from "svelte-tiny-virtual-list";
  import Input from "../ui/Input.svelte";

  interface Props {
    items: string[];
    selected: string | null;
    placeholder?: string;
    emptyLabel?: string;
    autofocus?: boolean;
    size?: "compact" | "comfortable";
    onselect: (item: string) => void;
  }
  let {
    items,
    selected,
    placeholder = "Filter...",
    emptyLabel = "No results found",
    autofocus = true,
    size = "compact",
    onselect,
  }: Props = $props();

  let inputEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null)
  let query = $state("");
  let focusedIndex = $state(0);

  const filtered = $derived(
    query
      ? items.filter((item) =>
          item.toLowerCase().includes(query.toLowerCase()),
        )
      : items,
  );
  const isComfortable = $derived(size === "comfortable");
  const itemSize = $derived(isComfortable ? 34 : 28);
  const listHeight = $derived(
    Math.min(filtered.length * itemSize, isComfortable ? 238 : 196),
  );

  $effect(() => {
    if (autofocus) tick().then(() => inputEl?.focus());
  });

  export function handleKeydown(e: KeyboardEvent): boolean {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, filtered.length - 1);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
      return true;
    }
    if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      onselect(filtered[focusedIndex]);
      return true;
    }
    return false;
  }
</script>

<div class={isComfortable ? "px-2.5 pb-2" : "px-2 pb-1.5"}>
  <div
    class="flex items-center gap-1.5 rounded-lg bg-(--solus-surface-hover) border border-(--solus-popover-border) {isComfortable
      ? 'px-2.5 py-1.5'
      : 'px-2 py-1'}"
  >
    <MagnifyingGlassIcon size={isComfortable ? 13 : 11} class="text-(--solus-text-tertiary) shrink-0" />
    <Input
      bind:el={inputEl}
      bind:value={query}
      type="text"
      variant="bare"
      size="sm"
      {placeholder}
      oninput={() => { focusedIndex = 0 }}
    />
  </div>
</div>

{#if filtered.length === 0}
  <div class="px-3 py-2 {isComfortable ? 'text-xs' : 'text-sm sm:text-xs'} text-(--solus-text-tertiary) text-center">
    {emptyLabel}
  </div>
{:else}
  <VirtualList
    width="100%"
    height={listHeight}
    itemCount={filtered.length}
    itemSize={itemSize}
    overscanCount={3}
    scrollToIndex={focusedIndex}
    scrollToAlignment="auto"
  >
    {#snippet item({ style, index })}
      {@const entry = filtered[index]}
      {@const isSelected = entry === selected}
      {@const isFocused = index === focusedIndex}
      <div {style}>
        <button
          class="relative w-full flex items-center justify-between transition-colors {isComfortable
            ? 'px-3.5 text-xs'
            : 'px-3 text-sm sm:text-[0.6875rem]'}"
          style="height:{itemSize}px;color:{isSelected
            ? 'var(--solus-text-primary)'
            : 'var(--solus-text-secondary)'};font-weight:{isSelected
            ? 600
            : 400};background:{isFocused
            ? 'var(--solus-accent-light)'
            : 'transparent'}"
          onclick={() => onselect(entry)}
          onmouseenter={() => {
            focusedIndex = index;
          }}
        >
          <span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
          <span class="truncate">{entry}</span>
          {#if isSelected}
            <CheckIcon size={isComfortable ? 14 : 12} class="text-(--solus-accent) shrink-0" />
          {/if}
        </button>
      </div>
    {/snippet}
  </VirtualList>
{/if}
