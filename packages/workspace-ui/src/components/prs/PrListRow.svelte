<script lang="ts">
  import type { Snippet } from "svelte";
  import ListAvatar from "../ui/list-page/ListAvatar.svelte";
  import ListChip from "../ui/list-page/ListChip.svelte";
  import { UserCheck as UserCheckIcon } from "@lucide/svelte";
  import { compactCount } from "../ui/list-page/list-page";
  import LabelChip from "../ui/labels/LabelChip.svelte";
  import PrChecksChip from "./PrChecksChip.svelte";
  import { prStatusGlyph, type PrRowSpec } from "./lib/prs-list-view";
  import {
    PR_ADDITIONS_TONE,
    PR_DELETIONS_TONE,
    PR_VERDICT_TONE,
  } from "./lib/pr-row-styles";
  import { TouchLongPress } from "../../lib/touch-long-press";
  import type { ChangeBreakdownPart } from "@solus/client-core/change-breakdown";
  import type { PrChecksSummary } from "@solus/contracts/checks-types";
  import * as TooltipUI from "../ui/tooltip";
  import { ChangeBreakdown } from "../ui/change-breakdown";

  /** One pull request in the list: the lifecycle glyph, then a
   *  two-by-two grid. The title leads line one and the outcome — verdict,
   *  checks, churn — closes it, so the facts that decide what to do next sit
   *  on the title's own line. Line two is where it lives — number,
   *  repository, author, labels — with the age at its end.
   *
   *  The row has a fixed height in each layout so the virtualiser's number
   *  is never a guess. Beside an open detail panel it gets more vertical room
   *  and sheds facts by its own width — labels, then author, then age.
   *
   *  The line itself is the click target. `leading` and `actions` are
   *  siblings of that button so the page can hang its review checkbox and
   *  its Shift quick actions on the row without nesting interactive elements
   *  inside a button. A touch long-press opens the context menu, which is how
   *  a phone reaches the same actions. */
  interface Props {
    row: PrRowSpec;
    split?: boolean;
    selected?: boolean;
    onSelect?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
    leading?: Snippet;
    /** The row's place in a GitHub stack, and its menu of layers. */
    stack?: Snippet;
    actions?: Snippet;
    /** The churn by kind, for the churn's tooltip. Empty until read. */
    breakdown?: readonly ChangeBreakdownPart[];
    /** The pointer reached the churn: read the split. Rows nobody points at
     *  cost the host nothing. */
    onWantBreakdown?: () => void;
    /** The check runs behind the checks glyph, for its popover. Empty until
     *  read; `headSha` is the row's current head, so an older answer reads
     *  as still checking. */
    checksSummary?: PrChecksSummary;
    checksLoadFailed?: boolean;
    headSha?: string | null;
    /** The checks popover opened: read the check runs. */
    onWantChecks?: () => void;
  }
  let {
    row,
    split = false,
    selected = false,
    onSelect,
    onContextMenu,
    leading,
    stack,
    actions,
    breakdown = [],
    onWantBreakdown,
    checksSummary,
    checksLoadFailed = false,
    headSha = null,
    onWantChecks,
  }: Props = $props();

  const longPress = new TouchLongPress((event) => onContextMenu?.(event));

  const glyph = $derived(prStatusGlyph(row.status));
  const author = $derived(row.people[0] ?? null);
</script>

{#snippet dot()}
  <span class="shrink-0 text-muted-foreground/50" aria-hidden="true">·</span>
{/snippet}

<div
  class="group @container/pr-row flex w-full items-center rounded-lg px-3 transition-colors duration-150 {split ? 'h-[76px]' : 'h-[62px]'} {selected
    ? 'bg-[var(--wash-2)]'
    : 'hover:bg-[var(--wash-1)]'}"
  data-selected={selected}
  oncontextmenu={onContextMenu}
  onpointerdown={(event) => longPress.start(event)}
  onpointerup={() => longPress.cancel()}
  onpointercancel={() => longPress.cancel()}
  onpointermove={() => longPress.cancel()}
  role="group"
