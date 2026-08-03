<script lang="ts">
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { DotsThreeIcon, XIcon } from "phosphor-svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { liveActivityClock } from "../../lib/shared-clock";
  import PrChip from "./PrChip.svelte";
  import SessionNameInput from "./SessionNameInput.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";
  import TaskSubRow from "./TaskSubRow.svelte";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import {
    formatElapsed,
    hasGlyph,
    sidebarTitleNeedsEmphasis,
    trailingSlot,
    type PrChip as PrChipModel,
    type SidebarTask,
  } from "./lib/task-list";

  interface Props {
    task: SidebarTask;
    prChip: PrChipModel | null;
    /** True while the session you are reading belongs to this task. Drives the
     *  focus falloff: everything off the current path steps back. */
    onPath: boolean;
    expanded: boolean;
    /** The project name under the title — only when the list spans projects. */
    showProjectLine: boolean;
    /** Grouped rows have no disclosure column: they indent straight to the spine. */
    grouped: boolean;
    subtasks: SidebarSessionChild[];
    /** Active child only when it belongs to this task. Keeping unrelated rows
     *  at null prevents one session click from updating every child list. */
    selectedTabId: string | null;
    /** Tab whose name is being edited in place — the task's own lead session,
     *  or one of its children. Null while nothing is being renamed. */
    renamingTabId: string | null;
    onSelect: () => void;
    onRename: (tabId: string, next: string) => void;
    onRenameCancel: () => void;
    onPickProject: () => void;
    onMore: (event: MouseEvent) => void;
    onClose: () => void;
    onSelectSub: (tabId: string) => void;
    onMoreSub: (event: MouseEvent, tabId: string) => void;
    onCloseSub: (tabId: string) => void;
  }
  let {
    task,
    prChip,
    onPath,
    expanded,
    showProjectLine,
    grouped,
    subtasks,
    selectedTabId,
    renamingTabId,
    onSelect,
    onRename,
    onRenameCancel,
    onPickProject,
    onMore,
    onClose,
    onSelectSub,
    onMoreSub,
    onCloseSub,
  }: Props = $props();

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const hasSubs = $derived(subtasks.length > 1 && !grouped);
  // Hover only takes the PR chip out of the margin — that swap is CSS, so it
  // lands on the same frame as the pointer. Status and the timer stay, so
  // reaching for a row never costs you what it was reporting.
  const slot = $derived(trailingSlot(task.status, !!prChip, false));

  // With no sub-rows on screen this row *is* the session you are reading, so it
  // carries the current-session weight itself. Expanded, that weight belongs to
  // the child, and the parent only comes up out of the falloff.
  const isCurrentSession = $derived(onPath && !hasSubs);
  const titleIsEmphasized = $derived(
    isCurrentSession || sidebarTitleNeedsEmphasis(task.status, task.unread),
  );
  // The task title IS the lead session's name, so it takes the edit — unless the
  // children are showing, where that session has a row of its own to edit in.
  const renamingLead = $derived(
    renamingTabId === task.tabIds[0] && !(hasSubs && expanded),
  );

  // Ticks each second, tabular figures, so the row never reflows around it.
  let now = $state(Date.now());
  $effect(() => {
    if (slot !== "elapsed") return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });
  const elapsed = $derived(
    slot === "elapsed" && task.runStartedAt
      ? formatElapsed(now - task.runStartedAt)
      : "",
  );

  const iconButton =
    "flex size-[1.375rem] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-accent hover:text-foreground";
</script>

<!--
  Selection is carried by weight and tone alone — no plate, no rail, no colour.
  Instead the list defocuses around you: every task off the current path drops
  to 40% and comes back on hover, so the open task and its sessions are the only
  legible cluster in the column. Status marks are exempt from the falloff, which
  is what makes it safe — a request three tasks down still reaches you at full
  strength.
