<script lang="ts">
  import type { Snippet } from "svelte";
  import ListAvatar from "./ListAvatar.svelte";
  import { chipSkin, compactCount, type ListRowSpec } from "./list-page";

  /** The list docked beside an open detail panel.
   *
   *  The wide row's eight columns need the page's full measure; at rail width
   *  the title is the first thing to be squeezed out, which is the one thing you
   *  are scanning for. So the rail re-stacks the same facts into two lines —
   *  title above, `ident · meta · note` below — and keeps only the avatar and the
   *  optional time on the outside, where the eye already expects them.
   *
   *  Chips do not survive the fold. The one that becomes the note is the first
   *  *tinted* one — a state that needed colour to be worth saying. The neutral
   *  chips are the domain (a branch, a label), which at rail width is the same
   *  long string on every row and pushes out the title it was meant to qualify. */
  interface Props {
    row: ListRowSpec;
    selected?: boolean;
    fallbackAvatar?: "solus";
    /** Use the canonical responsive type rung for workspace list titles. */
    responsiveTitle?: boolean;
    /** The rail can omit age when recency is not useful for navigation. */
    showTime?: boolean;
    onSelect?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
    leading?: Snippet;
  }
  let {
    row,
    selected = false,
    fallbackAvatar,
    responsiveTitle = false,
    showTime = true,
    onSelect,
    onContextMenu,
    leading,
  }: Props = $props();

  const lead = $derived(
    row.people[0] ??
      (fallbackAvatar === "solus"
        ? { id: "solus", initials: "S", name: "Solus", fallback: "solus" as const }
        : null),
  );
  // A failing build is the one thing the wide row says in colour, so it is also
  // what survives the fold — as words, not as the glyph the wide row can afford.
  const note = $derived(
    row.checks?.state === "failing"
      ? { label: row.checks.label, tint: "failure" as const }
      : (row.chips.find((chip) => !!chip.tint) ?? null),
  );
  const noteColor = $derived(
    note ? chipSkin(note.tint).color : "var(--muted-foreground)",
  );
  // At rail width churn is one more machine fact on the meta line, so it reads
  // as text rather than as the wide row's two coloured columns.
  const meta = $derived(
    row.meta ||
      (row.churn
        ? `+${compactCount(row.churn.additions)} −${compactCount(row.churn.deletions)}`
        : ""),
  );
</script>

<div
  class="group flex h-[52px] w-full items-center rounded-lg px-2.5 transition-shadow duration-150 {selected
    ? 'bg-[var(--wash-2)] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]'
    : 'hover:bg-[var(--wash-1)]'}"
  data-selected={selected}
  oncontextmenu={onContextMenu}
>
  {#if leading}{@render leading()}{/if}

  <button
    type="button"
    class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left focus-visible:outline-none"
    onclick={onSelect}
    data-list-row
  >
    <!-- The cell holds its 20px with nobody in it, so both lines of every row
         start on the same x. -->
    <span class="flex size-5 shrink-0 items-center justify-center">
      {#if lead}<ListAvatar person={lead} />{/if}
    </span>

    <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span
        class="truncate leading-[17px] font-normal {responsiveTitle
          ? 'text-workspace-chrome'
          : ''}"
        title={row.title}
      >
        {row.title}
      </span>
      <span
        class="flex min-w-0 items-center gap-[7px] text-xs leading-[15px]"
      >
        <span class="shrink-0 tabular-nums text-muted-foreground opacity-80">
          {row.ident}
        </span>
        {#if meta}
          <span
            class="shrink-0 tabular-nums text-muted-foreground opacity-70"
          >
            {meta}
          </span>
        {/if}
        {#if note}
          <span class="truncate" style="color: {noteColor}">{note.label}</span>
        {/if}
      </span>
    </span>

    <!-- Aligned to the title's line, not to the row's middle: the time belongs
         to the thing it is naming. -->
    {#if showTime}
      <span
        class="mt-px shrink-0 self-start text-xs tabular-nums text-muted-foreground opacity-75"
        title={row.timeTitle}
      >
        {row.time}
      </span>
    {/if}
  </button>
</div>