>
  {#if leading}{@render leading()}{/if}

  <button
    type="button"
    class="grid h-full min-w-0 flex-1 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline-none"
    onclick={() => {
      if (!longPress.consumeClick()) onSelect?.();
    }}
    data-list-row
  >
    <!-- The state as a shape and a tone, not a word: the same glyph the PR
         detail header uses, so a row and its review agree at a glance. -->
    <span
      class="flex size-4 items-center justify-center {glyph.toneClass}"
      role="img"
      aria-label={glyph.label}
      title={glyph.label}
    >
      <glyph.icon size={16} />
    </span>

    <span class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
      <span class="truncate text-sm font-medium text-foreground" title={row.title}>
        {row.title}
      </span>

      <!-- The outcome, right-aligned so it reads as a column down the list. -->
      <span class="flex shrink-0 items-center justify-end gap-2 text-xs">
        {#each row.chips.filter((chip) => chip.iconOnly) as chip (chip.label)}
          <ListChip {chip} />
        {/each}
        {#if row.verdict === "approved"}
          <span class="flex items-center {PR_VERDICT_TONE.approved}" role="img" aria-label="Approved" title="Approved">
            <UserCheckIcon size={14} />
          </span>
        {:else if row.verdict === "changes-requested"}
          <span class="whitespace-nowrap {PR_VERDICT_TONE['changes-requested']}">Changes requested</span>
        {/if}
        <!-- The checks as a glyph, the way a code host draws them; the check
             runs themselves open from it, read when it is opened. -->
        {#if row.checks && row.checks.state !== "none"}
          <PrChecksChip
            variant="glyph"
            rowChecks={row.checks}
            summary={checksSummary}
            loadFailed={checksLoadFailed}
            {headSha}
            onOpen={onWantChecks}
          />
        {/if}
        {#if row.churn}
          {@const churn = row.churn}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <span
                  {...tooltipProps}
                  class="flex gap-1 text-[11px] whitespace-nowrap tabular-nums"
                  onpointerenter={() => onWantBreakdown?.()}
                >
                  <span class={PR_ADDITIONS_TONE}>+{compactCount(churn.additions)}</span>
                  <span class={PR_DELETIONS_TONE}>−{compactCount(churn.deletions)}</span>
                </span>
              {/snippet}
            </TooltipUI.Trigger>
            {#if breakdown.length > 0}
              <TooltipUI.Content side="bottom">
                <ChangeBreakdown parts={breakdown} total={churn} />
              </TooltipUI.Content>
            {/if}
          </TooltipUI.Root>
        {/if}
      </span>

      <!-- Where it lives. Every fact is `shrink-0` and the line clips at its
           end: labels go before the number and repository, which are how a
           row is found. -->
      <span
        class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
      >
        <span class="shrink-0 tabular-nums">{row.ident}</span>
        {@render dot()}
        <!-- Across every project the project's own name says where the row
             lives; the repository stays one hover away. -->
        <span class="shrink-0" title={row.repo}>{row.project ?? row.repo}</span>
        {#if author}
          {@render dot()}
          <span class="flex shrink-0 items-center gap-1.5">
            <ListAvatar person={author} size={19} />
            <span class="hidden @min-[26rem]/pr-row:inline">{author.name ?? author.id}</span>
          </span>
        {/if}
        {#each row.chips.filter((chip) => !chip.iconOnly) as chip (chip.label)}
          {@render dot()}
          <span class="flex shrink-0 items-center"><ListChip {chip} /></span>
        {/each}
        {#if row.labels.length > 0}
          <span class="hidden shrink-0 items-center gap-1 @min-[32rem]/pr-row:flex">
            {@render dot()}
            {#each row.labels as label (label.name)}
              <LabelChip label={label.name} color={label.color} class="h-4 shrink-0 px-1.5 text-[10px] leading-4" />
            {/each}
            {#if row.moreLabels > 0}
              <span class="shrink-0 text-[10px] tabular-nums">+{row.moreLabels}</span>
            {/if}
          </span>
        {/if}
      </span>

      <span
        class="hidden justify-self-end text-[11px] whitespace-nowrap text-muted-foreground tabular-nums @min-[22rem]/pr-row:inline"
        title={row.timeTitle}
      >
        {row.updated}
      </span>
    </span>
  </button>

  {#if stack}{@render stack()}{/if}
  {#if actions}{@render actions()}{/if}
</div>
