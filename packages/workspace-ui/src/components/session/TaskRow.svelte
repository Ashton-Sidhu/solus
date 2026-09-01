<script lang="ts">
  import {
    Undo2 as ArrowUUpLeftIcon,
    AlarmClock as AlarmIcon,
    Check as CheckIcon,
    Laptop as LaptopIcon,
    Moon as MoonIcon,
    Sun as SunIcon,
    LoaderCircle as SpinnerGapIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { shouldActivateRenameableRow } from "../../lib/rename-input";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import ReviewGuideGlyph from "../review/ReviewGuideGlyph.svelte";
  import PrChip from "./PrChip.svelte";
  import SessionNameInput from "./SessionNameInput.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";
  import TaskSessionRow from "./TaskSessionRow.svelte";
  import UnreadDot from "./UnreadDot.svelte";
  import SessionSidebarTooltip from "./SessionSidebarTooltip.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import {
    aggregateReviewGuideStatus,
    hasDisclosure,
    resolveSidebarRowMark,
    taskRowBranchName,
    shouldEmphasizeTitle,
    shouldRecedeRow,
    type PrChip as PrChipModel,
    type TaskPrChoice,
    type SidebarTask,
  } from "./lib/task-list";

  interface Props {
    task: SidebarTask;
    prChip: PrChipModel | null;
    prChoices: TaskPrChoice[];
    /** True while the session you are reading belongs to this task. The active
     *  task leads with full ink and weight; the rest rest at a legible tone. */
    onPath: boolean;
    bulkSelected?: boolean;
    expanded: boolean;
    sessions: SidebarSessionChild[];
    /** Active session only when it belongs to this task. Keeping unrelated rows
     *  at null prevents one click from updating every session list. */
    selectedTabId: string | null;
    /** Tab whose session name is being edited in place. */
    renamingTabId: string | null;
    /** The same for rows the task store backs, which are named by the task
     *  rather than by whichever session happens to be open under them. */
    renamingTaskId: string | null;
    onSelect: (event?: MouseEvent) => void;
    /** Rename a row in place. `null` names the task row itself, matching
     *  `onRename` — a task row is named by its task, a session row by its tab. */
    onStartRename: (session: SidebarSessionChild | null) => void;
    onRename: (session: SidebarSessionChild | null, next: string) => void;
    onRenameCancel: () => void;
    onMore: (event: MouseEvent | PointerEvent) => void;
    /** The snooze menu drops from the button that opened it. */
    onSnooze: (anchor: HTMLElement) => void;
    /** Return a snoozed task to the active session list immediately. */
    onWake: () => void;
    onComplete: () => void;
    onClose: () => void;
    onOpenPr: (choice: TaskPrChoice) => void;
    onSelectSession: (session: SidebarSessionChild) => void;
    onMoreSession: (event: MouseEvent, session: SidebarSessionChild) => void;
    onSnoozeSession: (session: SidebarSessionChild, anchor: HTMLElement) => void;
    onCompleteSession: (session: SidebarSessionChild) => void;
    onCloseSession: (session: SidebarSessionChild) => void;
  }
  let {
    task,
    prChip,
    prChoices,
    onPath,
    bulkSelected = false,
    expanded,
    sessions,
    selectedTabId,
    renamingTabId,
    renamingTaskId,
    onSelect,
    onStartRename,
    onRename,
    onRenameCancel,
    onMore,
    onSnooze,
    onWake,
    onComplete,
    onClose,
    onOpenPr,
    onSelectSession,
    onMoreSession,
    onSnoozeSession,
    onCompleteSession,
    onCloseSession,
  }: Props = $props();

  // A row on a quiet shelf collapses to a single line. Snoozed and completed
  // work is deliberately out of the way, and a full-height card spends the same
  // vertical budget on it as on the work you are actually doing — which is what
  // made the column read as a wall. The slim row keeps every affordance; it
  // just stops claiming the space of live work.
  const isSlim = $derived(task.lifecycle !== "active");
  const hasSessions = $derived(task.taskId ? sessions.length > 0 : false);
  /** Whether the row opens onto anything — and therefore whether it spends a
   *  disclosure mark. A lone session of the task itself is already this row. */
  const disclosable = $derived(
    !isSlim && hasSessions && hasDisclosure(sessions),
  );
  const reviewGuideStatus = $derived(aggregateReviewGuideStatus(sessions));

  // Which branch or worktree the work sits on. The row itself stays as it is;
  // the tooltip is where the answer belongs.
  const branchName = $derived(taskRowBranchName(task.branchName, sessions));

  // Which machine, on the same rule as the elapsed readout: with one session
  // under the task there is a single answer and the row states it, so you never
  // have to expand a one-session task to learn where it runs. Several sessions
  // can sit on different hosts, and no single mark is true of all of them — so
  // the question moves down to the rows that can each answer it.
  const showsHost = $derived(sessions.length <= 1);
  const host = $derived(serversStore.hostFor(task.serverId));
  // A task with no server on it has nothing open, and nothing open runs here.
  const isRemote = $derived(!!host && !host.local);
  // A host Solus no longer has a saved entry for names no operating system;
  // the icon falls back to a globe in that case.
  const remoteOs = $derived(host && "os" in host ? host.os : undefined);

  // With no session rows on screen this row stands in for the session you are
  // reading, so it carries the current-session weight and terracotta clock
  // itself. Two ways that happens: the task discloses nothing (a lone plain
  // session *is* this row), or it discloses but sits collapsed — a minimized
  // task must still say that the session you are reading is one of its own,
  // since the child row that would otherwise say so is not on screen.
  const isCurrentSession = $derived(onPath && (!disclosable || !expanded));
  const titleIsEmphasized = $derived(
    shouldEmphasizeTitle(task.status, task.unread, isCurrentSession),
  );
  // Ink is now the row's property, not the title's: the whole row recedes or
  // does not, and the trailing mark keeps its own colour either way.
  const recedes = $derived(
    shouldRecedeRow(task.status, task.unread, task.woke, onPath),
  );

  const runningSessionCount = $derived(
    sessions.filter((session) => session.attention === "running").length,
  );

  // Ticks each second, tabular figures, so the row never reflows around it.
  // Both shelves report an age or a countdown, so they tick too.
  let now = $state(Date.now());
  $effect(() => {
    if (task.status !== "running" && task.lifecycle === "active") return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  const mark = $derived(
    resolveSidebarRowMark({
      status: task.status,
      unread: task.unread,
      woke: task.woke,
      reviewGuide: reviewGuideStatus,
      lifecycle: task.lifecycle,
      runStartedAt: task.runStartedAt,
      manyRunning: runningSessionCount > 1,
      completedAt: task.completedAt,
      snoozedUntil: task.snoozedUntil,
      now,
    }),
  );

  // A durable row is named by its task; a loose row is named by its only tab.
  const renamingLead = $derived(
    task.taskId
      ? renamingTaskId === task.taskId
      : !!task.tabIds[0] &&
          renamingTabId === task.tabIds[0] &&
          !(hasSessions && expanded),
  );

  // Where the accent spine stops. The path is "task → … → the session you are
  //  reading", so every row down to and including the selected one carries it —
  //  which each row can draw for itself once it knows it is on the path, with no
  //  arithmetic over row heights or gaps here.
  const selectedIndex = $derived(
    sessions.findIndex(
      (child) => !!child.tabId && child.tabId === selectedTabId,
    ),
  );

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressNextClick = false;
  function startLongPress(event: PointerEvent) {
    if (event.pointerType !== "touch") return;
    longPressTimer = setTimeout(() => {
      suppressNextClick = true;
      onMore(event);
    }, 500);
  }
  function cancelLongPress() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  }
</script>

<!--
  The one mark the row spends. Every colour here is declared on the mark itself,
  so it survives the row's recession: a column of receding rows still shows its
  few saturated marks at full strength, which is the whole point of receding.
-->
{#snippet stateMark()}
  {#if mark?.kind === "glyph"}
    <TaskStatusGlyph
      status={mark.status}
      label={attentionLabel(task.attention)}
    />
  {:else if mark?.kind === "woke"}
    <span
      class="flex shrink-0 items-center text-[color-mix(in_oklch,var(--primary)_72%,var(--foreground))]"
      role="img"
      aria-label="Snooze reminder"
      title="Snooze reminder"
    >
      <AlarmIcon size={14} />
    </span>
  {:else if mark?.kind === "unread"}
    <UnreadDot />
  {:else if mark?.kind === "guide"}
    <!-- Generating and ready are one object at two stages, so the mark keeps
         its silhouette and only gains ink: an outline guide that breathes while
         it is written, filled once it can be read. Writing one is work in
         flight, so it shares the pane's one cool tone with the run spinner. -->
    <span
      class="flex shrink-0 items-center {mark.state === 'ready'
        ? 'text-(--solus-status-complete)'
        : 'text-chart-5'}"
      role="img"
      aria-label={mark.state === "ready"
        ? "Review guide ready"
        : "Generating review guide"}
      title={mark.state === "ready"
        ? "Review guide ready"
        : "Generating review guide"}
    >
      <ReviewGuideGlyph
        size={15}
        weight={mark.state === "ready" ? "fill" : undefined}
        class={mark.state === "ready"
          ? ""
          : "animate-pulse [animation-duration:1.4s] motion-reduce:animate-none"}
      />
    </span>
  {:else if mark?.kind === "spinner"}
    <!-- Work in flight and work finished are the same axis, so they share a
         colour: the pane's one cool tone, which terracotta is never spent on.
         The spinner is that dot still turning. -->
    <span
      class="flex shrink-0 items-center text-chart-5"
      role="img"
      aria-label={attentionLabel(task.attention)}
    >
      <SpinnerGapIcon size={14} class="animate-spin" />
    </span>
  {:else if mark?.kind === "elapsed"}
    <!-- One session running, so running spends a number rather than a glyph.
         The clock separates on ink and weight, not hue: the row you are reading
         states its time in full ink, the rest sit back at half. Terracotta is
         spent on the selected elbow alone, so the clock never competes with the
         green a pull request chip puts on the same row. -->
    <span
      class="shrink-0 text-chrome-shelf tabular-nums {isCurrentSession
        ? 'font-medium text-foreground'
        : 'text-[color-mix(in_oklch,var(--foreground)_45%,transparent)]'}"
      >{mark.label}</span
    >
  {:else if mark?.kind === "wake"}
    <!-- The same blue the Snoozed shelf header uses, so a sleeping row and the
         shelf holding it read as one thing. -->
    <span
      class="shrink-0 text-chrome-shelf tabular-nums text-(--solus-status-unread)"
      title={`Wakes ${new Date(task.snoozedUntil).toLocaleString()}`}
      >{mark.label}</span
    >
  {:else if mark?.kind === "age"}
    <span
      class="shrink-0 text-chrome-shelf tabular-nums text-muted-foreground"
      title={`Completed ${new Date(task.completedAt).toLocaleString()}`}
      >{mark.label}</span
    >
  {/if}
{/snippet}

<!--
  Status at rest, actions on hover — in the *same* slot, cross-faded rather than
  appended. Three 24px buttons arriving beside the title used to take 72px out
  of it, so the title collapsed the moment a pointer crossed the row. Here the
  only thing that yields width is the mark the actions replace.

  Touch has no hover to swap on, so a coarse pointer keeps both: the mark holds
  its place and the actions simply stand beside it, exactly as before.
-->
{#snippet trailingSlot()}
  <!-- The slot reserves its column only while it holds a mark. Reserved-when-
       empty, it would take 28px and a gap out of the project line on every
       quiet row — and the actions cost nothing at rest, because they are out of
       flow until the pointer arrives. -->
  <span
    class="relative ml-auto flex h-5 shrink-0 items-center justify-end {mark
      ? 'min-w-[1.75rem]'
      : ''}"
  >
    <span
      class="flex items-center transition-opacity duration-150 pointer-fine:group-hover/row:absolute pointer-fine:group-hover/row:right-0 pointer-fine:group-hover/row:opacity-0 pointer-fine:group-has-[:focus-visible]/row:absolute pointer-fine:group-has-[:focus-visible]/row:right-0 pointer-fine:group-has-[:focus-visible]/row:opacity-0"
    >
      {@render stateMark()}
    </span>

    <!-- A task with nothing open still owns its name and completion state, so
         completion and overflow remain available. The check finishes the task;
         the cross only removes the row from this client's sidebar. -->
    {#if task.tabIds[0] || task.taskId}
      <span
        class="pointer-events-none absolute inset-y-0 right-0 -mr-1 flex items-center gap-px opacity-0 transition-opacity duration-150 pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100 pointer-fine:group-hover/row:pointer-events-auto pointer-fine:group-hover/row:static pointer-fine:group-hover/row:opacity-100 pointer-fine:group-has-[:focus-visible]/row:pointer-events-auto pointer-fine:group-has-[:focus-visible]/row:static pointer-fine:group-has-[:focus-visible]/row:opacity-100"
      >
        <!-- Reversible first, destructive last, so the pointer never lands on
             remove while aiming for the lifecycle action. Snooze is the one of
             the three a narrow column can drop: it is a move you make on a row
             you are leaving alone, and it stays on the context menu with the
             rest of the task's lifecycle. Wake is not — it is a snoozed row's
             only way back, so it holds at every width. -->
        {#if task.status !== "done" && task.status !== "dropped"}
          {#if task.lifecycle === "snoozed"}
            <button
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
              title="Wake now"
              aria-label="Wake task now"
              onclick={(event) => {
                event.stopPropagation();
                onWake();
              }}
            >
              <SunIcon size={14} />
            </button>
          {:else}
            <button
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground @max-[15rem]:hidden"
              title="Snooze"
              aria-label="Snooze task"
              onclick={(event) => {
                event.stopPropagation();
                onSnooze(event.currentTarget);
              }}
            >
              <MoonIcon size={14} />
            </button>
          {/if}
        {/if}
        <button
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
          title={task.status === "done" ? "Reopen task" : "Mark task completed"}
          aria-label={task.status === "done" ? "Reopen task" : "Mark task completed"}
          onclick={(event) => {
            event.stopPropagation();
            onComplete();
          }}
        >
          {#if task.status === "done"}
            <ArrowUUpLeftIcon size={14} weight="bold" />
          {:else}
            <CheckIcon size={14} weight="bold" />
          {/if}
        </button>
        <!-- Close takes a row out of the working column. A finished row is not
             in the working column any more — the shelf lists it from the task
             store and retention decides when it goes — so on the shelf the
             control only earns its place while there are still tabs to unload.
             Otherwise it would be a button that visibly does nothing. -->
        {#if task.tabIds.length > 0 || (task.taskId && task.lifecycle !== "completed")}
          <button
            class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
            title="Remove from sidebar"
            aria-label={task.taskId ? "Remove task from sidebar" : "Remove session from sidebar"}
            onclick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <XIcon size={14} weight="bold" />
          </button>
        {/if}
      </span>
    {/if}
  </span>
{/snippet}

<!-- The one thing the eye scans. The title truncates; nothing else does, and
     nothing else shares its line except the PR token that navigates away from
     it. Colour is inherited from the row, so a receding row's title recedes
     with it rather than being tuned against it. -->
{#snippet rowTitle()}
  {#if renamingLead}
    <SessionNameInput
      value={task.title}
      class="text-workspace-chrome {titleIsEmphasized ? 'font-medium' : ''}"
      onCommit={(next) => onRename(null, next)}
      onCancel={onRenameCancel}
    />
  {:else}
    <span
      class="min-w-0 flex-1 overflow-hidden text-workspace-chrome text-ellipsis whitespace-nowrap {titleIsEmphasized
        ? 'font-medium'
        : ''}">{task.title}</span
    >
  {/if}
{/snippet}

<!--
  Selection is carried by weight and tone alone — no plate, no rail, no colour.
  The active task and anything asking for a person lead in full ink at a heavier
  weight; every other row recedes as a whole to the secondary tone, still plainly
  legible rather than faded out. The hierarchy is a difference in emphasis,
  never a wall between "readable" and "invisible".
-->
<div class="group/task">
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
  <div
    {...tooltipProps}
    class="group/row relative -mx-2 flex cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.625rem] transition-[background,color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] {bulkSelected
 ? 'bg-[color-mix(in_oklch,var(--primary)_9%,transparent)]'
 : ''} {isSlim ? 'h-[2.25rem]' : 'h-[3.875rem]'} {recedes
 ? 'text-[color-mix(in_oklch,var(--solus-text-secondary)_75%,transparent)] hover:text-foreground'
 : 'text-foreground'}"
    role="treeitem"
    tabindex="0"
    data-task-key={task.key}
    aria-selected={onPath}
    aria-expanded={disclosable ? expanded : undefined}
    aria-label={mark?.kind === "glyph"
      ? `${task.title} — ${attentionLabel(task.attention)}`
      : task.title}
    title={task.snoozeNote && task.snoozedUntil > 0 && task.snoozedUntil <= Date.now()
      ? `Snooze reminder: ${task.snoozeNote}`
      : task.lifecycle === "snoozed" && task.snoozeNote
        ? task.snoozeNote
        : undefined}
    onclick={(event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault();
        return;
      }
      if (!shouldActivateRenameableRow(event.detail)) return;
      onSelect(event);
    }}
    ondblclick={() => onStartRename(null)}
    oncontextmenu={onMore}
    onpointerdown={startLongPress}
    onpointerup={cancelLongPress}
    onpointercancel={cancelLongPress}
    onpointermove={cancelLongPress}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    }}
  >
    {#if isSlim}
      <!-- One line, and the project mark stands in for the project name it no
           longer has room to spell. Shelved history recedes further than a live
           row does: the mark greys out at rest and comes back on hover, so the
           tail stays scannable when you are hunting through it. -->
      <span
        class="flex size-4 shrink-0 items-center justify-center transition-[filter,opacity] duration-150 {onPath
          ? ''
          : 'opacity-45 grayscale group-hover/row:opacity-100 group-hover/row:grayscale-0'}"
        aria-hidden="true"
      >
        <ProjectFavicon
          projectRoot={task.projectKey}
          serverId={task.serverId}
          class="size-4 pointer-fine:[.is-laptop-display_&]:[&_svg]:size-3.5"
        />
      </span>
      {@render rowTitle()}
      {#if prChip}
        <span
          class="flex shrink-0 items-center transition-opacity duration-150 {recedes
            ? 'opacity-75 group-hover/row:opacity-100'
            : ''}"
        >
          <PrChip chip={prChip} choices={prChoices} onOpen={onOpenPr} />
        </span>
      {/if}
      {@render trailingSlot()}
    {:else}
      <span class="flex min-w-0 flex-1 flex-col">
        <!-- Where the row's work lives, and what it is doing. Both are facts
             *about* the title rather than the title itself, so they share the
             supporting line and leave the name below them alone. This line is
             also what pays for the hover actions: the slot on its right is the
             only thing that yields width when they arrive. -->
        <span
          class="flex h-[1.0625rem] min-w-0 items-center gap-[0.375rem] text-xs @max-[15rem]:gap-1"
        >
          <!-- The context cluster carries its own step down in ink, so it stays
               a supporting detail on a row at full strength and recedes twice
               over on a row that is already quiet. The trailing slot sits
               outside it: a mark that dimmed with the row could not be the one
               thing the row still says at full strength. -->
          <span
            class="flex min-w-0 flex-1 items-center gap-[0.375rem] opacity-70 @max-[15rem]:gap-1"
          >
            <!-- The project's own mark identifies it faster than its name does.
                 The band above already names the project while the list is
                 scoped. -->
            <ProjectFavicon
              projectRoot={task.projectKey}
              serverId={task.serverId}
              class="size-4 shrink-0 @max-[15rem]:size-[0.875rem] pointer-fine:[.is-laptop-display_&]:[&_svg]:size-3.5"
            />
            <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              >{task.projectLabel}</span
            >
            {#if showsHost}
              <!-- The dot and the "runs here" mark are the first things a
                   narrow column can spend: the separator is pure decoration,
                   and local is the default every row would otherwise repeat.
                   Both stay in the row's tooltip, and a remote host — the
                   answer worth interrupting a name for — keeps its operating
                   system mark at every width. -->
              <span class="shrink-0 @max-[15rem]:hidden">·</span>
              {#if isRemote}
                <HostOperatingSystemIcon
                  os={remoteOs}
                  size={14}
                  class="shrink-0"
                  aria-label={host?.label}
                />
              {:else}
                <LaptopIcon
                  size={14}
                  class="shrink-0 @max-[15rem]:hidden"
                  aria-label="Local"
                />
              {/if}
            {/if}
          </span>
          {@render trailingSlot()}
        </span>

        <!-- The title owns its own line. The height is pinned to the title's
             line box so the rename wash cannot push the line above it around.

             8px, against the 21px that separates one row from the next — 9px of
             this row's slack, the list's 3px gap, 9px of the next row's. That
             ratio is the only thing binding the context line above to this
             title rather than to the title of the row above it, because the row
             carries no plate to group them; the row grew to 62px so widening
             the gap does not spend that ratio.

             The gap is also clearance. The hover actions are 24px buttons on a
             17px line, so they hang 3.5px below it, and the pull request chip
             carries a hit target taller than its own text. At 4px the two
             overlapped, and a click aimed at close or complete opened the pull
             request instead. -->
        <span
          class="mt-2 flex h-[1.1875rem] items-center gap-[0.5625rem] @max-[15rem]:gap-1.5"
        >
          {@render rowTitle()}
          {#if prChip}
            <!-- The one thing that shares the title's line, because it is the
                 only mark that is navigation rather than state. -->
            <span
              class="flex shrink-0 items-center transition-opacity duration-150 {recedes
                ? 'opacity-75 group-hover/row:opacity-100'
                : ''}"
            >
              <PrChip chip={prChip} choices={prChoices} onOpen={onOpenPr} />
            </span>
          {/if}
        </span>
      </span>
    {/if}
  </div>
      {/snippet}
    </TooltipUI.Trigger>
    <SessionSidebarTooltip
      title={task.title}
      projectKey={task.projectKey}
      projectLabel={task.projectLabel}
      {branchName}
      serverId={task.serverId}
      attention={task.attention}
      {reviewGuideStatus}
    />
  </TooltipUI.Root>

  {#if disclosable && expanded}
    <div class="relative flex flex-col gap-[0.1875rem] pt-px pb-2">
      <!-- The spine drops out of the title above and stops on the last row's
           own elbow, so the tree reads as ending rather than running off.
           1.375rem is that elbow measured from the bottom: a 2.875rem child
           whose title line centres at 2rem leaves 0.875rem below it, plus this
           container's own 0.5rem of bottom padding. It is the same measurement
           `TaskSessionRow` draws the elbow from, so moving the title moves
           both. -->
      <span
        class="absolute top-0 bottom-[1.375rem] left-2.5 w-px bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
      ></span>
      {#each sessions as session, index (session.sessionId ?? session.tabId ?? session.taskId)}
        <TaskSessionRow
          {session}
          projectLabel={task.projectLabel}
          leadsToSelection={selectedIndex >= 0 && index <= selectedIndex}
          renaming={!!session.tabId && renamingTabId === session.tabId}
          selected={!!session.tabId && session.tabId === selectedTabId}
          onRename={(next) => onRename(session, next)}
          {onRenameCancel}
          onStartRename={() => onStartRename(session)}
          onSelect={() => onSelectSession(session)}
          onMore={(event) => onMoreSession(event, session)}
          onSnooze={(anchor) => onSnoozeSession(session, anchor)}
          onComplete={session.isSubtask
            ? () => onCompleteSession(session)
            : undefined}
          onClose={() => onCloseSession(session)}
        />
      {/each}
    </div>
  {/if}
</div>
