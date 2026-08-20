<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import {
    ChevronDown as CaretDownIcon,
    ChevronRight as CaretRightIcon,
    ChevronUp as CaretUpIcon,
    Search as MagnifyingGlassIcon,
    CaseSensitive as TextAaIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { Input } from "../input";

  interface Props {
    query: string;
    current: number;
    total: number;
    onQueryChange: (value: string) => void;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
    placeholder?: string;
    ariaLabel?: string;
    debounceMs?: number;
    /** Queries shorter than this are not searched by the host, so the counter
     *  stays hidden instead of claiming "0/0" for text the content contains. */
    minQueryLength?: number;
    caseSensitive?: boolean;
    onCaseSensitiveChange?: (value: boolean) => void;
    replacement?: string;
    onReplacementChange?: (value: string) => void;
    onReplace?: () => void;
    onReplaceAll?: () => void;
  }

  let {
    query,
    current,
    total,
    onQueryChange,
    onNext,
    onPrev,
    onClose,
    placeholder = "Find",
    ariaLabel = "Find",
    debounceMs = 0,
    minQueryLength = 1,
    caseSensitive = false,
    onCaseSensitiveChange,
    replacement = "",
    onReplacementChange,
    onReplace,
    onReplaceAll,
  }: Props = $props();

  const canReplace = $derived(
    !!onReplacementChange && !!onReplace && !!onReplaceAll,
  );
  let showReplace = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);
  let draftValue = $state(untrack(() => query));
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

  function commit(): boolean {
    if (commitTimer !== null) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (draftValue === query) return false;
    onQueryChange(draftValue);
    return true;
  }

  function handleInput(value: string) {
    draftValue = value;
    if (commitTimer !== null) clearTimeout(commitTimer);
    if (debounceMs <= 0) {
      commit();
      return;
    }
    commitTimer = setTimeout(commit, debounceMs);
  }

  function handleFindKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (commit()) return;
      if (event.shiftKey) onPrev();
      else onNext();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  function handleReplaceKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      onReplace?.();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  function navigate(direction: 1 | -1) {
    if (commit()) return;
    if (direction === 1) onNext();
    else onPrev();
  }

  export async function focusInput(select = true) {
    await tick();
    inputEl?.focus({ preventScroll: true });
    if (select) inputEl?.select();
  }

  onDestroy(() => {
    if (commitTimer !== null) clearTimeout(commitTimer);
  });
</script>

<div
  class="find-bar"
  class:find-bar--replace={canReplace}
  data-solus-ui
  role="search"
  aria-label={ariaLabel}
