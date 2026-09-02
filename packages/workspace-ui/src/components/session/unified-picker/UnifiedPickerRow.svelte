<script lang="ts">
  import { ChevronRight as ChevronRightIcon } from "@lucide/svelte";
  import { highlightRuns, type TextRun } from "../../../lib/searchHighlight";
  import TaskStatusGlyph from "../../tasks/TaskStatusGlyph.svelte";
  import { relativeTime, STATUS_META } from "../../tasks/lib/tasks-api";
  import { isDone } from "../../tasks/lib/tasks-list-view";
  import SessionStatusGlyph from "../SessionStatusGlyph.svelte";
  import { projectLabel, type PickerEntry, type PickerRow } from "./lib/picker-rows";

  /**
   * One row of the virtualised list: a section header, a task, or a session
   * nested under its task. The virtualiser hands each row its position in
   * `style`; the row's own height has to agree with `pickerRowHeight`, which
   * is where the numbers in the classes below come from.
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
  }: Props = $props();
</script>

{#snippet marked(runs: TextRun[])}
  {#each runs as run, i (i)}{#if run.hit}<mark
        class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_26%,transparent)] px-px text-inherit"
        >{run.text}</mark
      >{:else}{run.text}{/if}{/each}
{/snippet}

{#if row.kind === "header"}
  <div
    class="flex h-8 items-center gap-3 px-2.5 pt-[5px] text-muted-foreground max-md:h-[34px] max-md:px-2 max-md:pt-2"
    {style}
  >
    <span class="text-micro font-medium tracking-[0.13em] uppercase {row.accent ? 'text-(--solus-status-unread)' : ''}">{query ? "Matches" : row.label}</span>
    <span class="font-mono text-micro tabular-nums opacity-50 max-md:order-3 max-md:opacity-60">{row.count}</span>
    <span class="h-px flex-1 bg-[var(--hairline)] max-md:order-2" aria-hidden="true"></span>
  </div>
{:else if row.kind === "task"}
  {@const task = row.task}
  {@const taskStatus = STATUS_META[task.status]}
  {@const isSelected = row.entryIndex === selectedIndex}
  {@const isRunning = row.sessions.some((child) => child.attention === "running")}
  <div
    class="flex h-11 items-center rounded-xl pr-2.5 transition-[background-color] duration-100 max-md:h-[58px] max-md:rounded-lg max-md:pr-3 {isSelected ? 'bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] max-md:bg-[var(--wash-2)]' : 'hover:bg-[var(--wash-2)]'} {isDone(task) ? 'opacity-60' : ''}"
    {style}
  >
    <!-- The disclosure is its own target, so opening a task never resumes it
         by accident. It keeps its width when a task has no sessions, because
         a ragged left edge is harder to scan than an empty gutter. -->
    <button
      type="button"
      class="flex h-full w-[26px] shrink-0 cursor-pointer items-center justify-center text-muted-foreground max-md:w-11"
      aria-label={row.expanded ? `Collapse ${task.title}` : `Expand ${task.title}`}
      aria-expanded={row.expanded}
      disabled={row.sessions.length === 0}
      onclick={(event) => {
        event.stopPropagation();
        onToggle(task.id);
      }}
    >
      <ChevronRightIcon
        size={10}
        class="shrink-0 transition-[transform,opacity] duration-150 max-md:size-3 max-md:opacity-50 {row.expanded ? 'rotate-90' : ''} {row.sessions.length ? '' : 'opacity-0'}"
      />
    </button>
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      class="flex h-full min-w-0 flex-1 cursor-pointer items-center overflow-hidden text-left"
      onclick={() => onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
      onpointerdown={(event) => onPressStart(event, row)}
      onpointerup={onPressEnd}
      onpointercancel={onPressEnd}
    >
      <span class="flex w-[22px] shrink-0 items-center justify-center max-md:w-4" title={taskStatus.label}>
        <TaskStatusGlyph status={task.status} size={13} />
        <span class="sr-only">{taskStatus.label}</span>
      </span>
      <span class="min-w-0 flex-1 pl-2">
        <span class="block truncate text-workspace-chrome font-medium text-foreground"
          >{@render marked(highlightRuns(task.title, query))}</span
        >
        <span class="mt-px block truncate text-micro text-muted-foreground opacity-[0.78] max-md:font-mono max-md:opacity-100"
          >{projectLabel(task)} · {row.sessions.length
            ? `${row.sessions.length} ${row.sessions.length === 1 ? "session" : "sessions"}`
            : "no sessions yet"}</span
        >
      </span>
      {#if isRunning}
        <SessionStatusGlyph attention="running" class="ml-2.5" />
      {:else}
        <!-- The key the list is ordered by. Tabular figures so a column of
             dates never reflows the titles beside them. -->
        <span class="ml-2.5 shrink-0 whitespace-nowrap font-mono text-micro tabular-nums text-muted-foreground opacity-70 max-md:opacity-75">
          {relativeTime(task.updatedAt)}
        </span>
      {/if}
      <ChevronRightIcon size={12} class="ml-2 hidden shrink-0 text-muted-foreground opacity-50 max-md:block" />
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
      class="flex h-8 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg pr-2.5 pl-2 text-left transition-[background-color] duration-100 max-md:h-[50px] max-md:rounded-md max-md:pr-3 {isSelected ? 'bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] max-md:bg-[var(--wash-2)]' : 'hover:bg-[var(--wash-2)]'}"
      onclick={() => onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
      onpointerdown={(event) => onPressStart(event, row)}
      onpointerup={onPressEnd}
      onpointercancel={onPressEnd}
    >
      <SessionStatusGlyph attention={child.attention} />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-workspace-chrome {isRunning ? 'text-foreground' : 'text-muted-foreground max-md:text-foreground'}"
          >{@render marked(highlightRuns(child.label, query))}</span
        >
        <!-- The glyph beside it already says running or idle. A thumb's second
             line spends itself on the one thing the row cannot show otherwise:
             how long ago this session last said anything. -->
        <span class="hidden truncate font-mono text-micro text-muted-foreground max-md:block">last reply {relativeTime(child.lastActivityAt || row.task.updatedAt)}</span>
      </span>
      <!-- The same age, so the phone shows it once — in the sub-line. -->
      <span class="min-w-11 shrink-0 whitespace-nowrap text-right font-mono text-micro tabular-nums text-muted-foreground opacity-60 max-md:hidden">
        {relativeTime(child.lastActivityAt || row.task.updatedAt)}
      </span>
    </button>
  </div>
{/if}
