<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { tick } from "svelte";
  import {
    MagnifyingGlassIcon,
    CaretRightIcon,
    CaretUpIcon,
    CaretDownIcon,
    XIcon,
    TextAaIcon,
  } from "phosphor-svelte";
  import { getSearchState } from "./searchExtension";
  import { Input } from "../ui/input";

  interface Props {
    editor: Editor;
    scrollContainer?: HTMLDivElement | null;
    onClose: () => void;
  }

  let { editor, scrollContainer = null, onClose }: Props = $props();

  let query = $state("");
  let replacement = $state("");
  let caseSensitive = $state(false);
  let showReplace = $state(false);
  let matchCount = $state(0);
  let currentMatch = $state(0);
  let findInputEl = $state<HTMLInputElement | null>(null);

  function refresh() {
    const s = getSearchState(editor.state);
    matchCount = s?.results.length ?? 0;
    currentMatch = matchCount > 0 ? (s?.currentIndex ?? 0) + 1 : 0;
  }

  function scrollToCurrent() {
    const s = getSearchState(editor.state);
    if (!s || s.results.length === 0) return;
    const m = s.results[s.currentIndex];
    editor.chain().setTextSelection({ from: m.from, to: m.to }).run();

    if (!scrollContainer) {
      editor.commands.scrollIntoView();
      return;
    }

    const coords = editor.view.coordsAtPos(m.from);
    const containerRect = scrollContainer.getBoundingClientRect();
    const toolbarOffset = 64;
    const targetTop = coords.top - containerRect.top - toolbarOffset;
    const targetBottom = coords.bottom - containerRect.bottom + 24;

    if (targetTop < 0) {
      scrollContainer.scrollBy({ top: targetTop, behavior: "smooth" });
    } else if (targetBottom > 0) {
      scrollContainer.scrollBy({ top: targetBottom, behavior: "smooth" });
    }
  }

  function runSearch() {
    editor.commands.setSearchTerm(query);
    scrollToCurrent();
    refresh();
  }

  function next() {
    editor.commands.findNextMatch();
    scrollToCurrent();
    findInputEl?.focus({ preventScroll: true });
    refresh();
  }
  function prev() {
    editor.commands.findPrevMatch();
    scrollToCurrent();
    findInputEl?.focus({ preventScroll: true });
    refresh();
  }
  function replaceOne() {
    editor.commands.replaceCurrentMatch();
    refresh();
  }
  function replaceAll() {
    editor.commands.replaceAllMatches();
    refresh();
  }
  function toggleCase() {
    caseSensitive = !caseSensitive;
    editor.commands.setSearchCaseSensitive(caseSensitive);
    scrollToCurrent();
    refresh();
  }

  function handleFindKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? prev() : next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function handleReplaceKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceOne();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function close() {
    editor.commands.clearSearch();
    onClose();
    editor.commands.focus();
  }

  // Seed from the current selection and focus on open. Re-run search whenever
  // the live document changes under us so the counter stays honest.
  $effect(() => {
    const sel = editor.state.selection;
    if (!sel.empty) {
      const text = editor.state.doc.textBetween(sel.from, sel.to, " ");
      if (text && !text.includes("\n")) query = text;
    }
    void tick().then(() => {
      findInputEl?.focus();
      findInputEl?.select();
      if (query) runSearch();
    });

    const onTx = () => refresh();
    editor.on("transaction", onTx);
    return () => {
      editor.off("transaction", onTx);
      // Clear highlights on any close path (button, Esc keybinding, unmount).
      editor.commands.clearSearch();
    };
  });
</script>

