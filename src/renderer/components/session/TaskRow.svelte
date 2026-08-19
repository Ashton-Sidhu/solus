<script lang="ts">
  import {
    ArrowUUpLeftIcon,
    AlarmIcon,
    CheckIcon,
    LaptopIcon,
    MoonIcon,
    SunIcon,
    SpinnerGapIcon,
    XIcon,
  } from "phosphor-svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
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
    formatElapsed,
    formatCompletedAge,
    aggregateReviewGuideStatus,
    hasDisclosure,
    hasGlyph,
    showsUnreadIndicator,
    type PrChip as PrChipModel,
    type SidebarTask,
  } from "./lib/task-list";

  interface Props {
    task: SidebarTask;
    prChip: PrChipModel | null;
    /** True while the session you are reading belongs to this task. The active
     *  task leads with full ink and weight; the rest rest at a legible tone. */
    onPath: boolean;
    bulkSelected?: boolean;
    expanded: boolean;
    /** Scope the whole column to this row's project. */
    onFilterProject: () => void;
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
    onRename: (session: SidebarSessionChild | null, next: string) => void;
    onRenameCancel: () => void;
    onMore: (event: MouseEvent | PointerEvent) => void;
    /** The snooze menu drops from the button that opened it. */
    onSnooze: (anchor: HTMLElement) => void;
    /** Return a snoozed task to the active session list immediately. */
    onWake: () => void;
    onComplete: () => void;
    onClose: () => void;
    onOpenPr: () => void;
    onSelectSession: (session: SidebarSessionChild) => void;
    onMoreSession: (event: MouseEvent, session: SidebarSessionChild) => void;
    onSnoozeSession: (session: SidebarSessionChild, anchor: HTMLElement) => void;
    onCompleteSession: (session: SidebarSessionChild) => void;
    onCloseSession: (session: SidebarSessionChild) => void;
  }
  let {
    task,
    prChip,
    onPath,
    bulkSelected = false,
    expanded,
    onFilterProject,
    sessions,
    selectedTabId,
    renamingTabId,
    renamingTaskId,
    onSelect,
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

  const hasSessions = $derived(task.taskId ? sessions.length > 0 : false);
  const isCompleted = $derived(task.lifecycle === "completed");
  /** Whether the row opens onto anything — and therefore whether it spends a
   *  disclosure mark. A lone session of the task itself is already this row. */
  const disclosable = $derived(
    !isCompleted && hasSessions && hasDisclosure(sessions),
  );
  const reviewGuideStatus = $derived(aggregateReviewGuideStatus(sessions));

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
    isCurrentSession || hasGlyph(task.status),
  );
  // Full ink for the active row and anything asking for a person; every other
  // title still reads clearly at the secondary tone rather than fading out.
  const titleLeads = $derived(onPath || titleIsEmphasized);
  // A durable row is named by its task; a loose row is named by its only tab.
  const renamingLead = $derived(
    task.taskId
      ? renamingTaskId === task.taskId
      : !!task.tabIds[0] &&
          renamingTabId === task.tabIds[0] &&
          !(hasSessions && expanded),
  );

  // Session output can be unread while its durable task remains in progress.
  // The row's task lifecycle must not suppress that session state.
  const isRunning = $derived(task.status === "running");
  const showsUnreadDot = $derived(
    showsUnreadIndicator(task.status, task.unread),
  );

  // A number can only date one turn. Once several sessions are running *at
  // once* there is no single clock to report, so the row says *that* work is in
  // flight and leaves the durations to the session rows that own them. A task
  // with many sessions but only one of them running still has one datable turn,
  // so it keeps the number rather than hiding it behind a spinner.
  const runningSessionCount = $derived(
    sessions.filter((session) => session.attention === "running").length,
  );
  // If a reconnect has no reliable start time, show motion instead of leaving a
  // running row blank. This is a display fallback, not a lifecycle inference.
  const spinning = $derived(
    isRunning &&
      !showsUnreadDot &&
      (runningSessionCount > 1 || !task.runStartedAt),
  );

  // Ticks each second, tabular figures, so the row never reflows around it.
  let now = $state(Date.now());
  $effect(() => {
    if ((!isRunning || showsUnreadDot || spinning) && !isCompleted) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });
  const elapsed = $derived(
    isRunning && !showsUnreadDot && !spinning && task.runStartedAt
      ? formatElapsed(now - task.runStartedAt)
      : "",
  );
  const completedAge = $derived(
    isCompleted ? formatCompletedAge(task.completedAt, now) : "",
  );
  const snoozeReturn = $derived.by(() => {
    if (task.lifecycle !== "snoozed" || !task.snoozedUntil) return "";
    const date = new Date(task.snoozedUntil);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return new Intl.DateTimeFormat(undefined, sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
  });

  const showsMargin = $derived(
    isCompleted
      ? !!completedAge
      : reviewGuideStatus === "generating" ||
          reviewGuideStatus === "ready" ||
          hasGlyph(task.status) ||
          spinning ||
          !!elapsed ||
          showsUnreadDot ||
          task.woke ||
          !!snoozeReturn,
  );
  // A completed row drops its second line; every other row keeps the project
  // it belongs to, filtered or not. The column must not change shape under a
  // scope — a row you learned the size of has to still be that size.
  const showsBottomRow = $derived(!isCompleted);

  // Where the accent spine stops. The path is "task → … → the session you are
  //  reading", so every row down to and including the selected one carries it —
  //  which each row can draw for itself once it knows it is on the path, with no
  //  arithmetic over row heights or gaps here.
  const selectedIndex = $derived(
    sessions.findIndex(
      (child) => !!child.tabId && child.tabId === selectedTabId,
    ),
  );

  const iconButton =
    "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground";
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
  Selection is carried by weight and tone alone — no plate, no rail, no colour.
  The active task and anything asking for a person lead in full ink at a heavier
  weight; every other title rests one step down at the secondary tone, still
  plainly legible rather than faded out. The hierarchy is a difference in
  emphasis, never a wall between "readable" and "invisible".
-->
<div class="group/task">
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
  <div
    {...tooltipProps}
    class="group/row relative -mx-2 flex cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.625rem] transition-[background] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] {bulkSelected ? 'bg-[color-mix(in_oklch,var(--primary)_9%,transparent)]' : ''} {showsBottomRow ? 'h-[3.5rem]' : 'h-[2.125rem]'}"
    role="treeitem"
    tabindex="0"
    data-task-key={task.key}
    aria-selected={onPath}
    aria-expanded={disclosable ? expanded : undefined}
    aria-label={hasGlyph(task.status)
      ? `${task.title} — ${attentionLabel(task.attention)}`
      : task.title}
    title={task.lifecycle === "snoozed"
      ? `Snoozed until ${new Date(task.snoozedUntil).toLocaleString()}${task.snoozeNote ? ` — ${task.snoozeNote}` : ""}`
      : task.snoozeNote && task.snoozedUntil > 0 && task.snoozedUntil <= Date.now()
        ? `Snooze reminder: ${task.snoozeNote}`
        : undefined}
    onclick={(event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        event.preventDefault();
        return;
      }
      onSelect(event);
    }}
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
    <!-- Completed tasks keep their project mark. Open task titles all start on
         the same left edge; row activation and the tree keyboard controls still
         expand subtasks without a standing count or disclosure chevron. -->
    {#if isCompleted}
      <span
        class="-mr-[0.375rem] flex size-4 shrink-0 items-center justify-center text-(--solus-text-tertiary) {showsBottomRow
 ? 'mt-2 self-start'
 : ''}"
        aria-hidden="true"
      >
        <ProjectFavicon projectRoot={task.projectKey} class="size-4" />
      </span>
    {/if}

    <span class="flex min-w-0 flex-1 flex-col">
      <!-- The title and every mark that reports on it share one line box. On a
           two-line row, marks centred against the row would sit between the
           title they speak for and the project line below, belonging to
           neither; sitting *in* the title's line keeps them on it with no
           hand-tuned offset to drift out of date. The box is pinned to the
           title's own line height so a taller mark (a 24px action button)
           overflows it symmetrically rather than pushing the project line down —
           the rename wash included, which is why the height holds while
           renaming rather than being handed to the input. -->
      <span class="flex h-[1.1875rem] items-center gap-[0.5625rem] @max-[15rem]:gap-1.5">
        <!-- The one thing the eye scans. The title truncates; nothing else does. -->
        {#if renamingLead}
          <SessionNameInput
            value={task.title}
            class="text-workspace-chrome {titleIsEmphasized
 ? 'font-medium'
 : ''}"
            onCommit={(next) => onRename(null, next)}
            onCancel={onRenameCancel}
          />
        {:else}
          <span
            class="min-w-0 flex-1 overflow-hidden text-workspace-chrome text-ellipsis whitespace-nowrap transition-colors duration-150 {titleIsEmphasized
 ? 'font-medium'
 : ''} {titleLeads
 ? 'text-foreground'
 : 'text-(--solus-text-secondary)'}">{task.title}</span
          >
        {/if}

        <!-- The margin carries live task state, not standing navigation. -->
        {#if showsMargin}
          <span class="ml-auto flex shrink-0 items-center gap-[0.5625rem] @max-[15rem]:gap-1.5">
            {#if completedAge}
              <span
                class="shrink-0 text-chrome-shelf text-muted-foreground tabular-nums"
                title={`Completed ${new Date(task.completedAt).toLocaleString()}`}
                >{completedAge}</span
              >
            {/if}
            {#if reviewGuideStatus === "generating"}
              <!-- Writing a guide is work in flight, so it shares the cool tone
                   the run spinner below already spends on that. -->
              <span
                class="flex shrink-0 items-center text-chart-5"
                role="img"
                aria-label="Generating review guide"
                title="Generating review guide"
              >
                <ReviewGuideGlyph
                  size={15}
                  class="animate-pulse [animation-duration:1.4s] motion-reduce:animate-none"
                />
              </span>
            {:else if reviewGuideStatus === "ready"}
              <span
                class="flex shrink-0 items-center text-(--solus-status-complete)"
                role="img"
                aria-label="Review guide ready"
                title="Review guide ready"
              >
                <ReviewGuideGlyph size={15} weight="fill" />
              </span>
            {/if}
            {#if task.woke}
              <span
                class="flex shrink-0 items-center text-[color-mix(in_oklch,var(--primary)_72%,var(--foreground))]"
                role="img"
                aria-label="Snooze reminder"
                title="Snooze reminder"
              >
                <AlarmIcon size={14} />
              </span>
            {/if}
            {#if snoozeReturn}
              <span class="shrink-0 text-chrome-shelf tabular-nums text-muted-foreground"
                >{snoozeReturn}</span
              >
            {/if}
            <!-- State marks vary slightly in silhouette and optical size, but
                 their centres share one column down the tree. -->
            {#if showsUnreadDot || hasGlyph(task.status) || spinning || elapsed}
            <span
              class="flex min-w-[0.875rem] shrink-0 items-center justify-center"
            >
              {#if showsUnreadDot}
                <UnreadDot />
              {:else if hasGlyph(task.status)}
                <TaskStatusGlyph
                  status={task.status}
                  label={attentionLabel(task.attention)}
                />
              {:else if spinning}
                <!-- Work in flight and work finished are the same axis, so they
                     share a colour: the pane's one cool tone, which terracotta is
                     never spent on. The spinner is that dot still turning. -->
                <span
                  class="flex shrink-0 items-center text-chart-5"
                  role="img"
                  aria-label={attentionLabel(task.attention)}
                >
                  <SpinnerGapIcon size={14} class="animate-spin" />
                </span>
              {:else if elapsed}
                <!-- One session running, so running spends a number rather than a
                     glyph. When that session is the one you are reading, the
                     clock joins the selected elbow in terracotta — the same rule
                     one level down. -->
                <span
                  class="shrink-0 text-chrome-shelf tabular-nums {isCurrentSession
 ? 'text-[color-mix(in_oklch,var(--primary)_68%,var(--foreground))]'
 : 'text-[color-mix(in_oklch,var(--foreground)_64%,transparent)]'}">{elapsed}</span
                >
              {/if}
            </span>
            {/if}
          </span>
        {/if}

        <!-- A task with nothing open still owns its name and completion state,
             so completion and overflow remain available. The check finishes the
             task; the cross closes it as work that will not be done. A loose
             session has no task to close, so its cross only unloads it. -->
        {#if task.tabIds[0] || task.taskId}
          <span
            class="-mr-1 hidden shrink-0 items-center gap-px group-hover/row:flex group-focus-within/row:flex pointer-coarse:flex"
          >
            <!-- Reversible first, destructive last, so the pointer never lands
                 on remove while aiming for the lifecycle action.

                 Three 24px buttons appearing on hover take 72px out of the
                 title on a narrow column, so the title collapses the moment a
                 pointer crosses the row. Snooze is the one of the three the
                 narrow column can drop: it is a move you make on a row you are
                 leaving alone, and it stays on the context menu with the rest
                 of the task's lifecycle. Wake is not — it is a snoozed row's
                 only way back, so it holds at every width. -->
            {#if task.status !== "done" && task.status !== "dropped"}
              {#if task.lifecycle === "snoozed"}
                <button
                  class={iconButton}
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
                  class="{iconButton} @max-[15rem]:hidden"
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
              class={iconButton}
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
            {#if task.tabIds.length > 0 || task.taskId}
              <button
                class={iconButton}
                title={task.taskId ? "Close task" : "Close session"}
                aria-label={task.taskId ? "Close task" : "Close session"}
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
      {#if showsBottomRow}
        <!-- Narrow columns pay for the same line twice: a long project name
             truncates to nothing *and* the type stays at full size beside it.
             One step down in size and gap buys the name back several
             characters, which is what the line is for. -->
        <span
          class="mt-[0.625rem] flex h-5 min-w-0 max-w-full items-center gap-[0.375rem] text-xs text-[color-mix(in_oklch,var(--foreground)_64%,transparent)] @max-[15rem]:gap-1"
        >
          <!-- The project's own mark identifies it faster than its name does.
               The band above already names the project while the list is
               scoped. Project and host stay as one compact cluster on the
               left; PR navigation owns the opposite edge. -->
          <span
            class="flex min-w-0 flex-1 items-center gap-[0.375rem] @max-[15rem]:gap-1"
          >
            <!-- The project line is also the way into that project: it names
                 the scope you would be picking, so it is the shortest path to
                 picking it. The band above is the only way back out. -->
            <button
              type="button"
              class="-mx-[0.1875rem] flex min-w-0 cursor-pointer items-center gap-[0.375rem] rounded-[0.3125rem] px-[0.1875rem] text-inherit transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              title="Show only {task.projectLabel}"
              onclick={(event) => {
                event.stopPropagation();
                onFilterProject();
              }}
            >
              <ProjectFavicon
                projectRoot={task.projectKey}
                class="size-4 @max-[15rem]:size-[0.875rem]"
              />
              <span
                class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                >{task.projectLabel}</span
              >
            </button>
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
          {#if prChip}
            <span class="ml-auto flex shrink-0 items-center">
              <PrChip chip={prChip} onOpen={onOpenPr} />
            </span>
          {/if}
        </span>
      {/if}
    </span>
  </div>
      {/snippet}
    </TooltipUI.Trigger>
    <SessionSidebarTooltip
      title={task.title}
      projectKey={task.projectKey}
      projectLabel={task.projectLabel}
      branchName={task.branchName}
      serverId={task.serverId}
      attention={task.attention}
      {reviewGuideStatus}
    />
  </TooltipUI.Root>

  {#if disclosable && expanded}
    <div class="relative flex flex-col gap-[0.1875rem] pt-px pb-2">
      <!-- The spine drops out of the caret above and stops on the last row's
           own elbow, so the tree reads as ending rather than running off. -->
      <span
        class="absolute top-0 bottom-10 left-2.5 w-px bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
      ></span>
      {#each sessions as session, index (session.sessionId ?? session.tabId ?? session.taskId)}
        <TaskSessionRow
          {session}
          projectLabel={task.projectLabel}
          {onPath}
          leadsToSelection={selectedIndex >= 0 && index <= selectedIndex}
          renaming={!!session.tabId && renamingTabId === session.tabId}
          selected={!!session.tabId && session.tabId === selectedTabId}
          onRename={(next) => onRename(session, next)}
          {onRenameCancel}
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
