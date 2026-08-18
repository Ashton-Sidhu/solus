<script lang="ts">
  import type { TaskStatus } from "../../../shared/task-types";
  import { ListAvatar, SourceLogo } from "../ui/list-page";
  import { avatarTint, chipSkin } from "../ui/list-page/list-page";
  import type { BoardCardSpec } from "./lib/tasks-list-view";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";

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
    /** Just moved — ringed briefly so the eye can follow it to its new slot. */
    flashing?: boolean;
    /** This is the copy riding the cursor, not a card in a column: it takes the
     *  lifted shadow and answers to nothing. */
    floating?: boolean;
    /** False while the board is filtered — the card can still change column,
     *  but its slot within one isn't the user's to set. */
    canReorder?: boolean;
    onSelect: () => void;
    /** 1 / 2 / 3 on a focused card move it without reaching for the pointer. */
    onSetStatus: (status: TaskStatus) => void;
    /** ⌥ + an arrow moves the card itself. Returns whether the board took it. */
    onMove: (key: string) => boolean;
    onContextMenu?: (event: MouseEvent) => void;
    onPress: (event: PointerEvent) => void;
  }
  let {
    card,
    selected = false,
    flashing = false,
    floating = false,
    canReorder = true,
    onSelect,
    onSetStatus,
    onMove,
    onContextMenu,
    onPress,
  }: Props = $props();

  // The three columns worth a keystroke. In review is a decision, not a nudge,
  // so it stays a drag or a menu choice.
  const QUICK_STATUS = {
    "1": "todo",
    "2": "in_progress",
    "3": "done",
  } satisfies Record<string, TaskStatus>;

  const hasFooter = $derived(card.chips.length > 0 || card.people.length > 0);

  /**
   * The board's chip is a pill with a dot rather than the list's ring-and-text
   * tile: a card's footer sits under two lines of prose, and a small mark of
   * colour separates labels from each other faster than a second ring would.
   * A neutral chip's dot takes the same hashed tint an avatar does, so one
   * label reads the same colour everywhere it appears.
   */
  const chips = $derived(
    card.chips.map((chip) => ({
      label: chip.label,
      color: chip.tint ? chipSkin(chip.tint).color : "var(--muted-foreground)",
      dot: chip.tint
        ? chipSkin(chip.tint).color
        : `color-mix(in oklch, var(${avatarTint(chip.label)}) 62%, transparent)`,
    })),
  );
</script>

<div
  role="button"
  tabindex={floating ? -1 : 0}
  data-task-card={card.key}
  class="text-xs group relative flex w-full shrink-0 flex-col items-stretch gap-[7px] overflow-hidden rounded-2xl bg-card px-2.5 py-[9px] text-left select-none {floating
 ? 'cursor-grabbing shadow-[0_0_0_1px_color-mix(in_oklch,var(--foreground)_18%,transparent),0_4px_12px_-6px_rgba(24,20,16,.22)]'
 : 'cursor-pointer transition-[box-shadow,transform] duration-150 ease-out hover:-translate-y-px hover:shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_-1px_rgba(24,20,16,.10),0_12px_26px_-12px_rgba(24,20,16,.26)] focus-visible:-translate-y-px focus-visible:shadow-[0_0_0_.5px_var(--hairline-strongest),0_1px_2px_-1px_rgba(24,20,16,.10),0_12px_26px_-12px_rgba(24,20,16,.26)] focus-visible:outline-none'} {flashing
 ? 'shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_55%,transparent),0_0_0_4px_color-mix(in_oklch,var(--primary)_12%,transparent)]'
 : selected
 ? '-translate-y-px shadow-[0_0_0_.5px_var(--hairline-strongest),0_1px_2px_-1px_rgba(24,20,16,.10),0_12px_26px_-12px_rgba(24,20,16,.26)]'
 : floating
 ? ''
 : 'shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_-1px_rgba(24,20,16,.10),0_6px_14px_-10px_rgba(24,20,16,.20)]'}"
  title={canReorder
    ? "Open task · drag to reorder · ⌥↑↓ ⌥←→ move · 1/2/3 set status"
    : "Open task · drag to change column · clear the search to reorder"}
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
    if (event.altKey && event.key.startsWith("Arrow")) {
      if (!onMove(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
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
  onpointerdown={onPress}
>
  <!-- Where it lives, and when it last moved. -->
  <span class="flex min-w-0 items-center gap-1.5">
    <TaskStatusGlyph status={card.lifecycle} size={20} />
    {#if card.source.id !== "local"}
      <SourceLogo source={card.source.id} title={card.source.title} />
    {/if}
    <span
      class="shrink-0 tabular-nums text-muted-foreground opacity-60"
    >
      {card.ident}
    </span>
    <span class="flex-1"></span>
    <span
      class="shrink-0 tabular-nums text-muted-foreground opacity-[.55]"
      title={card.timeTitle}
    >
      {card.time}
    </span>
  </span>

  <!-- The only full-strength text on the card. It wraps rather than truncates —
       a column is tall, and a half-read title is worth less than a second line. -->
  <span
    class="text-sm leading-[1.42] font-normal text-pretty {card.dimmed
 ? 'text-[color-mix(in_oklch,var(--foreground)_62%,transparent)]'
 : 'text-foreground'}"
  >
    {card.title}
  </span>

  {#if card.status}
    <span
      class="flex min-w-0 items-center gap-[5px] {card.live
 ? 'text-[color-mix(in_oklch,var(--running)_66%,var(--foreground))]'
 : card.attention
 ? 'text-[color-mix(in_oklch,var(--primary)_76%,var(--foreground))]'
 : 'text-muted-foreground'}"
    >
      <!-- The one moving thing on the board. It rides the status line's colour,
           so "an agent is on this" is a glance rather than a read. -->
      {#if card.live}
        <span class="animate-pulse-dot size-1 shrink-0 rounded-full bg-current"></span>
      {/if}
      <span class="truncate">{card.status}</span>
    </span>
  {/if}

  {#if hasFooter}
    <span class="mt-px flex min-w-0 items-center gap-[5px]">
      {#each chips as chip (chip.label)}
        <span
          class="inline-flex h-[18px] shrink-0 items-center gap-[5px] rounded-full py-0 pr-[7px] pl-1.5 font-normal shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]"
          style:color={chip.color}
        >
          <span class="size-[5px] shrink-0 rounded-full" style:background={chip.dot}></span>
          {chip.label}
        </span>
      {/each}
      <span class="flex-1"></span>
      <!-- Assignees lap each other and ring in the card's own fill, so a row of
           them reads as one group instead of three separate marks. -->
      {#each card.people as person, index (person.id)}
        <span
          class="flex shrink-0 rounded-full shadow-[0_0_0_2px_var(--card)] {index > 0
 ? '-ml-1.5'
 : ''}"
        >
          <ListAvatar {person} size={19} />
        </span>
      {/each}
    </span>
  {/if}
</div>
