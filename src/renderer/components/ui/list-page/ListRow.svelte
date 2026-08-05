<script lang="ts">
  import type { Snippet } from "svelte";
  import ListAvatar from "./ListAvatar.svelte";
  import ListChip from "./ListChip.svelte";
  import SourceLogo from "./SourceLogo.svelte";
  import { participantsAfterLead, type ListRowSpec } from "./list-page";

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
    /** 36px instead of 44px, for the list docked beside an open detail. */
    compact?: boolean;
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
    compact = false,
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
  class="group flex w-full items-center rounded-[10px] pr-3 pl-2.5 transition-shadow duration-150 {compact
    ? 'h-9'
    : 'h-11'} {selected
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
      class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground opacity-80"
      style="width: {identWidth}px"
    >
      {row.ident}
    </span>

    <!-- Slot 3 — the only full-strength text in the row. -->
    <span
      class="max-w-[520px] truncate text-[13px] font-[450] tracking-[-.005em]"
      title={row.title}
    >
      {row.title}
    </span>

    <!-- Slot 4 -->
    {#each row.chips as chip (chip.label)}
      <ListChip {chip} />
    {/each}

    <!-- Slot 5 — everything after this is right-anchored. -->
    <span class="flex-1"></span>

    <!-- Slot 6 -->
    {#if row.meta}
      <span
        class="shrink-0 font-mono text-[11px] whitespace-nowrap text-muted-foreground opacity-80"
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
        class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--wash-3)] font-mono text-[11px] font-[450] text-muted-foreground"
        title="{participants.overflow} more"
      >
        +{participants.overflow}
      </span>
    {/if}

    <!-- Slot 8 — relative always; the timestamp lives in the tooltip. -->
    <span
      class="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground opacity-75"
      title={row.timeTitle}
    >
      {row.time}
    </span>
  </button>

  {#if trailing}{@render trailing()}{/if}
</div>
