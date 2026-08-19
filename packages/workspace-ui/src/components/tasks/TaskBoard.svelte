<script lang="ts">
  import { PlusIcon } from "phosphor-svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { Task, TaskStatus } from "@solus/contracts/task-types";
  import { buildBoard } from "./lib/tasks-api";
  import { taskBoardCard } from "./lib/tasks-list-view";
  import { orderColumn } from "./lib/board-order";
  import { BoardDrag, type DropTarget } from "./lib/board-drag.svelte";
  import { boardOrder } from "./board-order.store.svelte";
  import TaskBoardCard from "./TaskBoardCard.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";

  /**
   * The global list re-plotted as a kanban board ("Tasks page" spec, board
   * layout). Same tasks, same grammar as the list — only the axis changes: a
   * section becomes a column you can drop into, and within a column you can say
   * what comes first, which the list's sort can't express.
   *
   * Each column scrolls on its own, so a long In-progress column never pushes
   * Done off the bottom of the page.
   */
  interface Props {
    /** The page's visible tasks — already searched, filtered and ordered. */
    tasks: Task[];
    /** Scopes the saved card order; null while no project is open. */
    projectKey: string | null;
    /**
     * Whether `tasks` is the project's whole board rather than a search or
     * filter result. Reordering renumbers the column it lands in, so it is only
     * meaningful when the cards on screen *are* the column.
     */
    canReorder: boolean;
    selectedKey: string | null;
    onOpen: (task: Task) => void;
    onSetStatus: (task: Task, status: TaskStatus) => void;
    sessionsFor: (taskId: string) => number;
    /** Ticking clock, so card times age instead of freezing. */
    now: number;
    onContextMenu?: (event: MouseEvent, task: Task) => void;
    /** Open the composer pre-set to a column's status (undefined hides the +). */
    onAddInColumn?: (status: TaskStatus) => void;
  }
  let {
    tasks,
    projectKey,
    canReorder,
    selectedKey,
    onOpen,
    onSetStatus,
    sessionsFor,
    now,
    onContextMenu,
    onAddInColumn,
  }: Props = $props();

  // How much of a column is worth rendering before you ask for more. A Done
  // column is an archive — it grows without bound and nobody scrolls it — so
  // the board draws a screenful and lets the rest stay out of the DOM.
  const PAGE = 25;
  const revealed = new SvelteMap<TaskStatus, number>();

  const ranks = $derived(boardOrder.ranksFor(projectKey));
  const columns = $derived(
    buildBoard(tasks).map((col) => {
      // Slice *after* ordering, so what's hidden is always the tail — the cards
      // that sort last. That is what makes renumbering the visible run safe:
      // nothing below the cut can outrank something above it.
      const ordered = orderColumn(col.tasks, ranks);
      const cards = ordered.slice(0, revealed.get(col.status) ?? PAGE);
      return { ...col, ordered, cards, hidden: ordered.length - cards.length };
    }),
  );

  // A column is not its status: buildBoard folds inbox into Todo and dropped
  // into Done. Every move is decided in column terms, so a triaged-but-inbox
  // task dragged inside Todo doesn't get pointlessly rewritten. Built over the
  // whole column, not the rendered slice — membership has nothing to do with
  // how far down you have scrolled.
  const columnOf = $derived(
    new Map(
      columns.flatMap((col) => col.ordered.map((task) => [task.id, col.status] as const)),
    ),
  );

  /**
   * A column's *rendered* card ids. Drag and reorder both work in these terms:
   * only rendered cards can be hit-tested, and only they can be renumbered
   * meaningfully, so "the column" for the purposes of a move is what you can
   * see. Hidden cards sort below the whole visible run and stay put.
   */
  function idsIn(status: TaskStatus): string[] {
    return columns.find((col) => col.status === status)?.cards.map((task) => task.id) ?? [];
  }

  const drag = new BoardDrag({
    columns: () => columns.map((col) => col.status),
    idsIn,
    onDrop: (taskId, _from, target) => move(taskId, target),
  });

  const dragged = $derived(
    drag.drag ? (tasks.find((task) => task.id === drag.drag?.taskId) ?? null) : null,
  );

  $effect(() => () => drag.destroy());

  /**
   * Whether a drop into `status` would do anything. On a filtered board the
   * cards on screen are not the column, so there is nothing safe to renumber —
   * but moving a card to a *different* column is still just a status write, and
   * that stays available.
   */
  function acceptsDrop(status: TaskStatus, taskId: string | undefined): boolean {
    return canReorder || (!!taskId && columnOf.get(taskId) !== status);
  }

  /** The one write path: every drag, key and drop lands here. */
  function move(taskId: string, target: DropTarget) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !acceptsDrop(target.status, taskId)) return;

    // The new order is the column as it will read — the rendered cards with the
    // dragged one lifted out and spliced back at the placeholder. No index to
    // translate, because this array *is* what the user is looking at.
    if (canReorder) {
      const cards = idsIn(target.status).filter((id) => id !== taskId);
      boardOrder.setColumnOrder(projectKey, [
        ...cards.slice(0, target.index),
        taskId,
        ...cards.slice(target.index),
      ]);
    }
    if (columnOf.get(taskId) !== target.status) onSetStatus(task, target.status);
  }

  /**
   * ⌥ + an arrow moves the focused card without reaching for the pointer: up
   * and down within the column, left and right across columns, landing at the
   * same depth it left.
   */
  function moveByKey(taskId: string, key: string): boolean {
    const status = columnOf.get(taskId);
    if (!status) return false;
    const here = idsIn(status);
    const at = here.indexOf(taskId);

    if (key === "ArrowUp" || key === "ArrowDown") {
      // Swallowed rather than passed on even when reordering is off: the key
      // means "move this card" either way, and letting it fall through to the
      // page's row navigation would move the selection instead.
      if (!canReorder) return true;
      const to = key === "ArrowUp" ? at - 1 : at + 1;
      if (to < 0 || to >= here.length) return true;
      move(taskId, { status, index: to });
    } else {
      const order = columns.map((col) => col.status);
      const next = order[order.indexOf(status) + (key === "ArrowLeft" ? -1 : 1)];
      if (!next) return true;
      move(taskId, { status: next, index: Math.min(at, idsIn(next).length) });
    }
    drag.flash(taskId);
    return true;
  }
