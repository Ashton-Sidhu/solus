<script lang="ts">
  import { Plus as PlusIcon } from "@lucide/svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { TaskMoveTarget } from "@solus/contracts/task-types";
  import type { Task } from "../../contexts/tasks/task.svelte";
  import { boardViewId, buildBoard, moveTargetFor, type BoardView } from "./lib/tasks-api";
  import { taskBoardCard } from "./lib/tasks-list-view";
  import { orderColumn } from "./lib/board-order";
  import { BoardDrag, type DropTarget } from "./lib/board-drag.svelte";
  import { boardOrder } from "./board-order.store.svelte";
  import TaskBoardCard from "./TaskBoardCard.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";

  /**
   * The task list re-plotted as a kanban board ("Tasks page" spec, board
   * layout). Same tasks, same grammar as the list — only the axis changes: a
   * section becomes a column you can drop into, and within a column you can say
   * what comes first, which the list's sort can't express.
   *
   * The columns are the view's: the provider's own columns for one task
   * source, or the three status categories for every source together
   * (docs/plans/provider-owned-tasks.md §7).
   *
   * Each column scrolls on its own, so a long column never pushes the last one
   * off the bottom of the page.
   */
  interface Props {
    /** The page's visible tasks — already searched, filtered and ordered. */
    tasks: Task[];
    /** What the board plots: one source's columns, or every source by status category. */
    view: BoardView;
    /**
     * Whether `tasks` is the whole board rather than a search or
     * filter result. Reordering renumbers the column it lands in, so it is only
     * meaningful when the cards on screen *are* the column.
     */
    canReorder: boolean;
    selectedKey: string | null;
    onOpen: (task: Task) => void;
    /** Move a task to another column of the view. The page sends it to the provider. */
    onMoveTask: (task: Task, target: TaskMoveTarget) => void;
    /** Sessions whose agent works on the task now, not every linked one. */
    runningSessionsFor: (taskId: string) => number;
    /** "Solus Cloud" for a task whose home is the workspace service; null for this machine's. */
    homeFor?: (taskId: string) => string | null;
    /** Ticking clock, so card times age instead of freezing. */
    now: number;
    onContextMenu?: (event: MouseEvent, task: Task) => void;
    /** Open the composer for a new task in a column (undefined hides the +). */
    onAddInColumn?: (columnId: string) => void;
  }
  let {
    tasks,
    view,
    canReorder,
    selectedKey,
    onOpen,
    onMoveTask,
    runningSessionsFor,
    homeFor,
    now,
    onContextMenu,
    onAddInColumn,
  }: Props = $props();

  // How much of a column is worth rendering before you ask for more. A Done
  // column is an archive — it grows without bound and nobody scrolls it — so
  // the board draws a screenful and lets the rest stay out of the DOM.
  const PAGE = 25;
  const revealed = new SvelteMap<string, number>();

  // The columns of one view are not the columns of another, so each view
  // keeps its own card order.
  const orderKey = $derived(boardViewId(view));
  const ranks = $derived(boardOrder.ranksFor(orderKey));
  const columns = $derived(
    buildBoard(tasks, view).map((col) => {
      // Slice *after* ordering, so what's hidden is always the tail — the cards
      // that sort last. That is what makes renumbering the visible run safe:
      // nothing below the cut can outrank something above it.
      const ordered = orderColumn(col.tasks, ranks);
      const cards = ordered.slice(0, revealed.get(col.id) ?? PAGE);
      return { ...col, ordered, cards, hidden: ordered.length - cards.length };
    }),
  );

  // Every move is decided in column terms. Built over the whole column, not
  // the rendered slice — membership has nothing to do with how far down you
  // have scrolled.
  const columnOf = $derived(
    new Map(
      columns.flatMap((col) => col.ordered.map((task) => [task.id, col.id] as const)),
    ),
  );

  /**
   * A column's *rendered* card ids. Drag and reorder both work in these terms:
   * only rendered cards can be hit-tested, and only they can be renumbered
   * meaningfully, so "the column" for the purposes of a move is what you can
   * see. Hidden cards sort below the whole visible run and stay put.
   */
  function idsIn(columnId: string): string[] {
    return columns.find((col) => col.id === columnId)?.cards.map((task) => task.id) ?? [];
  }

  const drag = new BoardDrag({
    columns: () => columns.map((col) => col.id),
    idsIn,
    onDrop: (taskId, _from, target) => move(taskId, target),
  });

  const dragged = $derived(
    drag.drag ? (tasks.find((task) => task.id === drag.drag?.taskId) ?? null) : null,
  );

  $effect(() => () => drag.destroy());

  /**
   * Whether a drop into a column would do anything. On a filtered board the
   * cards on screen are not the column, so there is nothing safe to renumber —
   * but moving a card to a *different* column is still one write to the
   * provider, and that stays available. No provider has the "No column"
   * column, so a card cannot be moved into it.
   */
  function acceptsDrop(columnId: string, taskId: string | undefined): boolean {
    if (!taskId) return canReorder;
    if (columnOf.get(taskId) === columnId) return canReorder;
    return moveTargetFor(view, columnId) !== null;
  }

  /** The one write path: every drag, key and drop lands here. */
  function move(taskId: string, target: DropTarget) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !acceptsDrop(target.columnId, taskId)) return;

    // The new order is the column as it will read — the rendered cards with the
    // dragged one lifted out and spliced back at the placeholder. No index to
    // translate, because this array *is* what the user is looking at.
    if (canReorder) {
      const cards = idsIn(target.columnId).filter((id) => id !== taskId);
      boardOrder.setColumnOrder(orderKey, [
        ...cards.slice(0, target.index),
        taskId,
        ...cards.slice(target.index),
      ]);
    }
    const moveTarget = moveTargetFor(view, target.columnId);
    if (columnOf.get(taskId) !== target.columnId && moveTarget) onMoveTask(task, moveTarget);
  }

  /**
   * ⌥ + an arrow moves the focused card without reaching for the pointer: up
   * and down within the column, left and right across columns, landing at the
   * same depth it left.
   */
  function moveByKey(taskId: string, key: string): boolean {
    const columnId = columnOf.get(taskId);
    if (columnId === undefined) return false;
    const here = idsIn(columnId);
    const at = here.indexOf(taskId);

    if (key === "ArrowUp" || key === "ArrowDown") {
      // Swallowed rather than passed on even when reordering is off: the key
      // means "move this card" either way, and letting it fall through to the
      // page's row navigation would move the selection instead.
      if (!canReorder) return true;
      const to = key === "ArrowUp" ? at - 1 : at + 1;
      if (to < 0 || to >= here.length) return true;
      move(taskId, { columnId, index: to });
    } else {
      const order = columns.map((col) => col.id);
      const next = order[order.indexOf(columnId) + (key === "ArrowLeft" ? -1 : 1)];
      if (next === undefined) return true;
      move(taskId, { columnId: next, index: Math.min(at, idsIn(next).length) });
    }
    drag.flash(taskId);
    return true;
  }

  /** A digit on a focused card: move it to that column, counted from the left. */
  function moveToColumn(taskId: string, index: number) {
    const column = columns[index];
    if (!column || columnOf.get(taskId) === column.id) return;
    move(taskId, { columnId: column.id, index: 0 });
    drag.flash(taskId);
  }
