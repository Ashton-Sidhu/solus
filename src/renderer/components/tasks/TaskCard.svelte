<script lang="ts">
  import {
    ArrowSquareOutIcon,
    PlayIcon,
    ChatCircleDotsIcon,
    GitPullRequestIcon,
    GitBranchIcon,
    CalendarBlankIcon,
    CheckSquareIcon,
    SquareIcon,
    FlagIcon,
  } from "phosphor-svelte";
  import type { Task, TaskStatus } from "../../../shared/task-types";
  import {
    STATUS_META,
    statusLabel,
    dueDateMeta,
    DUE_TONE_META,
    PRIORITY_META,
    shortDate,
    visibleLabels,
  } from "./lib/tasks-api";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import { getTasksSelection } from "../../contexts/tasks-selection.store.svelte";

  interface Props {
    task: Task;
    /** Open the task detail view (primary click). */
    onOpen: (task: Task) => void;
    /** Start an agent session bound to this task. */
    onStart: (task: Task) => void;
    /** Open the source ticket in the browser (only when `task.url` is set). */
    onOpenLink: (task: Task) => void;
    /** Write the task's status back to the provider. */
    onSetStatus: (task: Task, status: TaskStatus) => void;
    /** Resume the most recent session started from this task (only when linked). */
    onResume?: (task: Task) => void;
    /** How many sessions have been started from this task — drives the back-link. */
    activeSessions?: number;
    /** Visual nesting for epic children. */
    nested?: boolean;
    /** Board (kanban) presentation: the column already conveys status, so the
     *  status label is dropped and the row actions overlay on hover. */
    board?: boolean;
    /** Multi-select (list view only): show the checkbox + allow modifier-click.
     *  When set, the card reads/writes the shared selection store from context. */
    selectable?: boolean;
  }
  let {
    task,
    onOpen,
    onStart,
    onOpenLink,
    onSetStatus,
    onResume,
    activeSessions = 0,
    nested = false,
    board = false,
    selectable = false,
  }: Props = $props();

  // List-view multi-select state lives in a context store shared by every card,
  // so it isn't threaded down through EpicGroup. Only read when `selectable`.
  const selection = getTasksSelection();
  const selected = $derived(selectable && selection.has(task.id));
  const selectionActive = $derived(selectable && selection.active);

  const status = $derived(STATUS_META[task.status]);
  // Labels minus any that just repeat the status (e.g. the "in-progress" chip in
  // the In progress column).
  const labels = $derived(visibleLabels(task));
  // Hide the due cue once done — a completed task isn't "overdue" anymore.
  const due = $derived(
    task.status === "done" ? null : dueDateMeta(task.dueDate),
  );
  const dueToneClass = $derived(due ? DUE_TONE_META[due.tone].chip : "");

  const STATUS_OPTIONS: TaskStatus[] = ["open", "in_progress", "done"];
  let statusMenuOpen = $state(false);
  let statusTriggerEl = $state<HTMLButtonElement | null>(null);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-task-card={task.id}
  class="group relative rounded-[0.625rem] px-3 py-2.5 cursor-pointer transition-colors duration-150 ease-in-out focus-visible:outline-none {board
    ? 'flex flex-col gap-1.5'
    : 'flex items-center gap-2.5'} {nested ? 'ml-5' : ''} {task.status ===
  'done'
    ? 'opacity-60'
    : ''} {selected
    ? 'bg-(--solus-accent-light)'
    : board
      ? 'focus-visible:bg-(--solus-surface-hover)'
      : 'hover:bg-(--solus-accent-light) focus-visible:bg-(--solus-accent-light)'}"
  role="button"
  tabindex="0"
  onclick={(e) => {
    // Modifier-click toggles selection instead of opening (Shift = range).
    if (selectable && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      selection.toggle(task, e);
      return;
    }
    onOpen(task);
  }}
  onkeydown={(e) => {
    if ((e.key === "x" || e.key === "X") && selectable) {
      // x toggles selection on the focused card — keyboard-first multi-select.
      e.preventDefault();
      selection.toggle(task, e);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(task);
    } else if (e.key === "1" || e.key === "2" || e.key === "3") {
      // Quick status while a card is focused: 1 Open · 2 In progress · 3 Done.
      e.preventDefault();
      const next = STATUS_OPTIONS[Number(e.key) - 1];
      if (next && task.status !== next) onSetStatus(task, next);
    }
  }}
  title="Open task · 1/2/3 set status · x select"
