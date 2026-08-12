<script lang="ts">
  import type { Snippet } from "svelte";
  import { CheckCircleIcon } from "phosphor-svelte";
  import ListAvatar from "./ListAvatar.svelte";
  import ListChip from "./ListChip.svelte";
  import SourceLogo from "./SourceLogo.svelte";
  import {
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
   *  interactive elements inside a button. */
  interface Props {
    row: ListRowSpec;
    /** 62px fits `SOL-412`; 44px fits `#418`. Fixed per page, never per row. */
    identWidth?: number;
    selected?: boolean;
    /** What occupies the lead-avatar slot when this row has no person. */
    fallbackAvatar?: "solus";
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
  class="group flex h-11 w-full items-center rounded-lg pr-3 pl-2.5 transition-shadow duration-150 {selected
    ? 'bg-[var(--wash-2)] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]'
    : 'hover:bg-[var(--wash-1)]'}"
  data-selected={selected}
  oncontextmenu={onContextMenu}
>
  {#if leading}{@render leading()}{/if}

  <button
    type="button"
    class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-[11px] border-0 bg-transparent p-0 text-left focus-visible:outline-none"
    onclick={onSelect}
    data-list-row
  >
    <!-- Slot 1 — the cell holds its 20px even with nobody in it, so every
         identifier below stays on the same x. -->
    <span class="flex size-5 shrink-0 items-center justify-center">
      {#if lead}<ListAvatar person={lead} />{/if}
    </span>

    <!-- Slot 2a — provider mark. A fixed 15px cell so the id column stays on the
         same x whether the mark is a badge or the local dot. Pages that don't
         set a source (PRs) never render it, keeping their layout unchanged. -->
    {#if row.source}
      <span class="-mr-1 flex w-[15px] shrink-0 items-center justify-center">
        <SourceLogo source={row.source.id} title={row.source.title} />
      </span>
    {/if}

    <!-- Slot 2 -->
    <span
      class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground opacity-80"
      style="width: {identWidth}px"
    >
      {row.ident}
    </span>

    <!-- Slot 3 — the only full-strength text in the row. `min-w-0` is what lets
         it lend width to the reveal instead of pushing the row wide. -->
    <span
      class="max-w-[520px] min-w-0 truncate text-[0.8125rem] font-normal "
      title={row.title}
    >
      {row.title}
    </span>

    <!-- Slot 4 -->
    {#each row.chips as chip (chip.label)}
      <ListChip {chip} />
    {/each}

    <!-- Everything after this is right-anchored. -->
    <span class="flex-1"></span>

    <!-- Slot 4, reveal form — the branch on a PR row. Zero *width* at rest, not zero opacity, so the rows
         you are not on stay full width; it opens under the pointer, under
         keyboard focus, and for as long as the row stays selected. Below 720px
         the title has no slack to lend, so it is suppressed; a coarse pointer
         has no hover to give, so it is simply always open and shorter. -->
    {#if row.reveal}
      <span
        class="flex shrink-0 items-center gap-1.5 overflow-hidden font-mono text-xs whitespace-nowrap text-muted-foreground transition-[max-width,opacity] duration-150 ease-out group-hover:max-w-[340px] group-hover:opacity-60 group-focus-within:max-w-[340px] group-focus-within:opacity-60 max-[720px]:hidden motion-reduce:transition-none pointer-coarse:max-w-[150px] pointer-coarse:opacity-60 {selected
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

    <!-- Slot 5 — passing is the expected case and gets a glyph; failing is the
         exception and gets words. Anything else holds the width in silence. -->
    {#if row.checks}
      {#if row.checks.state === "failing"}
        <ListChip chip={{ label: row.checks.label, tint: "failure" }} />
      {:else}
        <span
          class="flex w-4 shrink-0 items-center justify-center"
          title={row.checks.state === "passing" ? row.checks.label : undefined}
        >
          {#if row.checks.state === "passing"}
            <CheckCircleIcon
              size={12}
              class="text-[color:color-mix(in_oklch,var(--success)_72%,var(--foreground))]"
              aria-label={row.checks.label}
            />
          {/if}
        </span>
      {/if}
    {/if}

    <!-- Slot 6 -->
    {#if row.churn}
      <span
        class="flex w-[66px] shrink-0 justify-end gap-[5px] font-mono text-xs tabular-nums"
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
        class="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground opacity-80"
      >
        {row.meta}
      </span>
    {/if}

    <!-- Slot 7 -->
    {#each participants.shown as person (person.id)}
      <ListAvatar {person} />
    {/each}
    {#if participants.overflow > 0}
      <span
        class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--wash-3)] font-mono text-xs font-normal text-muted-foreground"
        title="{participants.overflow} more"
      >
        +{participants.overflow}
      </span>
    {/if}

    <!-- Slot 8 — relative always; the timestamp lives in the tooltip. -->
    <span
      class="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground opacity-75"
      title={row.timeTitle}
    >
      {row.time}
    </span>
  </button>

  {#if trailing}{@render trailing()}{/if}
</div>