<div class="doc-find-bar" data-solus-ui role="search">
  <div class="doc-find-bar__row">
    <button
      type="button"
      class="doc-find-bar__btn doc-find-bar__replace-toggle"
      class:doc-find-bar__btn--active={showReplace}
      onclick={() => (showReplace = !showReplace)}
      title="Toggle replace"
      aria-label="Toggle replace"
      aria-pressed={showReplace}
    >
      <span class="doc-find-bar__chev" class:doc-find-bar__chev--open={showReplace}>
        <CaretRightIcon size={12} />
      </span>
    </button>
    <span class="doc-find-bar__icon"><MagnifyingGlassIcon size={13} /></span>
    <Input
      bind:ref={findInputEl}
      bind:value={query}
      oninput={runSearch}
      onkeydown={handleFindKeydown}
      class="doc-find-bar__input"
      type="text"
      placeholder="Find"
      aria-label="Find"
    />
    <span class="doc-find-bar__count" aria-live="polite">
      {matchCount > 0 ? `${currentMatch}/${matchCount}` : query ? "0/0" : ""}
    </span>
    <button
      type="button"
      class="doc-find-bar__btn"
      class:doc-find-bar__btn--active={caseSensitive}
      onclick={toggleCase}
      title="Match case"
      aria-label="Match case"
      aria-pressed={caseSensitive}
    >
      <TextAaIcon size={13} />
    </button>
    <button
      type="button"
      class="doc-find-bar__btn"
      onclick={prev}
      disabled={matchCount === 0}
      title="Previous match (⇧⏎)"
      aria-label="Previous match"
    >
      <CaretUpIcon size={13} />
    </button>
    <button
      type="button"
      class="doc-find-bar__btn"
      onclick={next}
      disabled={matchCount === 0}
      title="Next match (⏎)"
      aria-label="Next match"
    >
      <CaretDownIcon size={13} />
    </button>
    <button
      type="button"
      class="doc-find-bar__btn"
      onclick={close}
      title="Close (Esc)"
      aria-label="Close find"
    >
      <XIcon size={13} />
    </button>
  </div>

  {#if showReplace}
    <div class="doc-find-bar__row">
      <span class="doc-find-bar__replace-spacer"></span>
      <span class="doc-find-bar__icon"></span>
      <Input
        bind:value={replacement}
        oninput={() => editor.commands.setReplaceTerm(replacement)}
        onkeydown={handleReplaceKeydown}
        class="doc-find-bar__input"
        type="text"
        placeholder="Replace"
        aria-label="Replace with"
      />
      <button
        type="button"
        class="doc-find-bar__text-btn"
        onclick={replaceOne}
        disabled={matchCount === 0}
      >
        Replace
      </button>
      <button
        type="button"
        class="doc-find-bar__text-btn"
        onclick={replaceAll}
        disabled={matchCount === 0}
      >
        All
      </button>
    </div>
  {/if}
</div>

<style>
  .doc-find-bar {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.375rem;
    border-radius: 0.625rem;
    border: 0.0625rem solid var(--solus-popover-border);
    background: var(--solus-popover-bg);
    box-shadow: var(--solus-popover-shadow);
    backdrop-filter: blur(1.25rem) saturate(1.1);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.1);
    min-width: 19rem;
  }
  .doc-find-bar__row {
    display: flex;
    align-items: center;
    gap: 0.1875rem;
  }
  .doc-find-bar__icon {
    display: inline-flex;
    width: 1.125rem;
    justify-content: center;
    color: var(--solus-text-tertiary);
    flex-shrink: 0;
  }
  :global(.doc-find-bar__input) {
    flex: 1;
    min-width: 0;
    height: 1.625rem;
    border: 0;
    border-radius: 0.375rem;
    background: var(--solus-surface-hover);
    padding: 0 0.5rem;
    color: var(--solus-text-primary);
    font-size: 0.75rem;
    outline: none;
  }
  :global(.doc-find-bar__input:focus) {
    outline: 0.0625rem solid var(--solus-accent-border);
  }
  .doc-find-bar__count {
    flex-shrink: 0;
    min-width: 2.25rem;
    text-align: right;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--solus-text-tertiary);
    padding-inline: 0.25rem;
  }
  .doc-find-bar__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .doc-find-bar__btn:hover:not(:disabled) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .doc-find-bar__btn--active {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }
  .doc-find-bar__btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .doc-find-bar__btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .doc-find-bar__replace-toggle {
    margin-right: -0.0625rem;
  }
  .doc-find-bar__replace-spacer {
    width: 1.5rem;
    flex-shrink: 0;
    margin-right: -0.0625rem;
  }
  .doc-find-bar__chev {
    display: inline-flex;
    transition: transform var(--duration-quick) var(--ease-premium);
  }
  .doc-find-bar__chev--open {
    transform: rotate(90deg);
  }
  .doc-find-bar__text-btn {
    flex-shrink: 0;
    height: 1.625rem;
    padding: 0 0.5rem;
    border: 0;
    border-radius: 0.375rem;
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
    font-size: 0.6875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .doc-find-bar__text-btn:hover:not(:disabled) {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }
  .doc-find-bar__text-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  @media (prefers-reduced-motion: reduce) {
    .doc-find-bar__btn,
    .doc-find-bar__chev,
    .doc-find-bar__text-btn {
      transition: none !important;
    }
  }
</style>
