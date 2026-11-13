<script lang="ts">
  import { MessagesSquare as ChatsIcon } from "@lucide/svelte";
  import { snippetRuns } from "@solus/contracts/search-snippet";
  import { highlightWordRuns, type TextRun } from "../../../lib/searchHighlight";
  import TaskStatusGlyph from "../../tasks/TaskStatusGlyph.svelte";
  import { relativeTime, taskRef } from "../../tasks/lib/tasks-api";
  import { isDone } from "../../tasks/lib/tasks-list-view";
  import SessionStatusGlyph from "../SessionStatusGlyph.svelte";
  import type { AttentionState } from "../../../lib/sessionUtils";
  import PresenceStack from "../../presence/PresenceStack.svelte";
  import { presenceStore } from "../../../contexts/presence/presence.store.svelte";
  import { serversStore } from "../../../contexts/connections/servers.store.svelte";
  import HostOperatingSystemIcon from "../../servers/HostOperatingSystemIcon.svelte";
  import { hostIsManaged } from "../../servers/lib/managed-host";
  import { peopleOnSessions, pickerRowSessions } from "./lib/picker-presence";
  import { recordTimestamp, recordTitle } from "./lib/picker-records";
  import { recordDetail } from "./lib/picker-record-view";
  import PickerPullRequestRow from "./PickerPullRequestRow.svelte";
  import PickerRecordIcon from "./PickerRecordIcon.svelte";
  import {
    pickerSessionTitle,
    pickerSessionProject,
    pickerSessionActivity,
    pickerSessionServerId,
    pickerSessionTaskTitle,
    type PickerEntry,
    type PickerRow,
  } from "./lib/picker-rows";

  /**
   * One row of the virtualised list: a section header, a task, a session, a
   * record (a work, a pull request, an automation, a project, an action), or
   * the end of a list the hosts answer in pages. The virtualiser hands each
   * row its position in `style`; the row's own height has to agree with
   * `pickerRowHeight`, which is where the numbers in the classes below come
   * from.
   *
   * Names are marked by the query's words, the rule the list matched them by.
   * A passage from a host comes marked by the host, by the same rule.
   */
  interface Props {
    row: PickerRow;
    style: string;
    selectedIndex: number;
    query: string;
    /** A session row's live state. Null for a task row, whose state comes
     *  from its own sessions, and for an idle session. */
    attention: AttentionState;
    onActivate: (entry: PickerEntry) => void;
    onHover: (event: PointerEvent, entry: PickerEntry) => void;
    onContextMenu: (event: MouseEvent, entry: PickerEntry) => void;
    /** The end row came into view: read the next page. */
    onReachEnd: () => void;
  }
  let {
    row,
    style,
    selectedIndex,
    query,
    attention,
    onActivate,
    onHover,
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
    row.kind === "header" || row.kind === "more" || row.kind === "record"
      ? []
      : peopleOnSessions(pickerRowSessions(row), (serverId, focus) => presenceStore.peopleFocusedOn(serverId, focus)),
  );

  // The machine a session ran on, when it is not this one. A local session
  // carries no mark, so the remote ones stand out in a mixed list.
  const remoteHost = $derived.by(() => {
    if (row.kind !== "session" && row.kind !== "conversation") return null;
    const host = serversStore.hostFor(pickerSessionServerId(row));
    return host && !host.local ? host : null;
  });
</script>

