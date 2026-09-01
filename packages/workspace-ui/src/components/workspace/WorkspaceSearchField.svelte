<script lang="ts">
  import { Search as MagnifyingGlassIcon, X as XIcon } from "@lucide/svelte";
  import type { WorkspaceFilter } from "./lib/workspace-items";
  import { clearChip, filterChips, parseToken } from "./lib/workspace-items";
  import { runtime } from "../../contexts";
  import {
    FILTER_SEARCH_FIELD,
    FILTER_SEARCH_ICON,
    FILTER_SEARCH_INPUT,
    FILTER_SEARCH_KEYCAP,
  } from "../ui/list-page/filter-styles";

  /** Search field with token chips. A typed `key:value` becomes a chip on
   *  space; backspace at the caret deletes the chip whole. Chips and the filter
   *  row's facets are the same filter state, so removing a chip clears the facet
   *  and selecting a facet writes the chip. */
  interface Props {
    filter: WorkspaceFilter;
    /** Item count for the placeholder ("Search 418 artifacts in solus…"). */
    totalCount: number;
    /** The scope the placeholder names. */
    scopeLabel: string;
    /** Match count shown while a query is active; null hides it. */
    matches: number | null;
    ref?: HTMLInputElement | null;
  }

  let { filter, totalCount, scopeLabel, matches, ref = $bindable(null) }: Props = $props();

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
    if (!(e.target instanceof HTMLInputElement)) return;
    const input = e.target;
    const absorbed = absorbTokens(input.value);
    if (absorbed !== input.value) input.value = absorbed;
    filter.text = absorbed;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!(e.target instanceof HTMLInputElement)) return;
    const input = e.target;
    // Backspace at the caret start deletes the last chip whole.
    if (e.key === "Backspace" && input.selectionStart === 0 && input.selectionEnd === 0 && chips.length > 0) {
      e.preventDefault();
      clearChip(filter, chips[chips.length - 1].key);
      return;
    }
    // A soft keyboard's Return is the only way to dismiss it, so it must not
    // also reach the page behind. A hardware Enter should behave normally, in
    // any size of window.
    if (e.key === "Enter" && runtime.isTouchDevice && !runtime.hasKeyboardPointer) {
      e.stopPropagation();
      e.preventDefault();
      input.blur();
    }
  }
</script>

<!-- The same field the list pages draw, so the four page-level bands read as one
     control: the focus ring every other Solus field takes, and at the record
     rung a 44px card with a 16px field — under 16px iOS zooms in on focus and
     does not zoom back out. The laptop rung is this page's own, because its
     chips beside it keep it too. -->
<div class="{FILTER_SEARCH_FIELD} [.is-laptop-display_&]:h-6.5">
  <MagnifyingGlassIcon size={12} class={FILTER_SEARCH_ICON} />

  {#each chips as chip (chip.key)}
    <!-- The token rides inside the field, so it keeps the small rung the field
         gives up at the record: only the input has to reach 16px, and a 16px
         token would not fit the box it sits in. -->
    <button
      type="button"
      class="flex h-[19px] shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] pr-[5px] pl-[7px] font-medium text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))] transition-colors duration-150 hover:bg-[color-mix(in_oklch,var(--primary)_20%,transparent)] @max-[30rem]/pane:h-6 @max-[30rem]/pane:text-xs"
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
    class="{FILTER_SEARCH_INPUT} min-w-16"
    placeholder={chips.length > 0
      ? "Filter…"
      : `Search ${totalCount > 0 ? `${totalCount} ` : ""}artifacts in ${scopeLabel}…`}
    aria-label="Search artifacts"
    oninput={handleInput}
    onkeydown={handleKeydown}
  />

  {#if matches !== null}
    <span class="shrink-0 tabular-nums text-muted-foreground opacity-75">
      {matches} {matches === 1 ? "match" : "matches"}
    </span>
  {:else}
    <!-- The keycap names the key that focuses this field, so it is absent on a
         record, where there is no keyboard for it to describe. -->
    <span class={FILTER_SEARCH_KEYCAP} aria-hidden="true">/</span>
  {/if}
</div>
