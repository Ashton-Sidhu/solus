<script lang="ts">
  import { MagnifyingGlassIcon, XIcon } from "phosphor-svelte";
  import type { WorkspaceFilter } from "./lib/workspace-items";
  import { clearChip, filterChips, parseToken } from "./lib/workspace-items";
  import { runtime } from "../../contexts";

  /** Search field with token chips. A typed `key:value` becomes a chip on
   *  space; chips and the rail facets are the same filter state, so removing a
   *  chip clears the facet and vice versa. */
  interface Props {
    filter: WorkspaceFilter;
    /** Item count for the placeholder ("Search 418 plans, docs and diagrams…"). */
    totalCount: number;
    /** Match count shown while a query is active; null hides it. */
    matches: number | null;
    ref?: HTMLInputElement | null;
  }

  let { filter, totalCount, matches, ref = $bindable(null) }: Props = $props();

  const chips = $derived(filterChips(filter));

  /** Pull any completed `key:value ` tokens out of the raw text into filter
   *  axes; whatever remains is free text. */
  function absorbTokens(value: string): string {
    let rest = "";
    const words = value.split(/(\s+)/)
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      // Only a word followed by whitespace (or mid-string) is "complete" — the
      // word still being typed at the end stays in the input.
      const isLast = i >= words.length - 1;
      const patch = !isLast && word.trim() ? parseToken(word.trim()) : null;
      if (patch) Object.assign(filter, patch);
      else rest += word;
    }
    return rest.replace(/\s{2,}/g, " ");
  }

  function handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const absorbed = absorbTokens(input.value);
    if (absorbed !== input.value) input.value = absorbed;
    filter.text = absorbed;
  }

  function handleKeydown(e: KeyboardEvent) {
    const input = e.target as HTMLInputElement;
    // Backspace at the caret start deletes the last chip whole.
    if (e.key === "Backspace" && input.selectionStart === 0 && input.selectionEnd === 0 && chips.length > 0) {
      e.preventDefault();
      clearChip(filter, chips[chips.length - 1].key);
      return;
    }
    if (e.key === "Enter" && runtime.isMobileViewport) {
      e.stopPropagation();
      e.preventDefault();
      input.blur();
    }
  }
</script>

<div class="search-shell" class:has-query={!!filter.text || chips.length > 0}>
  <MagnifyingGlassIcon size={15} class="shrink-0 text-(--solus-text-tertiary)" />
  {#each chips as chip (chip.key)}
    <button
      type="button"
      class="search-chip"
      onclick={() => clearChip(filter, chip.key)}
      aria-label={`Remove filter ${chip.token}`}
      title="Remove filter"
    >
      {chip.token}
      <XIcon size={9} weight="bold" />
    </button>
  {/each}
  <input
    bind:this={ref}
    value={filter.text}
    type="text"
    class="search-input"
    placeholder={chips.length > 0
      ? "Filter…"
      : `Search ${totalCount > 0 ? `${totalCount} ` : ""}plans, docs and diagrams…`}
    oninput={handleInput}
    onkeydown={handleKeydown}
  />
  {#if matches !== null}
    <span class="search-matches">{matches} {matches === 1 ? "match" : "matches"}</span>
  {/if}
</div>

<style>
  .search-shell {
    flex: 1 1 auto;
    min-width: 0;
    height: 2.5rem;
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    padding: 0 0.75rem 0 0.875rem;
    border-radius: 0.6875rem;
    background: var(--solus-container-bg);
    border: 0.0625rem solid color-mix(in srgb, var(--solus-container-border) 75%, transparent);
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .search-shell:focus-within {
    border-color: color-mix(in srgb, var(--solus-accent) 45%, transparent);
    box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--solus-accent) 10%, transparent);
  }

  .search-chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.3125rem 0.1875rem 0.4375rem;
    border: none;
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--solus-accent) 13%, transparent);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.7188rem;
    font-weight: 600;
    color: var(--solus-accent);
    cursor: pointer;
  }
  .search-chip:hover {
    background: color-mix(in srgb, var(--solus-accent) 20%, transparent);
  }

  .search-input {
    flex: 1 1 auto;
    min-width: 4rem;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 0.8438rem;
    color: var(--solus-text-primary);
    outline: none;
  }
  .search-input::placeholder {
    color: color-mix(in srgb, var(--solus-text-tertiary) 72%, transparent);
  }
  /* Touch devices zoom the viewport when focusing an input under 16px. */
  @media (pointer: coarse) {
    .search-input {
      font-size: 16px;
    }
  }

  .search-matches {
    flex: 0 0 auto;
    font-size: 0.7188rem;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
  }
</style>
