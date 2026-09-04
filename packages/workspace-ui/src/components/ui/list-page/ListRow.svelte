<script lang="ts">
  import type { Snippet } from "svelte";
  import ListAvatar from "./ListAvatar.svelte";
  import ListChip from "./ListChip.svelte";
  import SourceLogo from "./SourceLogo.svelte";
  import {
    checksChip,
    compactCount,
    participantsAfterLead,
    type ListRowSpec,
  } from "./list-page";

  /** One line of the global list. Seven slots in a fixed order — who · what
   *  number · what it is · what kind · how big · who else · when — with both
   *  ends fixed-width and the title the only elastic element, so scanning a
   *  column means scanning one thing.
   *
   *  The line itself is the click target. `leading`/`trailing` are siblings of
   *  that button rather than children, so a page can hang its own controls (a
   *  review checkbox, a stack affordance) on the row without nesting
   *  interactive elements inside a button.
   *
   *  ── The record rung (`@max-[30rem]/pane`) ──
   *  Below 30rem the eight slots cannot share a line without the title — the one
   *  thing the row is read for — giving up most of its width to fixed cells. So
   *  the same eight slots wrap into three lines and the title takes one of its
   *  own, where it wraps instead of truncating:
   *
   *    line 1   source · id · chips ······· people · age
   *    line 2   title, full width, never clipped
   *    line 3   branch · checks ··········· churn
   *
   *  This is one row reflowing, not a second row component: every slot keeps its
   *  meaning, its tint and its data, so a phone and a 1440px window never
   *  disagree about what a row says. `order` places each slot; `basis-full` on
   *  the title is what forces the two line breaks, so the lines are declared
   *  rather than arbitrated by how wide the chips happen to be.
   *
   *  It is keyed to the pane, not the window: a companion pane dragged to its
   *  floor on a desktop is the same 393px problem, and gets the same answer.
 *
 *  The record is also a *card*, which the single line is not. On a wide pane a
 *  row is one line and the eye finds its edges for free; three lines stacked on
 *  the page background have no edge at all, and two adjacent records read as
 *  one six-line block. So the record takes the surface every other phone record
 *  in the redesign takes — `--card`, `--radius-xl`, `--elev-ring` — and the
 *  gutter between cards is the slack in `LIST_RECORD_ROW_HEIGHT`. That is why
 *  the card's height is stated here rather than left to its content: the
 *  virtualiser is told a slot height before layout, and a card measuring its
 *  own text would be a different height on every row. 114px is the two-line
 *  ceiling that constant counts out; the two move together or not at all. */
  interface Props {
    row: ListRowSpec;
    /** The identifier column's floor — 62px fits `SOL-412`, 44px fits `#418`.
     *  Fixed per page, never per row. It is a floor rather than a hard width so
     *  a longer reference (a provider ticket key) pushes the title along instead
     *  of spilling out of a cell that cannot hold it. */
    identWidth?: number;
    selected?: boolean;
    /** What occupies the lead-avatar slot when this row has no person. */
    fallbackAvatar?: "solus";
    /** Use the canonical responsive type rung for workspace list titles. */
    responsiveTitle?: boolean;
    onSelect?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
    leading?: Snippet;
    trailing?: Snippet;
  }
  let {
    row,
    identWidth = 62,
    selected = false,
    fallbackAvatar,
    responsiveTitle = false,
    onSelect,
    onContextMenu,
    leading,
    trailing,
  }: Props = $props();

  const participants = $derived(participantsAfterLead(row.people));
  const lead = $derived(
    row.people[0] ??
      (fallbackAvatar === "solus"
        ? { id: "solus", initials: "S", name: "Solus", fallback: "solus" as const }
        : null),
  );
</script>

