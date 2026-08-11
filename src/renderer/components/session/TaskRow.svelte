<script lang="ts">
  import {
    CaretDownIcon,
    CaretRightIcon,
    BookOpenTextIcon,
    ArrowUUpLeftIcon,
    AlarmIcon,
    CheckIcon,
    CircleNotchIcon,
    FolderIcon,
    GlobeIcon,
    LaptopIcon,
    MoonIcon,
    SpinnerGapIcon,
    XIcon,
  } from "phosphor-svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import PrChip from "./PrChip.svelte";
  import SessionNameInput from "./SessionNameInput.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";
  import TaskSessionRow from "./TaskSessionRow.svelte";
  import UnreadDot from "./UnreadDot.svelte";
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
    /** The project name under the title — only when the list spans projects. */
    showProjectLine: boolean;
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
    showProjectLine,
    sessions,
    selectedTabId,
    renamingTabId,
    renamingTaskId,
    onSelect,
    onRename,
    onRenameCancel,
    onMore,
    onSnooze,
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

  // `~` stands in for a session with no repo behind it, so there is no root to
  // look a favicon up in.
  const hasRoot = $derived(task.projectKey.startsWith("/"));

  // Which machine, on the same rule as the elapsed readout: with one session
  // under the task there is a single answer and the row states it, so you never
  // have to expand a one-session task to learn where it runs. Several sessions
  // can sit on different hosts, and no single mark is true of all of them — so
  // the question moves down to the rows that can each answer it.
  const showsHost = $derived(sessions.length <= 1);
  const host = $derived(serversStore.hostFor(task.serverId));
  // A task with no server on it has nothing open, and nothing open runs here.
  const isRemote = $derived(!!host && !host.local);

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
  const showsBottomRow = $derived(
    !isCompleted && (showProjectLine || !!prChip),
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
  <div
    class="group/row relative -mr-1 flex cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 transition-[background] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] {bulkSelected ? 'bg-[color-mix(in_oklch,var(--primary)_9%,transparent)]' : ''} pl-[0.125rem] {showsBottomRow ? 'h-[3.25rem]' : 'h-[2.125rem]'}"
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
    <!-- The disclosure column, spent only by a row that has a mark to put in it
         — a completed row's project mark, or an open row's count. A row that
         opens onto nothing spends nothing, so its title starts at the pane's
         left edge rather than behind an empty column. It sits directly over the
         spine that drops out of it when the row is open. Collapsed it states the
         count, because how many rows are under here is the question you have
         while scanning; on hover it swaps (CSS only, so it lands on the
         pointer's frame) to the caret, which is the answer to what to do about
         it. -->
    {#if isCompleted || disclosable}
      <span
        class="-mr-[0.375rem] flex size-4 shrink-0 items-center justify-center text-(--solus-text-tertiary) {showsBottomRow
 ? 'mt-2 self-start'
 : ''}"
        aria-hidden="true"
      >
        {#if isCompleted}
          {#if hasRoot}
            <ProjectFavicon
              projectRoot={task.projectKey}
              class="size-[0.875rem]"
            />
          {:else}
            <FolderIcon
              size={14}
              weight="fill"
              class="text-(--solus-text-tertiary)"
            />
          {/if}
        {:else if expanded}
          <CaretDownIcon size={14} weight="bold" />
        {:else}
          <span
            class="font-mono text-[0.625rem] tabular-nums group-hover/row:hidden"
            >{sessions.length}</span
          >
          <CaretRightIcon
            size={14}
            weight="bold"
            class="hidden group-hover/row:block"
          />
        {/if}
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
      <span class="flex h-[1.1875rem] items-center gap-[0.5625rem]">
        <!-- The one thing the eye scans. The title truncates; nothing else does. -->
        {#if renamingLead}
          <SessionNameInput
            value={task.title}
            class="text-[0.84375rem] {titleIsEmphasized
 ? 'font-medium'
 : ''}"
            onCommit={(next) => onRename(null, next)}
            onCancel={onRenameCancel}
          />
        {:else}
          <span
            class="min-w-0 flex-1 overflow-hidden text-[0.84375rem] leading-[1.1875rem] text-ellipsis whitespace-nowrap transition-colors duration-150 {titleIsEmphasized
 ? 'font-medium'
 : ''} {titleLeads
 ? 'text-foreground'
 : 'text-(--solus-text-secondary)'}">{task.title}</span
          >
        {/if}

        <!-- The margin carries live task state, not standing navigation. -->
        {#if showsMargin}
          <span class="flex shrink-0 items-center gap-[0.5625rem]">
            {#if completedAge}
              <span
                class="shrink-0 font-mono text-[0.65625rem] text-muted-foreground tabular-nums"
                title={`Completed ${new Date(task.completedAt).toLocaleString()}`}
                >{completedAge}</span
              >
            {/if}
            {#if reviewGuideStatus === "generating"}
              <span
                class="flex shrink-0 items-center text-(--solus-status-running-icon)"
                role="img"
                aria-label="Generating review guide"
                title="Generating review guide"
              >
                <CircleNotchIcon
                  size={14}
                  class="animate-spin [animation-duration:0.9s] motion-reduce:animate-none"
                />
              </span>
            {:else if reviewGuideStatus === "ready"}
              <span
                class="flex shrink-0 items-center text-(--solus-art-positive)"
                role="img"
                aria-label="Review guide ready"
                title="Review guide ready"
              >
                <BookOpenTextIcon size={14} weight="fill" />
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
              <span class="shrink-0 font-mono text-[0.625rem] tabular-nums text-muted-foreground">{snoozeReturn}</span>
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
                  class="shrink-0 font-mono text-[0.65625rem] tabular-nums {isCurrentSession
 ? 'text-[color-mix(in_oklch,var(--primary)_68%,var(--foreground))]'
 : 'text-[color-mix(in_oklch,var(--foreground)_64%,transparent)]'}">{elapsed}</span
                >
              {/if}
            </span>
            {/if}
          </span>
        {/if}

        <!-- A task with nothing open still owns its name and completion state,
             so completion and overflow remain available. Closing only affects
             mounted sessions; it never changes task status. -->
        {#if task.tabIds[0] || task.taskId}
          <span
            class="-mr-1 hidden shrink-0 items-center gap-px group-hover/row:flex group-focus-within/row:flex"
          >
            <!-- Reversible first, destructive last, so the pointer never lands
                 on remove while aiming for snooze. Snooze has no behaviour
                 behind it yet — the row keeps its place in the cluster so the
                 three-button geometry is not re-tuned the day it does. -->
            {#if task.status !== "done" && task.status !== "dropped"}
              <button
                class={iconButton}
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
                title={task.taskId ? "Remove from sidebar" : "Close session"}
                aria-label={task.taskId ? "Remove task from sidebar" : "Close session"}
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
        <span
          class="mt-1 flex min-w-0 max-w-full items-center gap-[0.375rem] text-[0.6875rem] text-[color-mix(in_oklch,var(--foreground)_64%,transparent)]"
        >
          {#if showProjectLine}
            <!-- The project's own mark identifies it faster than its name does.
                 A group header already names the project. Project and host stay
                 as one compact cluster on the left; PR navigation owns the
                 opposite edge. -->
            <span class="flex min-w-0 items-center gap-[0.375rem]">
              {#if hasRoot}
                <ProjectFavicon
                  projectRoot={task.projectKey}
                  class="size-[0.8125rem]"
                />
              {:else}
                <FolderIcon
                  size={14}
                  weight="fill"
                  class="shrink-0 text-(--solus-text-tertiary)"
                />
              {/if}
              <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                >{task.projectLabel}</span
              >
              {#if showsHost}
                <span class="shrink-0">·</span>
                {#if isRemote}
                  <GlobeIcon size={14} class="shrink-0" aria-label={host?.label} />
                {:else}
                  <LaptopIcon size={14} class="shrink-0" aria-label="This machine" />
                {/if}
              {/if}
            </span>
          {/if}
          {#if prChip}
            <span class="ml-auto flex shrink-0 items-center">
              <PrChip chip={prChip} onOpen={onOpenPr} />
            </span>
          {/if}
        </span>
      {/if}
    </span>
  </div>

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
