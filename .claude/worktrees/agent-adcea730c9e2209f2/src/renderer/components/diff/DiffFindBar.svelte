<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { CaretDownIcon, CaretUpIcon, MagnifyingGlassIcon, XIcon } from "phosphor-svelte";
  import { tooltip } from "../../lib/tooltip";
  import { Input } from "../ui/input";

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

  // Debounce committing the query upstream: every keystroke otherwise re-walks
  // the entire diff (findMatches) and scrolls to the first hit. The local draft
  // keeps typing responsive while the committed query — and its scan — trails
  // ~120ms behind. Enter commits immediately so navigation uses the typed query;
  // Escape/close unmounts this bar, and onDestroy cancels any pending commit so a
  // stale query can't land after the find bar is gone.
  const COMMIT_DEBOUNCE_MS = 120;
  let draftValue = $state(untrack(() => query));
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

  function commit() {
    if (commitTimer !== null) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (draftValue !== query) onQueryChange(draftValue);
  }

  function handleInput(value: string) {
    draftValue = value;
    if (commitTimer !== null) clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, COMMIT_DEBOUNCE_MS);
  }

  onDestroy(() => {
    if (commitTimer !== null) clearTimeout(commitTimer);
  });

  export function focusInput() {
    inputEl?.focus();
    inputEl?.select();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
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
  <Input
    bind:ref={inputEl}
    type="text"
    value={draftValue}
    oninput={(e) => handleInput(e.currentTarget.value)}
    onkeydown={handleKeydown}
    placeholder="Find in diff"
    aria-label="Find in diff"
    spellcheck="false"
    autocomplete="off"
    class="h-auto w-40 min-w-0 rounded-none border-0 bg-transparent p-0 text-[0.75rem] text-(--solus-text-primary) shadow-none placeholder:text-(--solus-text-tertiary) focus-visible:ring-0 dark:bg-transparent"
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
