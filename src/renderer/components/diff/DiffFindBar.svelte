<script lang="ts">
  import { CaretDownIcon, CaretUpIcon, MagnifyingGlassIcon, XIcon } from "phosphor-svelte";
  import { tooltip } from "../../lib/tooltip";

  interface Props {
    query: string;
    current: number; // 1-based index of the active match, 0 when none
    total: number;
    onQueryChange: (value: string) => void;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
  }

  let { query, current, total, onQueryChange, onNext, onPrev, onClose }: Props =
    $props();

  let inputEl: HTMLInputElement | null = $state(null);

  export function focusInput() {
    inputEl?.focus();
    inputEl?.select();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
      return;
    }
    if (e.key === "Escape") {
      // Stop the panel's Esc cascade from also firing on this keydown.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }
</script>

<div
  class="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-lg border border-(--solus-popover-border) bg-(--solus-popover-bg) py-1 pl-2 pr-1 shadow-(--solus-popover-shadow)"
  role="search"
  aria-label="Find in diff"
>
  <MagnifyingGlassIcon
    size={12}
    weight="bold"
    class="text-(--solus-text-tertiary) flex-shrink-0"
  />
  <input
    bind:this={inputEl}
    type="text"
    value={query}
    oninput={(e) => onQueryChange(e.currentTarget.value)}
    onkeydown={handleKeydown}
    placeholder="Find in diff"
    aria-label="Find in diff"
    spellcheck="false"
    autocomplete="off"
    class="w-40 min-w-0 border-0 bg-transparent text-[0.75rem] text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary)"
  />
  <span
    class="min-w-[3.25rem] flex-shrink-0 text-right text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)"
    aria-live="polite"
    aria-atomic="true"
  >
    {#if query.trim().length === 0}
      &nbsp;
    {:else}
      {current}/{total}
    {/if}
  </span>
  <button
    type="button"
    onclick={onPrev}
    disabled={total === 0}
    aria-label="Previous match"
    class="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-(--solus-text-tertiary) transition-[color,background-color] duration-120 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent) disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    use:tooltip={"Previous (⇧↵)"}
  >
    <CaretUpIcon size={12} weight="bold" />
  </button>
  <button
    type="button"
    onclick={onNext}
    disabled={total === 0}
    aria-label="Next match"
    class="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-(--solus-text-tertiary) transition-[color,background-color] duration-120 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent) disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    use:tooltip={"Next (↵)"}
  >
    <CaretDownIcon size={12} weight="bold" />
  </button>
  <button
    type="button"
    onclick={onClose}
    aria-label="Close find"
    class="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-(--solus-text-tertiary) transition-[color,background-color] duration-120 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
    use:tooltip={"Close (Esc)"}
  >
    <XIcon size={12} />
  </button>
</div>
