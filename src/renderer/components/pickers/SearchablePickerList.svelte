<script lang="ts">
  import { tick } from "svelte";
  import { CheckIcon, MagnifyingGlassIcon } from "phosphor-svelte";
  import VirtualList from "svelte-tiny-virtual-list";
  import { Input } from "../ui/input";

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
    class="flex items-center gap-1.5 rounded-[9px] bg-(--solus-code-bg) shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] {isComfortable
      ? 'px-2.5 py-1.5'
      : 'px-2 py-1'}"
  >
    <MagnifyingGlassIcon size={isComfortable ? 13 : 11} class="text-(--solus-text-tertiary) shrink-0" />
    <Input
      bind:ref={inputEl}
      bind:value={query}
      type="text"
      class="h-auto rounded-none border-0 bg-transparent p-0 text-[0.6875rem] lg:text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
      {placeholder}
      oninput={() => { focusedIndex = 0 }}
    />
  </div>
</div>

{#if filtered.length === 0}
  <div class="px-3 py-2 {isComfortable ? 'text-xs lg:text-[0.8125rem]' : 'text-sm sm:text-xs lg:text-[0.8125rem]'} text-(--solus-text-tertiary) text-center">
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
          class="relative mx-1 w-[calc(100%-0.5rem)] flex items-center justify-between rounded-[9px] transition-colors {isComfortable
            ? 'px-2.5 text-xs lg:text-[0.8125rem]'
            : 'px-2 text-sm sm:text-[0.6875rem] lg:text-xs'}"
          style="height:{itemSize}px;color:{isSelected
            ? 'var(--solus-text-primary)'
            : 'var(--solus-text-secondary)'};font-weight:{isSelected
            ? 500
            : 400};background:{isSelected
            ? isFocused
              ? 'color-mix(in srgb, var(--solus-accent) 13%, transparent)'
              : 'var(--solus-accent-light)'
            : isFocused
              ? 'var(--solus-surface-hover)'
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
