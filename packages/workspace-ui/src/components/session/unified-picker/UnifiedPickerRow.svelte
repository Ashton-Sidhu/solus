<script lang="ts">
  import {
    ChevronRight as ChevronRightIcon,
    MessagesSquare as ChatsIcon,
  } from "@lucide/svelte";
  import { snippetRuns } from "@solus/contracts/search-snippet";
  import type { Task, TaskStatus } from "@solus/contracts/task-types";
  import { highlightWordRuns, type TextRun } from "../../../lib/searchHighlight";
  import { swipeActions } from "../../../lib/swipe-actions";
  import TaskStatusGlyph from "../../tasks/TaskStatusGlyph.svelte";
  import TaskStatusSwipeControls from "../../tasks/TaskStatusSwipeControls.svelte";
  import {
    relativeTime,
    STATUS_META,
    TASK_STATUS_SWIPE_REVEAL_WIDTH,
  } from "../../tasks/lib/tasks-api";
  import { isDone } from "../../tasks/lib/tasks-list-view";
  import SessionStatusGlyph from "../SessionStatusGlyph.svelte";
  import {
    pickerSessionTitle,
    pickerSessionProject,
    pickerSessionActivity,
    isTaskGroup,
    projectLabel,
    taskShortIdLabel,
    type PickerEntry,
    type PickerRow,
  } from "./lib/picker-rows";

  /**
   * One row of the virtualised list: a section header, a task, or a session
   * nested under its task. The virtualiser hands each row its position in
   * `style`; the row's own height has to agree with `pickerRowHeight`, which
   * is where the numbers in the classes below come from.
   *
   * Names are marked by the query's words, the rule the list matched them by.
   * A passage from the index is marked by the index itself — its markers say
   * which stemmed tokens hit, which the words alone cannot.
   */
  interface Props {
    row: PickerRow;
    style: string;
    selectedIndex: number;
    query: string;
    onActivate: (entry: PickerEntry) => void;
    onHover: (event: PointerEvent, entry: PickerEntry) => void;
    onToggle: (taskId: string) => void;
    onContextMenu: (event: MouseEvent, entry: PickerEntry) => void;
    onPressStart: (event: PointerEvent, entry: PickerEntry) => void;
    onPressEnd: () => void;
    mobile: boolean;
    revealedTaskId: string | null;
    onRevealChange: (taskId: string | null) => void;
    onSetStatus: (task: Task, status: TaskStatus) => void;
  }
  let {
    row,
    style,
    selectedIndex,
    query,
    onActivate,
    onHover,
    onToggle,
    onContextMenu,
    onPressStart,
    onPressEnd,
    mobile,
    revealedTaskId,
    onRevealChange,
    onSetStatus,
  }: Props = $props();
</script>

{#snippet marked(runs: TextRun[])}
  {#each runs as run, i (i)}{#if run.hit}<mark
        class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_26%,transparent)] px-px text-inherit"
        >{run.text}</mark
      >{:else}{run.text}{/if}{/each}
{/snippet}