</script>

<div
  class="text-xs flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
>
  {#each columns as col (col.id)}
    {@const isTarget =
      !!drag.drag &&
      drag.target?.columnId === col.id &&
      acceptsDrop(col.id, drag.drag.taskId)}
    {@const cards = col.cards.filter((task) => task.id !== drag.drag?.taskId)}
    <div
      class="flex h-full min-h-0 max-w-[20.625rem] min-w-[14.75rem] flex-1 basis-[16.125rem] flex-col"
    >
      <!-- Column head. The glyph carries how far along the column is, which
           lets the label drop to sentence case and read as a place rather than
           as a shouted state. -->
      <div class="flex h-8 shrink-0 items-center gap-[7px] pr-1 pl-[3px]">
        <TaskStatusGlyph category={col.category} />
        <span class="truncate font-normal" title={col.label}>{col.label}</span>
        <span class="tabular-nums text-muted-foreground opacity-[.65]">
          {col.ordered.length}
        </span>
        <span class="flex-1"></span>
        {#if onAddInColumn && moveTargetFor(view, col.id)}
          <button
            type="button"
            class="flex size-5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground opacity-50 transition-[background-color,opacity] duration-150 hover:bg-[var(--wash-2)] hover:opacity-100 focus-visible:bg-[var(--wash-2)] focus-visible:opacity-100 focus-visible:outline-none"
            onclick={() => onAddInColumn?.(col.id)}
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
        use:drag.column={col.id}
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
              card={taskBoardCard(task, runningSessionsFor(task.id), now, homeFor)}
              selected={selectedKey === task.id}
              flashing={drag.flashId === task.id}
              {canReorder}
              onSelect={() => {
                if (drag.swallowsClick()) return;
                onOpen(task);
              }}
              onMoveToColumn={(index) => moveToColumn(task.id, index)}
              onMove={(key) => moveByKey(task.id, key)}
              onContextMenu={(event) => onContextMenu?.(event, task)}
              onPress={(event) => drag.press(event, task.id, col.id)}
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
            onclick={() => revealed.set(col.id, col.cards.length + PAGE)}
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
      card={taskBoardCard(dragged, runningSessionsFor(dragged.id), now, homeFor)}
      floating
      onSelect={() => {}}
      onMoveToColumn={() => {}}
      onMove={() => false}
      onPress={() => {}}
    />
  </div>
{/if}
