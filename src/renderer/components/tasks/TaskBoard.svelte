<script lang="ts">
  import { PlusIcon } from "phosphor-svelte";
  import { fade } from "svelte/transition";
  import { SvelteMap } from "svelte/reactivity";
  import type { Task, TaskStatus } from "../../../shared/task-types";
  import { buildBoard } from "./lib/tasks-api";
  import { taskBoardCard } from "./lib/tasks-list-view";
  import { VirtualList } from "../ui/list-page";
  import TaskBoardCard from "./TaskBoardCard.svelte";

  /**
   * The global list re-plotted as a kanban board ("Tasks page" spec, board
   * layout). Same tasks, same order, same grammar as the list — only the axis
   * changes: a section becomes a column you can drop into.
   *
   * Each column scrolls on its own inside a wash well, so a long In-progress
   * column never pushes Done off the bottom of the page.
   */
  interface Props {
    /** The page's visible tasks — already searched, filtered and ordered. */
    tasks: Task[];
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
    selectedKey,
    onOpen,
    onSetStatus,
    sessionsFor,
    now,
    onContextMenu,
    onAddInColumn,
  }: Props = $props();

  const columns = $derived(buildBoard(tasks));

  // Only In progress earns a coloured heading — it is the one column whose count
  // is a live number rather than a backlog.
  const LABEL_COLOR: Partial<Record<TaskStatus, string>> = {
    in_progress: "color-mix(in oklch, var(--running) 62%, var(--foreground))",
  };

  // Drag-to-restatus: the card being dragged and the column hovered over. Status
  // change is just an onSetStatus write — the same path the keys and menu use.
  let dragId = $state<string | null>(null);
  let overStatus = $state<TaskStatus | null>(null);
  const columnHeights = new SvelteMap<TaskStatus, number>();
  const cardHeights = new SvelteMap<string, number>();
  const dragTask = $derived(tasks.find((task) => task.id === dragId) ?? null);

  function endDrag() {
    dragId = null;
    overStatus = null;
  }

  function drop(status: TaskStatus) {
    if (dragTask && dragTask.status !== status) onSetStatus(dragTask, status);
    endDrag();
  }

  function measureColumn(node: HTMLElement, status: TaskStatus) {
    const observer = new ResizeObserver(([entry]) => {
      columnHeights.set(status, entry?.contentRect.height ?? node.clientHeight);
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  function measureCard(node: HTMLElement, taskId: string) {
    const observer = new ResizeObserver(() => {
      cardHeights.set(taskId, node.offsetHeight);
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

<div
  class="flex min-h-0 flex-1 items-stretch gap-2.5 overflow-x-auto overflow-y-hidden pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
>
  {#each columns as col (col.status)}
    {@const isSource = dragTask?.status === col.status}
    {@const isTarget = !!dragId && !isSource}
    {@const isOver = isTarget && overStatus === col.status}
    <div
      class="flex h-full min-h-0 max-w-[21.25rem] min-w-[14rem] flex-1 basis-[15.25rem] flex-col"
    >
      <!-- Column head. The label carries the status, so no dot repeats it. -->
      <div class="flex h-[30px] shrink-0 items-center gap-2 pr-1 pl-0.5">
        <span
          class="text-[9.5px] font-medium tracking-[.12em] uppercase"
          style:color={LABEL_COLOR[col.status] ?? "var(--muted-foreground)"}
        >
          {col.label}
        </span>
        <span class="font-mono text-[10px] tabular-nums text-muted-foreground opacity-70">
          {col.tasks.length}
        </span>
        <span class="flex-1"></span>
        {#if onAddInColumn}
          <button
            type="button"
            class="flex size-5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground opacity-[.55] transition-[background-color,opacity] duration-150 hover:bg-[var(--wash-2)] hover:opacity-100 focus-visible:bg-[var(--wash-2)] focus-visible:opacity-100 focus-visible:outline-none"
            onclick={() => onAddInColumn?.(col.status)}
            aria-label={`New task in ${col.label}`}
            title={`New task in ${col.label}`}
          >
            <PlusIcon size={11} weight="bold" />
          </button>
        {/if}
      </div>

      <!-- The well. It is a wash rather than a card, so the cards inside it are
           the only things with edges — and it turns brand-tinted only while it
           is a live drop target. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-[14px] p-2 pb-5 transition-colors duration-150 {isOver
          ? 'bg-[color-mix(in_oklch,var(--primary)_9%,transparent)] shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--primary)_34%,transparent)]'
          : 'bg-[var(--wash-1)] shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_6%,transparent)]'}"
        ondragover={(event) => {
          if (!dragId) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          overStatus = col.status;
        }}
        ondragleave={(event) => {
          // Ignore leaves into our own children — only a true exit clears the target.
          if (overStatus !== col.status) return;
          const to = event.relatedTarget;
          if (to instanceof Node && event.currentTarget.contains(to)) return;
          overStatus = null;
        }}
        ondrop={(event) => {
          event.preventDefault();
          drop(col.status);
        }}
        use:measureColumn={col.status}
      >
        <VirtualList
          items={col.tasks}
          height={columnHeights.get(col.status) ?? 0}
          itemSize={(index) =>
            (cardHeights.get(col.tasks[index].id) ?? 108) + 8}
          estimatedItemSize={116}
          overscan={4}
          keyOf={(task) => task.id}
          activeKey={selectedKey}
        >
          {#snippet children(task, _index, style)}
            <div {style}>
              <div use:measureCard={task.id}>
                <TaskBoardCard
                  card={taskBoardCard(task, sessionsFor(task.id), now)}
                  selected={selectedKey === task.id}
                  dragging={dragId === task.id}
                  onSelect={() => onOpen(task)}
                  onSetStatus={(status) => {
                    if (task.status !== status) onSetStatus(task, status);
                  }}
                  onContextMenu={(event) => onContextMenu?.(event, task)}
                  onDragStart={(event) => {
                    if (event.dataTransfer) {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", task.id);
                    }
                    dragId = task.id;
                  }}
                  onDragEnd={endDrag}
                />
              </div>
            </div>
          {/snippet}
          {#snippet footer()}
            {#if isOver && col.tasks.length > 0}
              <div
                class="rounded-[11px] border border-dashed border-[color-mix(in_oklch,var(--primary)_45%,transparent)] py-2.5 text-center text-[11px] font-medium text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]"
                in:fade={{ duration: 100 }}
              >
                Move to {col.label}
              </div>
            {/if}
          {/snippet}
        </VirtualList>

        {#if col.tasks.length === 0}
          <div
            class="flex h-[60px] shrink-0 items-center justify-center rounded-[11px] border border-dashed text-[11px] {isOver
              ? 'border-[color-mix(in_oklch,var(--primary)_45%,transparent)] text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
              : 'border-[var(--hairline-strong)] text-muted-foreground opacity-70'}"
          >
            {isOver ? `Move to ${col.label}` : "Empty"}
          </div>
        {/if}
      </div>
    </div>
  {/each}
</div>