{#snippet marked(runs: TextRun[])}
  {#each runs as run, i (i)}{#if run.hit}<mark
        class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit"
        >{run.text}</mark
      >{:else}{run.text}{/if}{/each}
{/snippet}

<!-- The remote host a session ran on: its operating system's mark and name,
     as the sidebar row shows it. -->
{#snippet hostMark()}
  {#if remoteHost}
    <span class="flex min-w-0 items-center gap-1" title={remoteHost.label} data-testid="picker-session-host">
      <HostOperatingSystemIcon
        os={"os" in remoteHost ? remoteHost.os : undefined}
        managed={hostIsManaged(remoteHost)}
        size={11}
        class="shrink-0"
      />
      <span class="min-w-0 truncate">{remoteHost.label}</span>
    </span>
  {/if}
{/snippet}

<!-- The trailing byline of a two-line row: a name that yields, then a date
     that does not. Capped, so a long task title can never squeeze the row's
     own title out of its column. -->
{#snippet byline(name: string | null, when: string)}
  <span class="flex max-w-[45%] shrink-0 items-center gap-1 whitespace-nowrap text-micro tabular-nums text-(--solus-text-tertiary)">
    {#if name}<span class="min-w-0 truncate">{name}</span><span class="shrink-0">·</span>{/if}
    {#if remoteHost}{@render hostMark()}<span class="shrink-0">·</span>{/if}
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
    <!-- The rule the section is in. Stated on every header that has one, so
         the order is something you read, not something you work out from the
         dates. -->
    {#if row.hint}<span class="shrink-0 normal-case opacity-70">{row.hint}</span>{/if}
  </div>
{:else if row.kind === "task"}
  {@const task = row.task}
  {@const isSelected = row.entryIndex === selectedIndex}
  {@const isRunning = row.sessions.some((child) => child.attention === "running")}
  <div
    class="relative h-11 overflow-hidden rounded-lg"
    {style}
  >
    <!-- The command palette's row: `menu-row` paints the hover ink, and the
         cursor sits in the same neutral wash every hover surface uses, with the
         title stepping to full ink. A done task dims its contents. -->
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-selected={isSelected ? '' : undefined}
      class="menu-row group/row flex h-full w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg pr-3 pl-6 text-left data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-surface-hover)]! {isDone(task) ? '*:opacity-60' : ''}"
      onclick={() => onActivate(row)}
      onpointermove={(event) => onHover(event, row)}
      oncontextmenu={(event) => onContextMenu(event, row)}
    >
      <span class="flex size-[1.625rem] shrink-0 items-center justify-center text-(--solus-text-tertiary)" title={task.state.name}>
        <TaskStatusGlyph category={task.category} size={13} />
        <span class="sr-only">{task.state.name}</span>
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
            >{@render marked(highlightWordRuns(task.reference ?? taskRef(task), row.matchedIn === "id" ? query : ""))} · {row.sessions.length
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
{:else if row.kind === "more"}
  <div
    class="flex h-8 items-center px-6 text-micro text-(--solus-text-tertiary)"
    {style}
    role="status"
    {@attach readsNextPage(row.remaining)}
  >
    Loading {row.remaining} more {row.remaining === 1 ? "session" : "sessions"}…
  </div>
{:else if row.kind === "record"}
  {@const isSelected = row.entryIndex === selectedIndex}
  {@const record = row.record}
  {#if record.type === "pullRequest"}
    <!-- A pull request is the row of the pull requests page itself: its state
         and conflicts, the verdict, the checks, the churn and the author. The
         pointer selects it when it moves, as it does every other row. -->
    <div {style} data-testid="picker-record-row" data-record-type="pullRequest" onpointermove={(event) => onHover(event, row)} role="presentation">
      <PickerPullRequestRow found={record.found} rowKey={row.key} selected={isSelected} onSelect={() => onActivate(row)} />
    </div>
  {:else}
    {@const updatedAt = recordTimestamp(record)}
    <!-- An action has one line; every other record has the two lines of a task
         row: its name, and under it the passage the words were found in, or
         where the record lives. -->
    <div class="relative overflow-hidden rounded-lg {record.type === 'action' ? 'h-9' : 'h-11'}" {style}>
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        data-selected={isSelected ? '' : undefined}
        data-testid="picker-record-row"
        data-record-type={record.type}
        class="menu-row group/row flex h-full w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg pr-3 pl-6 text-left data-[selected]:shadow-[shadow:inset_0_0_0_62rem_var(--solus-surface-hover)]!"
        onclick={() => onActivate(row)}
        onpointermove={(event) => onHover(event, row)}
      >
        <span class="flex size-[1.625rem] shrink-0 items-center justify-center text-(--solus-text-tertiary)">
          <PickerRecordIcon {record} size={13} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate {isSelected ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary) group-hover/row:text-(--solus-text-primary)'}"
            >{@render marked(highlightWordRuns(recordTitle(record), query))}</span
          >
          {#if record.type !== "action"}
            <span class="mt-px block truncate text-micro text-(--solus-text-tertiary)"
              >{@render marked(highlightWordRuns(row.passage ?? recordDetail(record), query))}</span
            >
          {/if}
        </span>
        {#if record.type === "action" && record.action.hint}
          <span class="shrink-0 whitespace-nowrap font-mono text-micro text-(--solus-text-tertiary)">{record.action.hint}</span>
        {:else if updatedAt}
          <span class="shrink-0 whitespace-nowrap text-micro tabular-nums text-(--solus-text-tertiary)">
            {relativeTime(updatedAt)}
          </span>
        {/if}
      </button>
    </div>
  {/if}
{:else}
  {@const isSelected = row.entryIndex === selectedIndex}
  <!-- A session, a task's or not. The same geometry as a task row: a name,
       and under it the passage the words were found in — the evidence, so the
       reader can tell the hits apart without arrowing onto each one. -->
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
      <!-- A session with a live state shows it, as a nested row does, so a
           running session reads as running in a flat list too. -->
      <span class="flex size-[1.625rem] shrink-0 items-center justify-center text-(--solus-text-tertiary)">
        {#if attention}
          <SessionStatusGlyph {attention} />
        {:else}
          <ChatsIcon size={13} />
        {/if}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate {attention === 'running' || isSelected ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary) group-hover/row:text-(--solus-text-primary)'}"
          >{@render marked(highlightWordRuns(pickerSessionTitle(row), query))}{#if row.kind === "conversation" && row.meta.shared}<span class="ml-1.5 text-micro text-(--solus-text-tertiary)" data-testid="picker-session-shared">Shared</span>{/if}{#if row.kind === "conversation" && row.meta.archived}<span class="ml-1.5 text-micro text-(--solus-text-tertiary)" data-testid="picker-session-archived">Archived</span>{/if}</span
        >
        <span class="mt-px block truncate text-micro text-(--solus-text-tertiary)"
          >{#if row.reason && row.reason.field !== "title" && row.reason.field !== "messages"}{row.reason.field === "id" ? "ID" : row.reason.field === "branch" ? "Branch" : "PR"}: {@render marked(highlightWordRuns(row.reason.text, query))}{:else if row.hit}{@render marked(snippetRuns(row.hit.snippet))}{:else}{pickerSessionProject(row)}{/if}</span
        >
      </span>
      <PresenceStack {people} size={16} max={3} />
      <!-- Its task, so two sessions with one name under two tasks can be told apart. -->
      {@render byline(pickerSessionTaskTitle(row), relativeTime(pickerSessionActivity(row)))}
    </button>
  </div>
{/if}
