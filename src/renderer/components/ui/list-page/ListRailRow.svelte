<script lang="ts">
  import type { Snippet } from "svelte";
  import ListAvatar from "./ListAvatar.svelte";
  import { chipSkin, type ListRowSpec } from "./list-page";

  /** The list docked beside an open detail panel.
   *
   *  The wide row's eight columns need the page's full measure; at rail width
   *  the title is the first thing to be squeezed out, which is the one thing you
   *  are scanning for. So the rail re-stacks the same facts into two lines —
   *  title above, `ident · meta · note` below — and keeps only the avatar and the
   *  time on the outside, where the eye already expects them.
   *
   *  Chips do not survive the fold. The one that becomes the note is the first
   *  *tinted* one — a state that needed colour to be worth saying. The neutral
   *  chips are the domain (a branch, a label), which at rail width is the same
   *  long string on every row and pushes out the title it was meant to qualify. */
  interface Props {
    row: ListRowSpec;
    selected?: boolean;
    fallbackAvatar?: "solus";
    onSelect?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
    leading?: Snippet;
  }
  let {
    row,
    selected = false,
    fallbackAvatar,
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
  const note = $derived(row.chips.find((chip) => !!chip.tint) ?? null);
  const noteColor = $derived(
    note ? chipSkin(note.tint).color : "var(--muted-foreground)",
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
        class="truncate text-[12.5px] leading-[17px] font-medium tracking-[-.005em]"
        title={row.title}
      >
        {row.title}
      </span>
      <span
        class="flex min-w-0 items-center gap-[7px] text-[10.5px] leading-[15px]"
      >
        <span class="shrink-0 font-mono tabular-nums text-muted-foreground opacity-80">
          {row.ident}
        </span>
        {#if row.meta}
          <span
            class="shrink-0 font-mono tabular-nums text-muted-foreground opacity-70"
          >
            {row.meta}
          </span>
        {/if}
        {#if note}
          <span class="truncate" style="color: {noteColor}">{note.label}</span>
        {/if}
      </span>
    </span>

    <!-- Aligned to the title's line, not to the row's middle: the time belongs
         to the thing it is naming. -->
    <span
      class="mt-px shrink-0 self-start font-mono text-[10.5px] tabular-nums text-muted-foreground opacity-75"
      title={row.timeTitle}
    >
      {row.time}
    </span>
  </button>
</div>