>
  {#snippet statusDot(boxClass = "size-[1.375rem]")}
    <!-- Status dot — click to change status (write-back), not to start. The box
         class is overridable so the board can match the title's first-line height
         and keep the dot optically aligned with the heading text. -->
    <button
      type="button"
      bind:this={statusTriggerEl}
      class="relative flex-shrink-0 grid place-items-center {boxClass} rounded-md border-0 bg-transparent cursor-pointer transition-colors duration-100 after:absolute after:-inset-1 hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none"
      aria-label={`Status: ${statusLabel(task.status)} — change`}
      aria-haspopup="listbox"
      aria-expanded={statusMenuOpen}
      title={`Status: ${statusLabel(task.status)}`}
      onclick={(e) => {
        e.stopPropagation();
        statusMenuOpen = !statusMenuOpen;
      }}
    >
      <span class="block size-2 rounded-full {status.dotClass}"></span>
    </button>
  {/snippet}

  {#snippet idTag()}
    <span
      class="flex-shrink-0 text-[0.75rem] text-(--solus-text-tertiary) tabular-nums"
      >{task.id.length > 8 ? `#${task.id.slice(0, 6)}` : `#${task.id}`}</span
    >
    {#if activeSessions > 0}
      <span
        class="flex shrink-0 items-center gap-0.5 text-(--solus-accent)"
        title={`${activeSessions} session${activeSessions === 1 ? "" : "s"} started from this task`}
      >
        <ChatCircleDotsIcon size={12} weight="fill" />
      </span>
    {/if}
  {/snippet}

  {#snippet metaChips(wrapClass: string)}
    {#if labels.length || task.assignee || due || task.pr || task.branch || task.priority}
      <div class={wrapClass}>
        {#if task.priority}
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-md py-0.5 pl-1 pr-1.5 text-[0.625rem] font-semibold leading-none {PRIORITY_META[
              task.priority
            ].chipClass}"
            title={`${PRIORITY_META[task.priority].label} priority`}
          >
            <FlagIcon size={10} weight="fill" />
            {PRIORITY_META[task.priority].label}
          </span>
        {/if}
        {#if due}
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-md py-0.5 pl-1 pr-1.5 text-[0.625rem] font-medium leading-none tabular-nums {dueToneClass}"
            title={`Due ${task.dueDate}`}
          >
            <CalendarBlankIcon size={10} weight="bold" />
            {due.label}
          </span>
        {/if}
        {#if task.pr}
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-md bg-(--solus-accent-light) py-0.5 pl-1 pr-1.5 text-[0.625rem] font-medium leading-none text-(--solus-accent) tabular-nums"
            title="A pull request is open for this task"
          >
            <GitPullRequestIcon size={10} weight="bold" />
            {task.pr.number ? `#${task.pr.number}` : "PR"}
          </span>
        {:else if task.branch}
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-md bg-(--solus-surface-hover) py-0.5 pl-1 pr-1.5 text-[0.625rem] font-medium leading-none text-(--solus-text-tertiary) max-w-[9rem]"
            title={`Work happened on ${task.branch}`}
          >
            <GitBranchIcon size={10} weight="bold" class="shrink-0" />
            <span class="truncate">{task.branch}</span>
          </span>
        {/if}
        {#each labels.slice(0, 3) as label (label)}
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-md bg-(--solus-surface-hover) px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-(--solus-text-secondary) max-w-[8rem]"
            title={label}
          >
            <span
              class="size-1 shrink-0 rounded-full bg-(--solus-text-tertiary)"
            ></span>
            <span class="truncate">{label}</span>
          </span>
        {/each}
        {#if labels.length > 3}
          <span
            class="shrink-0 rounded bg-(--solus-surface-hover) px-1.5 py-px text-[0.625rem] font-medium text-(--solus-text-tertiary) tabular-nums"
            title={labels.slice(3).join(", ")}>+{labels.length - 3}</span
          >
        {/if}
        {#if task.assignee}
          <span
            class="shrink-0 text-[0.6875rem] font-medium leading-none text-(--solus-text-tertiary)"
            >@{task.assignee}</span
          >
        {/if}
      </div>
    {/if}
  {/snippet}

  {#snippet actionButtons()}
    <!-- Hit targets extend vertically only — the buttons sit 2px apart, so a
         horizontal extension would overlap the neighbour's target. -->
    {#if task.url}
      <button
        type="button"
        class="relative inline-flex size-[1.625rem] cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out after:absolute after:inset-x-0 after:-inset-y-1.5 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none"
        onclick={(e) => {
          e.stopPropagation();
          onOpenLink(task);
        }}
        aria-label="Open source ticket"
        title="Open source ticket"
      >
        <ArrowSquareOutIcon size={13} />
      </button>
    {/if}
    {#if activeSessions > 0 && onResume}
      <button
        type="button"
        class="relative inline-flex size-[1.625rem] cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-accent) transition-[background-color] duration-100 ease-in-out after:absolute after:inset-x-0 after:-inset-y-1.5 hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none"
        onclick={(e) => {
          e.stopPropagation();
          onResume?.(task);
        }}
        aria-label="Resume session"
        title="Resume the latest session on this task"
      >
        <ChatCircleDotsIcon size={13} weight="fill" />
      </button>
    {/if}
    <button
      type="button"
      class="relative inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-[0.4375rem] border-0 bg-(--solus-accent-light) px-2 py-[0.3125rem] text-[0.6875rem] font-semibold text-(--solus-accent) transition-[background-color,scale] duration-100 ease-in-out after:absolute after:inset-x-0 after:-inset-y-1.5 hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)] active:scale-[0.96] focus-visible:outline-none"
      onclick={(e) => {
        e.stopPropagation();
        onStart(task);
      }}
      aria-label="Start session"
      title="Start a session from this task"
    >
      <PlayIcon size={11} weight="fill" class="translate-x-[0.5px]" />
      <span>Start</span>
    </button>
  {/snippet}

  {#if board}
    <!-- Board (Linear-style vertical card): ID eyebrow · status + title · meta footer.
         The column already conveys status, so the status word is dropped; row
         actions live top-right and reveal on hover. -->
    <div class="flex items-center gap-1.5">
      {@render idTag()}
      <div
        class="ml-auto flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
      >
        {@render actionButtons()}
      </div>
    </div>
    <div class="flex items-start gap-2">
      {@render statusDot("h-[1.125rem] w-[1.375rem]")}
      <span
        class="text-[0.8125rem] font-medium leading-snug tracking-[-0.01em] text-(--solus-text-primary) line-clamp-2"
        >{task.title}</span
      >
    </div>
    {@render metaChips("flex flex-wrap items-center gap-1.5 pl-[1.875rem]")}
    <div
      class="mt-0.5 pl-[1.875rem] text-[0.6875rem] text-(--solus-text-tertiary)"
    >
      Updated {shortDate(task.updatedAt)}
    </div>
  {:else}
    {#if selectable}
      <button
        type="button"
        class="relative grid size-[1.125rem] flex-shrink-0 place-items-center rounded border-0 bg-transparent cursor-pointer transition-opacity duration-100 after:absolute after:-inset-1 hover:opacity-100 focus-visible:outline-none {selected ||
        selectionActive
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100'} {selected
          ? 'text-(--solus-accent)'
          : 'text-(--solus-text-tertiary)'}"
        aria-label={selected ? "Deselect task" : "Select task"}
        aria-pressed={selected}
        onclick={(e) => {
          e.stopPropagation();
          selection.toggle(task, e);
        }}
      >
        {#if selected}
          <CheckSquareIcon size={16} weight="fill" />
        {:else}
          <SquareIcon size={16} />
        {/if}
      </button>
    {/if}

    {@render statusDot()}

    <!-- Title + meta -->
    <div class="flex-1 min-w-0 flex flex-col gap-0.5">
      <div class="flex items-center gap-2 min-w-0">
        <span
          class="text-[0.8125rem] font-medium tracking-[-0.01em] text-(--solus-text-primary) truncate {task.status ===
          'done'
            ? 'line-through'
            : ''}">{task.title}</span
        >
        {@render idTag()}
      </div>
      {@render metaChips("flex items-center gap-1.5 min-w-0")}
    </div>

    <!-- List: status label (fades on hover) with actions overlaid -->
    <div class="flex-shrink-0 flex items-center gap-1.5">
      <div class="relative flex items-center justify-end">
        <span
          class="text-[0.75rem] text-(--solus-text-tertiary) whitespace-nowrap transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0 group-focus-visible:opacity-0"
        >
          {statusLabel(task.status)}
        </span>
        <div
          class="absolute right-0 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"
        >
          {@render actionButtons()}
        </div>
      </div>
    </div>
  {/if}

  <Dropdown
    bind:open={statusMenuOpen}
    triggerEl={statusTriggerEl}
    align="bottom"
    anchor="left"
    width={150}
  >
    <div class="py-1" role="listbox" aria-label="Set status">
      {#each STATUS_OPTIONS as opt (opt)}
        <DropdownItem
          selected={task.status === opt}
          onclick={() => {
            statusMenuOpen = false;
            if (task.status !== opt) onSetStatus(task, opt);
          }}
        >
          <span class="flex items-center gap-2">
            <span class="block size-2 rounded-full {STATUS_META[opt].dotClass}"
            ></span>
            {STATUS_META[opt].label}
          </span>
        </DropdownItem>
      {/each}
    </div>
  </Dropdown>
</div>