>
  <div class="find-bar__row">
    {#if canReplace}
      <button
        type="button"
        class="find-bar__btn find-bar__replace-toggle"
        class:find-bar__btn--active={showReplace}
        onclick={() => (showReplace = !showReplace)}
        title="Toggle replace"
        aria-label="Toggle replace"
        aria-pressed={showReplace}
      >
        <span class="find-bar__chev" class:find-bar__chev--open={showReplace}>
          <CaretRightIcon size={12} />
        </span>
      </button>
    {/if}
    <span class="find-bar__icon"><MagnifyingGlassIcon size={13} /></span>
    <Input
      bind:ref={inputEl}
      type="text"
      value={draftValue}
      oninput={(event) => handleInput(event.currentTarget.value)}
      onkeydown={handleFindKeydown}
      {placeholder}
      aria-label={ariaLabel}
      spellcheck="false"
      autocomplete="off"
      class="find-bar__input"
    />
    <span class="find-bar__count" aria-live="polite" aria-atomic="true">
      {query.trim().length >= minQueryLength ? `${current}/${total}` : ""}
    </span>
    {#if onCaseSensitiveChange}
      <button
        type="button"
        class="find-bar__btn"
        class:find-bar__btn--active={caseSensitive}
        onclick={() => onCaseSensitiveChange?.(!caseSensitive)}
        title="Match case"
        aria-label="Match case"
        aria-pressed={caseSensitive}
      >
        <TextAaIcon size={13} />
      </button>
    {/if}
    <button
      type="button"
      class="find-bar__btn"
      onclick={() => navigate(-1)}
      disabled={total === 0}
      title="Previous match (⇧⏎)"
      aria-label="Previous match"
    >
      <CaretUpIcon size={13} />
    </button>
    <button
      type="button"
      class="find-bar__btn"
      onclick={() => navigate(1)}
      disabled={total === 0}
      title="Next match (⏎)"
      aria-label="Next match"
    >
      <CaretDownIcon size={13} />
    </button>
    <button
      type="button"
      class="find-bar__btn"
      onclick={onClose}
      title="Close (Esc)"
      aria-label="Close find"
    >
      <XIcon size={13} />
    </button>
  </div>

  {#if canReplace && showReplace}
    <div class="find-bar__row">
      <span class="find-bar__replace-spacer"></span>
      <span class="find-bar__icon"></span>
      <Input
        value={replacement}
        oninput={(event) => onReplacementChange?.(event.currentTarget.value)}
        onkeydown={handleReplaceKeydown}
        class="find-bar__input"
        type="text"
        placeholder="Replace"
        aria-label="Replace with"
      />
      <button
        type="button"
        class="find-bar__text-btn"
        onclick={onReplace}
        disabled={total === 0}
      >
        Replace
      </button>
      <button
        type="button"
        class="find-bar__text-btn"
        onclick={onReplaceAll}
        disabled={total === 0}
      >
        All
      </button>
    </div>
  {/if}
</div>

<style>
  .find-bar {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: min(22rem, calc(100vw - 1.5rem));
    padding: 0.375rem;
    border: 0.0625rem solid var(--solus-popover-border);
    border-radius: 1rem;
    background: var(--solus-popover-bg);
    box-shadow: var(--solus-popover-shadow);
    backdrop-filter: blur(1.25rem) saturate(1.1);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.1);
  }
  .find-bar--replace {
    min-width: 19rem;
  }
  .find-bar__row {
    display: flex;
    align-items: center;
    gap: 0.1875rem;
  }
  .find-bar__icon {
    display: inline-flex;
    width: 1.125rem;
    flex-shrink: 0;
    justify-content: center;
    color: var(--solus-text-tertiary);
  }
  :global(.find-bar__input) {
    min-width: 0;
    height: 1.625rem;
    flex: 1;
    border: 0;
    border-radius: 0.375rem;
    background: var(--solus-surface-hover);
    padding: 0 0.5rem;
    color: var(--solus-text-primary);
    font-size: var(--text-xs);
    outline: none;
    box-shadow: none;
  }
  :global(.find-bar__input:focus) {
    outline: 0.0625rem solid var(--solus-accent-border);
  }
  .find-bar__count {
    min-width: 3.25rem;
    flex-shrink: 0;
    padding-inline: 0.25rem;
    text-align: right;
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .find-bar__btn {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      scale var(--duration-quick) var(--ease-premium),
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .find-bar__btn:hover:not(:disabled) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .find-bar__btn:active:not(:disabled),
  .find-bar__text-btn:active:not(:disabled) {
    scale: 0.96;
  }
  .find-bar__btn--active {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }
  .find-bar__btn:disabled,
  .find-bar__text-btn:disabled {
    cursor: default;
    opacity: 0.4;
  }
  .find-bar__btn:focus-visible,
  .find-bar__text-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .find-bar__replace-toggle {
    margin-right: -0.0625rem;
  }
  .find-bar__replace-spacer {
    width: 1.5rem;
    flex-shrink: 0;
    margin-right: -0.0625rem;
  }
  .find-bar__chev {
    display: inline-flex;
    transition: transform var(--duration-quick) var(--ease-premium);
  }
  .find-bar__chev--open {
    transform: rotate(90deg);
  }
  .find-bar__text-btn {
    height: 1.625rem;
    flex-shrink: 0;
    border: 0;
    border-radius: 0.375rem;
    background: var(--solus-surface-hover);
    padding: 0 0.5rem;
    color: var(--solus-text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition:
      scale var(--duration-quick) var(--ease-premium),
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .find-bar__text-btn:hover:not(:disabled) {
    color: var(--solus-accent);
  }

  @media (prefers-reduced-motion: reduce) {
    .find-bar__btn,
    .find-bar__chev,
    .find-bar__text-btn {
      transition: none;
    }
  }
</style>
