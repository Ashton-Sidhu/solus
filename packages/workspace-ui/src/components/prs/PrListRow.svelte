<script lang="ts">
  import type { Snippet } from "svelte";
  import ListAvatar from "../ui/list-page/ListAvatar.svelte";
  import ListChip from "../ui/list-page/ListChip.svelte";
  import { checksChip, chipSkin, compactCount } from "../ui/list-page/list-page";
  import LabelChip from "../ui/labels/LabelChip.svelte";
  import { prStatusGlyph, type PrRowSpec } from "./lib/prs-list-view";

  /** One pull request in the wide list, the way a code host draws it: the
   *  lifecycle glyph leading, the title on its own line, and a line of facts
   *  under it — number, repository, author, labels, check outcome — with the
   *  age over the churn at the right edge.
   *
   *  Two lines at every width. The facts line truncates rather than wrapping,
   *  so the row is a fixed 62px and the virtualiser's number is never a guess;
   *  `PR_LIST_ROW_HEIGHT` is this row's height. The list beside an open detail
   *  panel draws `ListRailRow` instead, where there is no room for the facts.
   *
   *  The line itself is the click target. `leading` is a sibling of that
   *  button so the page can hang its review checkbox on the row without
   *  nesting interactive elements inside a button. */
  interface Props {
    row: PrRowSpec;
    selected?: boolean;
    onSelect?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
    leading?: Snippet;
  }
  let { row, selected = false, onSelect, onContextMenu, leading }: Props = $props();

  const glyph = $derived(prStatusGlyph(row.status));
  const checks = $derived(row.checks ? checksChip(row.checks) : null);
  const author = $derived(row.people[0] ?? null);
</script>

{#snippet dot()}
  <span class="shrink-0 opacity-40" aria-hidden="true">·</span>
{/snippet}

<div
  class="group flex h-[62px] w-full items-center rounded-lg pr-3 pl-2.5 transition-shadow duration-150 {selected
    ? 'bg-[var(--wash-2)] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]'
    : 'hover:bg-[var(--wash-1)]'}"
  data-selected={selected}
  oncontextmenu={onContextMenu}
  role="group"
>
  {#if leading}{@render leading()}{/if}

  <button
    type="button"
    class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-3 overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline-none"
    onclick={onSelect}
    data-list-row
  >
    <!-- The state as a shape and a tone, not a word: the same glyph the PR
         detail header uses, so a row and its review agree at a glance. -->
    <span
      class="flex size-5 shrink-0 items-center justify-center"
      style="color: {glyph.color}"
      role="img"
      aria-label={glyph.label}
      title={glyph.label}
    >
      <glyph.icon size={16} />
    </span>

    <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span class="truncate text-sm font-medium text-foreground" title={row.title}>
        {row.title}
      </span>

      <!-- Every fact is `shrink-0`; the line as a whole clips at its end. That
           is the declared order of loss: the check glyph and labels go before
           the number and repository, which are how a row is found. -->
      <span
        class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
      >
        <span class="shrink-0 tabular-nums">{row.ident}</span>
        {@render dot()}
        <span class="shrink-0">{row.repo}</span>
        {#if author}
          {@render dot()}
          <span class="flex shrink-0 items-center gap-1.5">
            <ListAvatar person={author} size={19} />
            <span>{author.name ?? author.id}</span>
          </span>
        {/if}
        {#if row.labels.length > 0}
          {@render dot()}
          {#each row.labels as label (label.name)}
            <LabelChip label={label.name} color={label.color} class="shrink-0 text-xs" />
          {/each}
          {#if row.moreLabels > 0}
            <span class="shrink-0 tabular-nums">+{row.moreLabels}</span>
          {/if}
        {/if}
        {#each row.chips as chip (chip.label)}
          {@render dot()}
          <span class="flex shrink-0 items-center"><ListChip {chip} /></span>
        {/each}
        {#if checks}
          {@render dot()}
          <span
            class="flex shrink-0 items-center"
            style="color: {chipSkin(checks.tint, checks.emphasis).color}"
            role="img"
            aria-label={checks.label}
            title={checks.label}
          >
            <checks.icon size={14} />
          </span>
        {/if}
      </span>
    </span>

    <!-- When, over how much. Both right-aligned so the two columns read as
         columns down the list. -->
    <span class="flex shrink-0 flex-col items-end gap-[3px] text-xs tabular-nums">
      <span class="text-muted-foreground" title={row.timeTitle}>{row.updated}</span>
      {#if row.churn}
        <span class="flex gap-[5px]">
          <span class="text-[color:color-mix(in_oklch,var(--success)_64%,var(--foreground))]"
            >+{compactCount(row.churn.additions)}</span
          >
          <span class="text-[color:color-mix(in_oklch,var(--failure)_66%,var(--foreground))]"
            >−{compactCount(row.churn.deletions)}</span
          >
        </span>
      {/if}
    </span>
  </button>
</div>