-->
<div class="group/task">
  <div
    class="group/row relative flex cursor-pointer items-center gap-[0.625rem] rounded pr-2 transition-[background] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-accent {grouped
      ? 'pl-9'
      : 'pl-[0.625rem]'} {showProjectLine ? 'h-[3.375rem]' : 'h-[2.625rem]'}"
    role="treeitem"
    tabindex="0"
    data-task-key={task.key}
    aria-selected={onPath}
    aria-expanded={hasSubs ? expanded : undefined}
    aria-label={hasGlyph(task.status)
      ? `${task.title} — ${attentionLabel(task.attention)}`
      : task.title}
    onclick={onSelect}
    oncontextmenu={onMore}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    }}
  >
    <span class="flex min-w-0 flex-1 flex-col">
      <!-- The one thing the eye scans. The title truncates; nothing else does. -->
      {#if renamingLead}
        <SessionNameInput
          value={task.title}
          class="text-[0.8125rem]"
          onCommit={(next) => onRename(task.tabIds[0], next)}
          onCancel={onRenameCancel}
        />
      {:else}
        <span
          class="overflow-hidden text-[0.8125rem] tracking-[-0.005em] text-ellipsis whitespace-nowrap transition-opacity duration-150 {titleIsEmphasized
            ? 'font-[560]'
            : ''} {onPath
            ? 'opacity-100'
            : 'opacity-40 group-hover/task:opacity-100'} {onPath
            ? 'text-foreground'
            : 'text-muted-foreground'}">{task.title}</span
        >
      {/if}
      {#if showProjectLine}
        <!-- Name only, and a way in: the project line filters the list to that
             project, which is the same move the breadcrumb's picker makes. -->
        <button
          class="mt-0.5 max-w-full cursor-pointer overflow-hidden text-left text-[0.6875rem] text-ellipsis whitespace-nowrap text-muted-foreground transition-[opacity,color] duration-150 hover:text-foreground {onPath
            ? 'opacity-70'
            : 'opacity-[0.28] group-hover/task:opacity-70'}"
          data-project-filter
          title="Filter by {task.projectLabel}"
          onclick={(event) => {
            event.stopPropagation();
            onPickProject();
          }}>{task.projectLabel}</button
        >
      {/if}
    </span>

    <!-- The margin carries a mark, not a sentence, and never dims. -->
    {#if slot === "pr" && prChip}
      <span class="flex shrink-0 items-center group-hover/row:hidden">
        <PrChip chip={prChip} />
      </span>
    {:else if slot === "status"}
      <TaskStatusGlyph
        status={task.status}
        label={attentionLabel(task.attention)}
      />
    {:else if slot === "elapsed" && elapsed}
      <!-- Work in flight is not an alert, so running spends a number rather
           than a glyph. -->
      <span
        class="shrink-0 font-mono text-[0.65625rem] text-muted-foreground tabular-nums transition-opacity duration-150 {onPath
          ? 'opacity-80'
          : 'opacity-35 group-hover/task:opacity-80'}">{elapsed}</span
      >
    {/if}

    <!-- Two buttons, not four: stop and mark-done moved into the overflow menu,
         where a destructive action belongs. -->
    <span class="-mr-0.5 hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
      <button
        class={iconButton}
        title="More"
        aria-label="More actions"
        onclick={(event) => {
          event.stopPropagation();
          onMore(event);
        }}
      >
        <DotsThreeIcon size={13} weight="bold" />
      </button>
      <button
        class={iconButton}
        title="Close task"
        aria-label="Close task"
        onclick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <XIcon size={12} weight="bold" />
      </button>
    </span>
  </div>

  {#if hasSubs && expanded}
    <div
      class="relative flex flex-col gap-0.5 pt-px pb-2"
      transition:slide={{ duration: reduceMotion ? 0 : 160, easing: cubicOut }}
    >
      <!-- The spine runs down the title column, and stops short of the last
           row's baseline so the tree reads as ending rather than running off. -->
      <span
        class="absolute top-0 bottom-[1.5625rem] left-2.5 w-px bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]"
      ></span>
      {#each subtasks as sub (sub.tabId)}
        <TaskSubRow
          child={sub}
          {onPath}
          renaming={renamingTabId === sub.tabId}
          selected={sub.tabId === selectedTabId}
          onRename={(next) => onRename(sub.tabId, next)}
          {onRenameCancel}
          onSelect={() => onSelectSub(sub.tabId)}
          onMore={(event) => onMoreSub(event, sub.tabId)}
          onClose={() => onCloseSub(sub.tabId)}
        />
      {/each}
    </div>
  {/if}
</div>
