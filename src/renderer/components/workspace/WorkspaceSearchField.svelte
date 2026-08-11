<script lang="ts">
  import { MagnifyingGlassIcon, XIcon } from "phosphor-svelte";
  import type { WorkspaceFilter } from "./lib/workspace-items";
  import { clearChip, filterChips, parseToken } from "./lib/workspace-items";
  import { runtime } from "../../contexts";

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

<!-- The field takes the focus ring every other Solus field takes: 45% primary,
     no glow, no offset. -->
<div
  class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg px-[9px] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] focus-within:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
>
  <MagnifyingGlassIcon size={12} class="shrink-0 text-muted-foreground opacity-70" />

  {#each chips as chip (chip.key)}
    <button
      type="button"
      class="flex h-[19px] shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] pr-[5px] pl-[7px] font-mono text-[11px] font-medium text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))] transition-colors duration-150 hover:bg-[color-mix(in_oklch,var(--primary)_20%,transparent)]"
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
    class="w-full min-w-16 border-0 bg-transparent text-[13px] caret-[var(--primary)] outline-none placeholder:text-muted-foreground [@media(pointer:coarse)]:text-base"
    placeholder={chips.length > 0
      ? "Filter…"
      : `Search ${totalCount > 0 ? `${totalCount} ` : ""}artifacts in ${scopeLabel}…`}
    aria-label="Search artifacts"
    oninput={handleInput}
    onkeydown={handleKeydown}
  />

  {#if matches !== null}
    <span class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground opacity-75">
      {matches} {matches === 1 ? "match" : "matches"}
    </span>
  {:else}
    <span
      class="shrink-0 rounded-md bg-[var(--wash-2)] px-[7px] py-[3px] font-mono text-[11px] text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent),inset_0_-1px_0_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
      aria-hidden="true">/</span
    >
  {/if}
</div>
