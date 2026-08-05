<script lang="ts">
  import type { TaskStatus } from "../../../shared/task-types";
  import { ListAvatar, ListChip, SourceLogo } from "../ui/list-page";
  import type { BoardCardSpec } from "./lib/tasks-list-view";

  /** One card on the kanban board ("Tasks page" spec, board layout).
   *
   *  Four bands, top to bottom: where it lives and when it moved · what it is ·
   *  what the agent is doing · who owns it. Everything the list row says with a
   *  fixed slot the card says with a line, because a card has width to lose and
   *  a column to scan down rather than across.
   *
   *  The card carries its own bounds — a card surface over the column's wash —
   *  so the board needs no dividers and no per-column fills. */
  interface Props {
    card: BoardCardSpec;
    selected?: boolean;
    /** This card is the one being dragged; it fades and lets the slot lead. */
    dragging?: boolean;
    onSelect: () => void;
    /** 1 / 2 / 3 on a focused card move it without reaching for the pointer. */
    onSetStatus: (status: TaskStatus) => void;
    onContextMenu?: (event: MouseEvent) => void;
    onDragStart: (event: DragEvent) => void;
    onDragEnd: () => void;
  }
  let {
    card,
    selected = false,
    dragging = false,
    onSelect,
    onSetStatus,
    onContextMenu,
    onDragStart,
    onDragEnd,
  }: Props = $props();

  // The three columns worth a keystroke. In review is a decision, not a nudge,
  // so it stays a drag or a menu choice.
  const QUICK_STATUS: Record<string, TaskStatus> = {
    "1": "todo",
    "2": "in_progress",
    "3": "done",
  };

  const hasFooter = $derived(card.chips.length > 0 || card.people.length > 0);
</script>

<div
  role="button"
  tabindex="0"
  draggable="true"
  data-task-card={card.key}
  class="group relative flex w-full shrink-0 cursor-pointer flex-col items-stretch gap-1.5 overflow-hidden rounded-xl bg-card px-3 pt-[11px] pb-2.5 text-left transition-[box-shadow,transform,opacity] duration-150 ease-out hover:-translate-y-px hover:shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_-1px_rgba(24,20,16,.10),0_12px_26px_-12px_rgba(24,20,16,.26)] focus-visible:-translate-y-px focus-visible:shadow-[0_0_0_.5px_var(--hairline-strongest),0_1px_2px_-1px_rgba(24,20,16,.10),0_12px_26px_-12px_rgba(24,20,16,.26)] focus-visible:outline-none {selected
    ? '-translate-y-px shadow-[0_0_0_.5px_var(--hairline-strongest),0_1px_2px_-1px_rgba(24,20,16,.10),0_12px_26px_-12px_rgba(24,20,16,.26)]'
    : 'shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_-1px_rgba(24,20,16,.10),0_6px_14px_-10px_rgba(24,20,16,.20)]'} {dragging
    ? 'opacity-40'
    : ''}"
  title="Open task · 1/2/3 set status"
  onclick={onSelect}
  onkeydown={(event) => {
    // The page also listens for Enter to open its selected row, so a key this
    // card acts on stops here rather than firing the same verb twice.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onSelect();
      return;
    }
    const next = QUICK_STATUS[event.key];
    if (next) {
      event.preventDefault();
      event.stopPropagation();
      onSetStatus(next);
    }
  }}
  oncontextmenu={onContextMenu}
  ondragstart={onDragStart}
  ondragend={onDragEnd}
>
  <!-- Where it lives, and when it last moved. -->
  <span class="flex min-w-0 items-center gap-1.5">
    {#if card.source.id !== "local"}
      <SourceLogo source={card.source.id} title={card.source.title} />
    {/if}
    <span
      class="shrink-0 font-mono text-[10px] tracking-[.02em] tabular-nums text-muted-foreground opacity-60"
    >
      {card.ident}
    </span>
    <span class="flex-1"></span>
    <span
      class="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground opacity-[.55]"
      title={card.timeTitle}
    >
      {card.time}
    </span>
  </span>

  <!-- The only full-strength text on the card. It wraps rather than truncates —
       a column is tall, and a half-read title is worth less than a second line. -->
  <span
    class="text-[12.5px] leading-[1.4] font-medium tracking-[-.008em] text-pretty {card.dimmed
      ? 'text-[color-mix(in_oklch,var(--foreground)_62%,transparent)]'
      : 'text-foreground'}"
  >
    {card.title}
  </span>

  {#if card.status}
    <span
      class="truncate text-[11px] tracking-[-.002em] {card.live
        ? 'text-[color-mix(in_oklch,var(--running)_66%,var(--foreground))]'
        : card.attention
          ? 'text-[color-mix(in_oklch,var(--primary)_76%,var(--foreground))]'
          : 'text-muted-foreground'}"
    >
      {card.status}
    </span>
  {/if}

  {#if hasFooter}
    <span
      class="mt-[3px] flex min-w-0 items-center gap-[5px] border-t border-[var(--hairline)] pt-2"
    >
      {#each card.chips as chip (chip.label)}
        <ListChip {chip} />
      {/each}
      <span class="flex-1"></span>
      {#each card.people as person (person.id)}
        <ListAvatar {person} />
      {/each}
    </span>
  {/if}
</div>