<div
  class="text-xs group flex h-11 w-full items-center rounded-lg pr-3 pl-2.5 transition-shadow duration-150 @max-[30rem]/pane:h-[114px] @max-[30rem]/pane:items-start @max-[30rem]/pane:rounded-xl @max-[30rem]/pane:overflow-hidden @max-[30rem]/pane:px-[13px] @max-[30rem]/pane:py-3 {selected
    ? 'bg-[var(--wash-2)] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]'
    : 'hover:bg-[var(--wash-1)] @max-[30rem]/pane:bg-card @max-[30rem]/pane:shadow-[shadow:var(--elev-ring)]'}"
  data-selected={selected}
  oncontextmenu={onContextMenu}
  role="group"
>
  {#if leading}{@render leading()}{/if}

  <button
    type="button"
    class="flex h-full min-w-0 flex-1 overflow-hidden cursor-pointer items-center gap-[11px] border-0 bg-transparent p-0 text-left focus-visible:outline-none @max-[30rem]/pane:h-auto @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:gap-x-2 @max-[30rem]/pane:gap-y-2"
    onclick={onSelect}
    data-list-row
  >
    <!-- Slot 1 — the cell holds its 20px even with nobody in it, so every
         identifier below stays on the same x. On the record it joins the other
         people at the right end of line 1, where the age reads after it. -->
    <span class="flex size-5 shrink-0 items-center justify-center @max-[30rem]/pane:order-5">
      {#if lead}<ListAvatar person={lead} />{/if}
    </span>

    <!-- Slot 2a — provider mark. A fixed 15px cell so the id column stays on the
         same x whether the mark is a badge or the local dot. Pages that don't
         set a source (PRs) never render it, keeping their layout unchanged. -->
    {#if row.source}
      <span class="-mr-1 flex w-[15px] shrink-0 items-center justify-center @max-[30rem]/pane:order-1">
        <SourceLogo source={row.source.id} title={row.source.title} />
      </span>
    {/if}

    <!-- Slot 2 — on the record the id leads line 1, so it gives up the fixed
         floor that was keeping a column aligned there is no longer a column. -->
    <span
      class="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground opacity-80 @max-[30rem]/pane:order-2 @max-[30rem]/pane:min-w-0! @max-[30rem]/pane:font-mono"
      style="min-width: {identWidth}px"
    >
      {row.ident}
    </span>

    <!-- Slot 3 — the only full-strength text in the row. `min-w-0` is what lets
         it lend width to the reveal instead of pushing the row wide. On the
         record it stops lending and starts wrapping: `basis-full` gives it the
         whole of line 2, where it takes a second line rather than ending in a
         dot after forty characters.

         Two lines, not unlimited. The row lives in a virtualiser, which is told
         a height before the browser has laid the title out; an unbounded title
         made that number a guess, and a three-line title painted straight over
         the row beneath. `LIST_RECORD_ROW_HEIGHT` is this clamp counted out, so
         the two move together or not at all. -->
    <span
      class="max-w-[520px] min-w-0 truncate font-normal @max-[30rem]/pane:order-8 @max-[30rem]/pane:line-clamp-2 @max-[30rem]/pane:max-w-none @max-[30rem]/pane:basis-full @max-[30rem]/pane:text-sm @max-[30rem]/pane:leading-[1.35] @max-[30rem]/pane:font-medium @max-[30rem]/pane:whitespace-normal @max-[30rem]/pane:text-pretty {responsiveTitle
        ? 'text-workspace-chrome'
        : ''}"
      title={row.title}
    >
      {row.title}
    </span>

    <!-- Slot 4 -->
    {#each row.chips as chip (chip.label)}
      <span class="flex shrink-0 items-center @max-[30rem]/pane:order-3"><ListChip {chip} /></span>
    {/each}

    <!-- Everything after this is right-anchored. On the record this is line 1's
         gap, and a second one below carries line 3's. -->
    <span class="flex-1 @max-[30rem]/pane:order-4"></span>

    <!-- Slot 4, reveal form — the branch on a PR row. Zero *width* at rest, not zero opacity, so the rows
         you are not on stay full width; it opens under the pointer, under
         keyboard focus, and for as long as the row stays selected. A coarse
         pointer has no hover to give, so it is simply always open and shorter.
         The middle band is where it is suppressed — wide enough that the title
         is still sharing its line, narrow enough that it has no slack to lend.
         Stated as one range rather than two rules, so nothing depends on which
         of them the compiled sheet happens to emit last. Below the record rung
         it comes back as a mono chip on line 3, where the title is no longer
         paying for it. -->
    {#if row.reveal}
      <span
        class="flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-muted-foreground transition-[max-width,opacity] duration-150 ease-out group-hover:max-w-[340px] group-hover:opacity-60 group-focus-within:max-w-[340px] group-focus-within:opacity-60 @min-[30rem]/pane:@max-[45rem]/pane:hidden motion-reduce:transition-none pointer-coarse:max-w-[150px] pointer-coarse:opacity-60 @max-[30rem]/pane:order-9 @max-[30rem]/pane:max-w-full @max-[30rem]/pane:rounded-md @max-[30rem]/pane:bg-[var(--wash-1)] @max-[30rem]/pane:px-2 @max-[30rem]/pane:py-[3px] @max-[30rem]/pane:font-mono @max-[30rem]/pane:opacity-100 @max-[30rem]/pane:shadow-[shadow:var(--elev-ring)] {selected
          ? 'max-w-[340px] opacity-60'
          : 'max-w-0 opacity-0'}"
        title={row.reveal.title ?? row.reveal.label}
      >
        {#if row.reveal.lead}
          <span>{row.reveal.lead}</span>
          {#if row.reveal.label}
            <span class="opacity-40" aria-hidden="true">·</span>
          {/if}
        {/if}
        {row.reveal.label}
      </span>
    {/if}

    <!-- Slot 5 — the check state in words, tinted by outcome. `none` holds the
         width in silence so a result landing later does not shift the row. -->
    {#if row.checks}
      {@const chip = checksChip(row.checks)}
      {#if chip}
        <span class="flex shrink-0 items-center @max-[30rem]/pane:order-10">
          <ListChip {chip} />
        </span>
      {:else}
        <span class="flex w-4 shrink-0 items-center justify-center @max-[30rem]/pane:order-10"></span>
      {/if}
    {/if}

    <!-- Line 3's gap, so churn stays at the right edge under the title rather
         than trailing the branch chip. Absent from the single line, where the
         one spacer above already right-anchors everything after it. -->
    <span class="hidden @max-[30rem]/pane:order-11 @max-[30rem]/pane:block @max-[30rem]/pane:flex-1"></span>

    <!-- Slot 6 -->
    {#if row.churn}
      <span
        class="flex w-[66px] shrink-0 justify-end gap-[5px] tabular-nums @max-[30rem]/pane:order-12 @max-[30rem]/pane:w-auto @max-[30rem]/pane:font-mono"
      >
        <span
          class="text-[color:color-mix(in_oklch,var(--success)_64%,var(--foreground))]"
          >+{compactCount(row.churn.additions)}</span
        >
        <span
          class="text-[color:color-mix(in_oklch,var(--failure)_66%,var(--foreground))]"
          >−{compactCount(row.churn.deletions)}</span
        >
      </span>
    {:else if row.meta}
      <span
        class="shrink-0 whitespace-nowrap text-muted-foreground opacity-80 @max-[30rem]/pane:order-12"
      >
        {row.meta}
      </span>
    {/if}

    <!-- Slot 7 -->
    {#each participants.shown as person (person.id)}
      <span class="flex shrink-0 items-center @max-[30rem]/pane:order-6"><ListAvatar {person} /></span>
    {/each}
    {#if participants.overflow > 0}
      <span
        class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--wash-3)] font-normal text-muted-foreground @max-[30rem]/pane:order-6"
        title="{participants.overflow} more"
      >
        +{participants.overflow}
      </span>
    {/if}

    <!-- Slot 8 — relative always; the timestamp lives in the tooltip. -->
    <span
      class="w-8 shrink-0 text-right tabular-nums text-muted-foreground opacity-75 @max-[30rem]/pane:order-7 @max-[30rem]/pane:w-auto @max-[30rem]/pane:font-mono"
      title={row.timeTitle}
    >
      {row.time}
    </span>
  </button>

  {#if trailing}{@render trailing()}{/if}
</div>
