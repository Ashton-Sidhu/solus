<script lang="ts">
  import {
    ChevronRight as ChevronRightIcon,
    MessagesSquare as ChatsIcon,
  } from "@lucide/svelte";
  import { snippetRuns } from "@solus/contracts/search-snippet";
  import { highlightWordRuns, type TextRun } from "../../../lib/searchHighlight";
  import TaskStatusGlyph from "../../tasks/TaskStatusGlyph.svelte";
  import { relativeTime, STATUS_META } from "../../tasks/lib/tasks-api";
  import { isDone } from "../../tasks/lib/tasks-list-view";
  import SessionStatusGlyph from "../SessionStatusGlyph.svelte";
  import PresenceStack from "../../presence/PresenceStack.svelte";
  import { presenceStore } from "../../../contexts/presence/presence.store.svelte";
  import { peopleOnSessions, pickerRowSessions } from "./lib/picker-presence";
  import {
    pickerSessionTitle,
    pickerSessionProject,
    pickerSessionActivity,
    pickerSessionTaskTitle,
    isTaskGroup,
    projectLabel,
    taskShortIdLabel,
    type PickerEntry,
    type PickerRow,
  } from "./lib/picker-rows";

  /**
   * One row of the virtualised list: a section header, a task, a session
   * nested under its task, or the end of a list the hosts answer in pages. The
   * virtualiser hands each row its position in `style`; the row's own height
   * has to agree with `pickerRowHeight`, which is where the numbers in the
   * classes below come from.
   *
   * Names are marked by the query's words, the rule the list matched them by.
   * A passage from a host comes marked by the host, by the same rule.
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
    /** The end row came into view: read the next page. */
    onReachEnd: () => void;
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
    onReachEnd,
  }: Props = $props();

  /** The end row mounts only when the virtualiser brings it near the view, so
   *  mounting reads the next page; a smaller remainder while it is still in
   *  view reads the one after. */
  function readsNextPage(remaining: number): () => void {
    return () => {
      if (remaining > 0) onReachEnd();
    };
  }

  // Who is working here, from the host's own roster, the same faces the sidebar
  // row shows: a task row gathers everyone in any of its sessions.
  const people = $derived(
    row.kind === "header" || row.kind === "more"
      ? []
      : peopleOnSessions(pickerRowSessions(row), (serverId, focus) => presenceStore.peopleFocusedOn(serverId, focus)),
  );
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
  <span class="flex max-w-[45%] shrink-0 items-center gap-1 whitespace-nowrap text-micro tabular-nums text-(--solus-text-tertiary)">
    {#if name}<span class="min-w-0 truncate">{name}</span><span class="shrink-0">·</span>{/if}
    <span class="shrink-0">{when}</span>
  </span>
{/snippet}

{#if row.kind === "header"}
  <!-- The command palette's group heading: shelf type, a hairline to the edge. -->
  <div
    class="flex h-8 select-none items-center gap-3 px-3 pt-[5px] text-chrome-shelf font-medium uppercase text-(--solus-text-tertiary)"
    {style}
  >
    <span>{row.label}</span>
    <span class="font-mono tabular-nums opacity-60">{row.count}</span>
    <span class="h-px flex-1 bg-(--solus-menu-hairline)" aria-hidden="true"></span>
    <!-- The rule the section is in. Stated on every header so the order is
         something you read, not something you work out from the dates. -->
    <span class="shrink-0 normal-case opacity-70">{row.hint}</span>
  </div>
{:else if row.kind === "task"}
  {@const task = row.task}
  {@const taskStatus = STATUS_META[task.status]}
  {@const isSelected = row.entryIndex === selectedIndex}
  {@const isRunning = row.sessions.some((child) => child.attention === "running")}
  {@const isGroup = isTaskGroup(row)}
  <div
    class="relative h-11 overflow-hidden rounded-lg"
    {style}
  >
    <!-- The command palette's row: `menu-row` paints the hover ink, and the
         cursor sits in the same neutral wash every hover surface uses, with the
         title stepping to full ink. A done task dims its contents. -->
    <div
      class="menu-row group/row relative flex h-full items-center rounded-lg pr-3 data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-surface-hover)]! {isDone(task) ? '*:opacity-60' : ''}"
      data-selected={isSelected ? '' : undefined}
    >
    <!-- The disclosure can also collapse a task after the full row opens it.
         It keeps its width when a task is not a group, because a ragged left
         edge is harder to scan than an empty gutter. -->
    <button
      type="button"
      class="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center text-(--solus-text-tertiary)"
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
        class="shrink-0 transition-[transform,opacity] duration-150 {row.expanded ? 'rotate-90' : ''} {isGroup ? '' : 'opacity-0'}"
      />
    </button>
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      aria-expanded={isGroup ? row.expanded : undefined}
      class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-3 overflow-hidden text-left"
      onclick={() => onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
    >
      <span class="flex size-[1.625rem] shrink-0 items-center justify-center text-(--solus-text-tertiary)" title={taskStatus.label}>
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
          <span class="mt-px block truncate text-micro text-(--solus-text-tertiary)"
            >{#if row.matchedIn === "id"}{@render marked(highlightWordRuns(taskShortIdLabel(task), query))} · {/if}{projectLabel(task)} · {row.sessions.length
              ? `${row.sessions.length} ${row.sessions.length === 1 ? "session" : "sessions"}`
              : "no sessions yet"}</span
          >
        {/if}
      </span>
      <PresenceStack {people} size={16} max={3} />
      {#if isRunning}
        <SessionStatusGlyph attention="running" />
      {:else}
        <!-- The key the list is ordered by. Tabular figures so a column of
             dates never reflows the titles beside them. -->
        <span class="shrink-0 whitespace-nowrap text-micro tabular-nums text-(--solus-text-tertiary)">
          {relativeTime(task.updatedAt)}
        </span>
      {/if}
      </button>
    </div>
  </div>
{:else if row.kind === "more"}
  <div
    class="flex h-8 items-center px-6 text-micro text-(--solus-text-tertiary)"
    {style}
    role="status"
    {@attach readsNextPage(row.remaining)}
  >
    Loading {row.remaining} more {row.remaining === 1 ? "session" : "sessions"}…
  </div>
{:else if row.kind === "conversation" || !row.nested}
  {@const isSelected = row.entryIndex === selectedIndex}
  <!-- The same geometry as a task row: a name, and under it the passage the
       words were found in — the evidence, so the reader can tell the hits
       apart without arrowing onto each one. -->
  <div class="relative h-11 overflow-hidden rounded-lg" {style}>
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-selected={isSelected ? '' : undefined}
      class="menu-row group/row flex h-full w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg pr-3 pl-6 text-left data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-surface-hover)]!"
      onclick={() => onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
    >
      <span class="flex size-[1.625rem] shrink-0 items-center justify-center text-(--solus-text-tertiary)">
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
      <PresenceStack {people} size={16} max={3} />
      <!-- Its task, so two sessions with one name under two tasks can be told apart. -->
      {@render byline(pickerSessionTaskTitle(row), relativeTime(pickerSessionActivity(row)))}
    </button>
  </div>
{:else}
  {@const child = row.session}
  {@const isSelected = row.entryIndex === selectedIndex}
  {@const isRunning = child.attention === "running"}
  <div class="relative pl-12 {row.isLast ? 'pb-1' : ''}" {style}>
    <!-- The spine the sidebar draws under a task, repeated here so the two
         surfaces read as the same tree. It stops at the last child's centre
         rather than running past it into the next task. -->
    <span
      class="absolute top-0 left-[37px] w-px bg-[var(--hairline-strong)] {row.isLast ? 'h-4' : 'bottom-0'}"
      aria-hidden="true"
    ></span>
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-selected={isSelected ? '' : undefined}
      class="menu-row flex h-8 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg pr-3 pl-2 text-left data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-surface-hover)]!"
      onclick={() => onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
    >
      <SessionStatusGlyph attention={child.attention} />
      <span class="min-w-0 flex-1">
        <span class="block truncate {isRunning || isSelected ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary)'}"
          >{@render marked(highlightWordRuns(child.label, query))}{#if child.runnerOffline}<span class="ml-1.5 text-micro text-(--solus-text-tertiary)" data-testid="picker-runner-offline">runner offline</span>{/if}</span
        >
      </span>
      <PresenceStack {people} size={14} max={2} />
      <span class="min-w-11 shrink-0 whitespace-nowrap text-right text-micro tabular-nums text-(--solus-text-tertiary)">
        {relativeTime(child.lastActivityAt || row.task.updatedAt)}
      </span>
    </button>
  </div>
{/if}