</script>

<div
  class="text-xs flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
>
  {#each columns as col (col.status)}
    {@const isTarget =
      !!drag.drag &&
      drag.target?.status === col.status &&
      acceptsDrop(col.status, drag.drag.taskId)}
    {@const cards = col.cards.filter((task) => task.id !== drag.drag?.taskId)}
    <div
      class="flex h-full min-h-0 max-w-[20.625rem] min-w-[14.75rem] flex-1 basis-[16.125rem] flex-col"
    >
      <!-- Column head. The glyph carries how far along the column is, which
           lets the label drop to sentence case and read as a place rather than
           as a shouted state. -->
      <div class="flex h-8 shrink-0 items-center gap-[7px] pr-1 pl-[3px]">
        <TaskStatusGlyph status={col.status} />
        <span class="font-normal ">{col.label}</span>
        <span class="tabular-nums text-muted-foreground opacity-[.65]">
          {col.ordered.length}
        </span>
        <span class="flex-1"></span>
        {#if onAddInColumn}
          <button
            type="button"
            class="flex size-5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground opacity-50 transition-[background-color,opacity] duration-150 hover:bg-[var(--wash-2)] hover:opacity-100 focus-visible:bg-[var(--wash-2)] focus-visible:opacity-100 focus-visible:outline-none"
            onclick={() => onAddInColumn?.(col.status)}
            aria-label={`New task in ${col.label}`}
            title={`New task in ${col.label}`}
          >
            <PlusIcon size={11} weight="bold" />
          </button>
        {/if}
      </div>

      <!-- The well. It has no fill at rest — an idle board is cards on the
           page, not four grey boxes — and only draws its bounds once a drag is
           in flight, when "where can this land" is the question being asked.

           It is also the scroll container, and its padding is what gives each
           card's half-pixel ring somewhere to be: a card flush against a
           scrolling edge has its ring clipped away on both sides. -->
      <div
        class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-2xl p-1.5 pb-5 transition-[background-color,box-shadow] duration-150 [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 {isTarget
          ? 'bg-[color-mix(in_oklch,var(--primary)_5%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_32%,transparent)]'
          : drag.drag
            ? 'bg-[var(--wash-1)] shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_7%,transparent)]'
            : ''}"
        use:drag.column={col.status}
      >
        {#each cards as task, index (task.id)}
          {#if isTarget && drag.target?.index === index}
            <!-- The slot the card would take, at its real height, so the cards
                 below sit exactly where the drop will leave them. -->
            <div
              class="shrink-0 rounded-2xl border border-dashed border-[color-mix(in_oklch,var(--primary)_45%,transparent)] bg-[color-mix(in_oklch,var(--primary)_6%,transparent)]"
              style:height="{drag.drag?.height}px"
            ></div>
          {/if}
          <div use:drag.card={task.id}>
            <TaskBoardCard
              card={taskBoardCard(task, sessionsFor(task.id), now)}
              selected={selectedKey === task.id}
              flashing={drag.flashId === task.id}
              {canReorder}
              onSelect={() => {
                if (drag.swallowsClick()) return;
                onOpen(task);
              }}
              onSetStatus={(status) => {
                if (task.status !== status) onSetStatus(task, status);
              }}
              onMove={(key) => moveByKey(task.id, key)}
              onContextMenu={(event) => onContextMenu?.(event, task)}
              onPress={(event) => drag.press(event, task.id, col.status)}
            />
          </div>
        {/each}

        {#if isTarget && (drag.target?.index ?? 0) >= cards.length}
          <div
            class="shrink-0 rounded-2xl border border-dashed border-[color-mix(in_oklch,var(--primary)_45%,transparent)] bg-[color-mix(in_oklch,var(--primary)_6%,transparent)]"
            style:height="{drag.drag?.height}px"
          ></div>
        {/if}

        {#if cards.length === 0 && !isTarget}
          <div
            class="flex h-14 shrink-0 items-center justify-center rounded-2xl border border-dashed border-[var(--hairline-strong)]  text-muted-foreground opacity-60"
          >
            Empty
          </div>
        {/if}

        <!-- The tail of the column, still countable but not yet drawn. It reads
             as a quiet line rather than a card, so a paged column doesn't look
             like it ends in one more piece of work. -->
        {#if col.hidden > 0}
          <button
            type="button"
            class="flex h-7 w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-0 bg-transparent  text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:bg-[var(--wash-2)] focus-visible:text-foreground focus-visible:outline-none"
            onclick={() => revealed.set(col.status, col.cards.length + PAGE)}
          >
            Show more
            <span class="tabular-nums opacity-70">{col.hidden}</span>
          </button>
        {/if}
      </div>
    </div>
  {/each}
</div>

<!-- The lifted card. It leaves its column entirely and rides the cursor at a
     slight tilt, so the board reads as one card in your hand over a layout that
     is already showing you where it will land. -->
{#if drag.drag && dragged}
  <div
    class="text-xs pointer-events-none fixed z-50 rotate-[1.6deg] opacity-[.97] drop-shadow-[0_22px_44px_rgba(24,20,16,.28)]"
    style:left="{drag.drag.x - drag.drag.offsetX}px"
    style:top="{drag.drag.y - drag.drag.offsetY}px"
    style:width="{drag.drag.width}px"
  >
    <TaskBoardCard
      card={taskBoardCard(dragged, sessionsFor(dragged.id), now)}
      floating
      onSelect={() => {}}
      onSetStatus={() => {}}
      onMove={() => false}
      onPress={() => {}}
    />
  </div>
{/if}