<!-- The trailing byline of a two-line row: a name that yields, then a date
     that does not. Capped, so a long task title can never squeeze the row's
     own title out of its column. -->
{#snippet byline(name: string | null, when: string)}
  <span class="flex max-w-[45%] shrink-0 items-center gap-1 whitespace-nowrap font-mono text-micro tabular-nums text-(--solus-text-tertiary)">
    {#if name}<span class="min-w-0 truncate">{name}</span><span class="shrink-0">·</span>{/if}
    <span class="shrink-0">{when}</span>
  </span>
{/snippet}

{#if row.kind === "header"}
  <!-- The command palette's group heading: shelf type, a hairline to the edge. -->
  <div
    class="flex h-8 select-none items-center gap-3 px-3 pt-[5px] text-chrome-shelf font-medium uppercase text-(--solus-text-tertiary) max-md:h-[34px] max-md:px-2 max-md:pt-2"
    {style}
  >
    <span class={row.accent ? 'text-(--solus-status-unread)' : ''}>{row.label}</span>
    <!-- A "+" where the hosts stopped at their cap: the count is a floor. -->
    <span class="font-mono tabular-nums opacity-60 max-md:order-3">{row.count}{row.capped ? "+" : ""}</span>
    <span class="h-px flex-1 bg-(--solus-menu-hairline) max-md:order-2" aria-hidden="true"></span>
    <!-- The rule the section is in. Stated on every header so the order is
         something you read, not something you work out from the dates. -->
    <span class="shrink-0 normal-case opacity-70 max-md:order-4">{row.hint}</span>
  </div>
{:else if row.kind === "task"}
  {@const task = row.task}
  {@const taskStatus = STATUS_META[task.status]}
  {@const isSelected = row.entryIndex === selectedIndex}
  {@const isRunning = row.sessions.some((child) => child.attention === "running")}
  {@const isGroup = isTaskGroup(row, mobile)}
  <div
    class="relative h-11 overflow-hidden rounded-lg max-md:h-[58px]"
    {style}
  >
    <TaskStatusSwipeControls
      status={task.status}
      revealed={revealedTaskId === task.id}
      class="hidden max-md:flex"
      onSelect={(status) => {
        onRevealChange(null);
        if (status !== task.status) onSetStatus(task, status);
      }}
    />
    <!-- The command palette's row: `menu-row` paints the hover ink, and the
         cursor sits in the same neutral wash every hover surface uses, with the
         title stepping to full ink. The row keeps an opaque background so
         the swipe controls under it on a phone stay hidden until revealed —
         which is why a done task dims its contents and never this box: an
         opacity here thinned the background and the tray showed through. -->
    <div
      class="menu-row group/row relative flex h-full items-center rounded-lg bg-background pr-3 data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-surface-hover)]! {isDone(task) ? '*:opacity-60' : ''}"
      data-selected={isSelected ? '' : undefined}
      use:swipeActions={{
        revealWidth: TASK_STATUS_SWIPE_REVEAL_WIDTH,
        open: revealedTaskId === task.id,
        enabled: mobile,
        onRevealChange: (revealed) => onRevealChange(revealed ? task.id : null),
      }}
    >
    <!-- The disclosure can also collapse a task after the full row opens it.
         It keeps its width when a task is not a group, because a ragged left
         edge is harder to scan than an empty gutter. -->
    <button
      type="button"
      class="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center text-(--solus-text-tertiary) max-md:w-11"
      aria-label={row.expanded ? `Collapse ${task.title}` : `Expand ${task.title}`}
      aria-expanded={row.expanded}
      disabled={!isGroup}
      onclick={(event) => {
        event.stopPropagation();
        onToggle(task.id);
      }}
    >
      <ChevronRightIcon
        size={10}
        class="shrink-0 transition-[transform,opacity] duration-150 max-md:size-3 max-md:opacity-50 {row.expanded ? 'rotate-90' : ''} {isGroup ? '' : 'opacity-0'}"
      />
    </button>
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      aria-expanded={isGroup ? row.expanded : undefined}
      class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-3 overflow-hidden text-left"
      onclick={() => revealedTaskId === task.id ? onRevealChange(null) : onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
      onpointerdown={(event) => onPressStart(event, row)}
      onpointerup={onPressEnd}
      onpointercancel={onPressEnd}
    >
      <span class="flex size-[1.625rem] shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)" title={taskStatus.label}>
        <TaskStatusGlyph status={task.status} size={13} />
        <span class="sr-only">{taskStatus.label}</span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate {isSelected ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary) group-hover/row:text-(--solus-text-primary)'}"
          >{@render marked(highlightWordRuns(task.title, query))}</span
        >
        <!-- The second line is the evidence when the title is not: the body
             passage the query hit, or the id it named, marked. Otherwise it is
             the row's usual byline. -->
        {#if row.bodySnippet}
          <span class="mt-px block truncate text-micro text-(--solus-text-tertiary)"
            >{@render marked(highlightWordRuns(row.bodySnippet, query))}</span
          >
        {:else}
          <span class="mt-px block truncate text-micro text-(--solus-text-tertiary) max-md:font-mono"
            >{#if row.matchedIn === "id"}{@render marked(highlightWordRuns(taskShortIdLabel(task), query))} · {/if}{projectLabel(task)} · {row.sessions.length
              ? `${row.sessions.length} ${row.sessions.length === 1 ? "session" : "sessions"}`
              : "no sessions yet"}</span
          >
        {/if}
      </span>
      {#if isRunning}
        <SessionStatusGlyph attention="running" />
      {:else}
        <!-- The key the list is ordered by. Tabular figures so a column of
             dates never reflows the titles beside them. -->
        <span class="shrink-0 whitespace-nowrap font-mono text-micro tabular-nums text-(--solus-text-tertiary)">
          {relativeTime(task.updatedAt)}
        </span>
      {/if}
      <ChevronRightIcon size={12} class="hidden shrink-0 text-(--solus-text-tertiary) opacity-50 max-md:block" />
      </button>
    </div>
  </div>
{:else if row.kind === "conversation" || !row.nested}
  {@const isSelected = row.entryIndex === selectedIndex}
  <!-- The same geometry as a task row: a name, and under it the passage the
       words were found in — the evidence, so the reader can tell the hits
       apart without arrowing onto each one. -->
  <div class="relative h-11 overflow-hidden rounded-lg max-md:h-[58px]" {style}>
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-selected={isSelected ? '' : undefined}
      class="menu-row group/row flex h-full w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg pr-3 pl-6 text-left data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-surface-hover)]! max-md:pl-11"
      onclick={() => onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
      onpointerdown={(event) => onPressStart(event, row)}
      onpointerup={onPressEnd}
      onpointercancel={onPressEnd}
    >
      <span class="flex size-[1.625rem] shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)">
        <ChatsIcon size={13} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate {isSelected ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary) group-hover/row:text-(--solus-text-primary)'}"
          >{@render marked(highlightWordRuns(pickerSessionTitle(row), query))}</span
        >
        <span class="mt-px block truncate text-micro text-(--solus-text-tertiary)"
          >{#if row.hit}{@render marked(snippetRuns(row.hit.snippet))}{:else}{pickerSessionProject(row)}{/if}</span
        >
      </span>
      {@render byline(null, relativeTime(pickerSessionActivity(row)))}
      <ChevronRightIcon size={12} class="hidden shrink-0 text-(--solus-text-tertiary) opacity-50 max-md:block" />
    </button>
  </div>
{:else}
  {@const child = row.session}
  {@const isSelected = row.entryIndex === selectedIndex}
  {@const isRunning = child.attention === "running"}
  <div class="relative pl-12 max-md:pl-11 {row.isLast ? 'pb-1 max-md:pb-0' : ''}" {style}>
    <!-- The spine the sidebar draws under a task, repeated here so the two
         surfaces read as the same tree. It stops at the last child's centre
         rather than running past it into the next task. -->
    <span
      class="absolute top-0 left-[37px] w-px bg-[var(--hairline-strong)] max-md:left-[29px] {row.isLast ? 'h-4 max-md:h-[25px]' : 'bottom-0'}"
      aria-hidden="true"
    ></span>
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-selected={isSelected ? '' : undefined}
      class="menu-row flex h-8 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg pr-3 pl-2 text-left data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-surface-hover)]! max-md:h-[50px]"
      onclick={() => onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
      onpointerdown={(event) => onPressStart(event, row)}
      onpointerup={onPressEnd}
      onpointercancel={onPressEnd}
    >
      <SessionStatusGlyph attention={child.attention} />
      <span class="min-w-0 flex-1">
        <span class="block truncate {isRunning || isSelected ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary) max-md:text-(--solus-text-primary)'}"
          >{@render marked(highlightWordRuns(child.label, query))}</span
        >
        <!-- The glyph beside it already says running or idle. A thumb's second
             line spends itself on the one thing the row cannot show otherwise:
             how long ago this session last said anything. -->
        <span class="hidden truncate font-mono text-micro text-(--solus-text-tertiary) max-md:block">last reply {relativeTime(child.lastActivityAt || row.task.updatedAt)}</span>
      </span>
      <!-- The same age, so the phone shows it once — in the sub-line. -->
      <span class="min-w-11 shrink-0 whitespace-nowrap text-right font-mono text-micro tabular-nums text-(--solus-text-tertiary) max-md:hidden">
        {relativeTime(child.lastActivityAt || row.task.updatedAt)}
      </span>
    </button>
  </div>
{/if}
