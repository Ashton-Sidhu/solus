<script lang="ts">
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import {
    CaretDownIcon,
    CaretRightIcon,
    BookOpenTextIcon,
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
    expanded: boolean;
    /** The project name under the title — only when the list spans projects. */
    showProjectLine: boolean;
    /** Grouped rows sit under a project header, so the whole cluster — disclosure
     *  column, spine, titles — shifts right by the header's mark column. */
    grouped: boolean;
    sessions: SidebarSessionChild[];
    /** Active session only when it belongs to this task. Keeping unrelated rows
     *  at null prevents one click from updating every session list. */
    selectedTabId: string | null;
    /** Tab whose session name is being edited in place. */
    renamingTabId: string | null;
    /** The same for rows the task store backs, which are named by the task
     *  rather than by whichever session happens to be open under them. */
    renamingTaskId: string | null;
    onSelect: () => void;
    onRename: (session: SidebarSessionChild | null, next: string) => void;
    onRenameCancel: () => void;
    onMore: (event: MouseEvent) => void;
    onComplete: () => void;
    onClose: () => void;
    onSelectSession: (session: SidebarSessionChild) => void;
    onMoreSession: (event: MouseEvent, session: SidebarSessionChild) => void;
    onCompleteSession: (session: SidebarSessionChild) => void;
    onCloseSession: (session: SidebarSessionChild) => void;
  }
  let {
    task,
    prChip,
    onPath,
    expanded,
    showProjectLine,
    grouped,
    sessions,
    selectedTabId,
    renamingTabId,
    renamingTaskId,
    onSelect,
    onRename,
    onRenameCancel,
    onMore,
    onComplete,
    onClose,
    onSelectSession,
    onMoreSession,
    onCompleteSession,
    onCloseSession,
  }: Props = $props();

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const hasSessions = $derived(task.taskId ? sessions.length > 0 : false);
  /** Whether the row opens onto anything — and therefore whether it spends a
   *  disclosure mark. A lone session of the task itself is already this row. */
  const disclosable = $derived(hasSessions && hasDisclosure(sessions));
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

  // Unread output wins over a live run until it is cleared. A state explicitly
  // waiting on the user still wins over unread.
  const showsUnreadDot = $derived(
    showsUnreadIndicator(task.status, task.unread),
  );

  // A number can only date one turn. Once several sessions are running under
  // the task there is no single clock to report, so the row says *that* work is
  // in flight and leaves the durations to the session rows that own them.
  const spinning = $derived(
    task.status === "running" && !showsUnreadDot && sessions.length > 1,
  );

  // Ticks each second, tabular figures, so the row never reflows around it.
  let now = $state(Date.now());
  $effect(() => {
    if (task.status !== "running" || showsUnreadDot || spinning) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });
  const elapsed = $derived(
    task.status === "running" && !showsUnreadDot && !spinning && task.runStartedAt
      ? formatElapsed(now - task.runStartedAt)
      : "",
  );

  const showsMargin = $derived(
    !!prChip ||
      reviewGuideStatus === "generating" ||
      reviewGuideStatus === "ready" ||
      hasGlyph(task.status) ||
      spinning ||
      !!elapsed ||
      showsUnreadDot,
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
    "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[0.4375rem] text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground";
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
    class="group/row relative -mr-1 flex cursor-pointer items-center gap-[0.5625rem] rounded-[0.6875rem] pr-2 transition-[background] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] {grouped
      ? 'pl-2.5'
      : 'pl-[0.125rem]'} {showProjectLine ? 'h-[3.25rem]' : 'h-[2.125rem]'}"
    role="treeitem"
    tabindex="0"
    data-task-key={task.key}
    aria-selected={onPath}
    aria-expanded={disclosable ? expanded : undefined}
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
    <!-- The disclosure column. It is the same width on every row so the titles
         still form one edge, and it sits directly over the spine that drops out
         of it when the row is open. Collapsed it states the count, because how
         many rows are under here is the question you have while scanning; on
         hover it swaps (CSS only, so it lands on the pointer's frame) to the
         caret, which is the answer to what to do about it. -->
    <span
      class="-mr-[0.375rem] flex size-4 shrink-0 items-center justify-center text-(--solus-text-tertiary) {showProjectLine
        ? 'mt-2 self-start'
        : ''}"
      aria-hidden="true"
    >
      {#if disclosable && expanded}
        <CaretDownIcon size={10} weight="bold" />
      {:else if disclosable}
        <span
          class="font-mono text-[0.625rem] tabular-nums group-hover/row:hidden"
          >{sessions.length}</span
        >
        <CaretRightIcon
          size={10}
          weight="bold"
          class="hidden group-hover/row:block"
        />
      {/if}
    </span>

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
            class="text-[0.84375rem] tracking-[-0.008em] {titleIsEmphasized
              ? 'font-[560]'
              : ''}"
            onCommit={(next) => onRename(null, next)}
            onCancel={onRenameCancel}
          />
        {:else}
          <span
            class="min-w-0 flex-1 overflow-hidden text-[0.84375rem] leading-[1.1875rem] tracking-[-0.008em] text-ellipsis whitespace-nowrap transition-colors duration-150 {titleIsEmphasized
              ? 'font-[560]'
              : ''} {titleLeads
              ? 'text-foreground'
              : 'text-(--solus-text-secondary)'}">{task.title}</span
          >
        {/if}

        <!-- The margin carries a mark, not a sentence, and never dims. A task's
             PR is standing context rather than a state, so it sits beside
             whatever the agent is currently reporting instead of waiting for
             the row to go quiet. It is the one mark that steps aside on hover
             (a CSS swap, so it lands on the same frame as the pointer) to make
             room for the actions. The cluster is dropped rather than left
             empty: an empty flex child still spends the line's gap, which the
             title would pay for in truncation. -->
        {#if showsMargin}
          <span class="flex shrink-0 items-center gap-[0.5625rem]">
            {#if prChip}
              <span class="flex shrink-0 items-center group-hover/row:hidden">
                <PrChip chip={prChip} />
              </span>
            {/if}
            {#if reviewGuideStatus === "generating"}
              <span
                class="flex shrink-0 items-center text-(--solus-status-running-icon)"
                role="img"
                aria-label="Generating review guide"
                title="Generating review guide"
              >
                <CircleNotchIcon
                  size={13}
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
                <BookOpenTextIcon size={13} weight="fill" />
              </span>
            {/if}
            <!-- State marks vary slightly in silhouette and optical size, but
                 their centres share one column down the tree. -->
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
                  <SpinnerGapIcon size={13} class="animate-spin" />
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
          </span>
        {/if}

        <!-- A task with nothing open still owns its name and completion state,
             so the complete, overflow, and remove actions remain available. -->
        {#if task.tabIds[0] || task.taskId}
          <span
            class="-mr-1 hidden shrink-0 items-center gap-px group-hover/row:flex group-focus-within/row:flex"
          >
            <!-- Reversible first, destructive last, so the pointer never lands
                 on remove while aiming for snooze. Snooze has no behaviour
                 behind it yet — the row keeps its place in the cluster so the
                 three-button geometry is not re-tuned the day it does. -->
            <button
              class={iconButton}
              title="Snooze"
              aria-label="Snooze task"
              onclick={(event) => event.stopPropagation()}
            >
              <MoonIcon size={13} />
            </button>
            <button
              class={iconButton}
              title="Mark task completed"
              aria-label="Mark task completed"
              onclick={(event) => {
                event.stopPropagation();
                onComplete();
              }}
            >
              <CheckIcon size={14} weight="bold" />
            </button>
            <button
              class={iconButton}
              title="Remove from sidebar"
              aria-label="Remove task from sidebar"
              onclick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <XIcon size={13} weight="bold" />
            </button>
          </span>
        {/if}
      </span>
      {#if showProjectLine}
        <!-- The project's own mark identifies it faster than its name does. A
             group header already names the project, so grouped rows drop the
             line entirely. -->
        <span
          class="mt-1 flex max-w-full items-center gap-[0.375rem] text-[0.6875rem] text-[color-mix(in_oklch,var(--foreground)_64%,transparent)]"
        >
          {#if hasRoot}
            <ProjectFavicon
              projectRoot={task.projectKey}
              class="size-[0.8125rem]"
            />
          {:else}
            <FolderIcon
              size={13}
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
              <GlobeIcon size={11} class="shrink-0" aria-label={host?.label} />
            {:else}
              <LaptopIcon size={11} class="shrink-0" aria-label="This machine" />
            {/if}
          {/if}
        </span>
      {/if}
    </span>
  </div>

  {#if disclosable && expanded}
    <div
      class="relative flex flex-col gap-[0.1875rem] pt-px pb-2"
      transition:slide={{ duration: reduceMotion ? 0 : 160, easing: cubicOut }}
    >
      <!-- The spine drops out of the caret above and stops on the last row's
           own elbow, so the tree reads as ending rather than running off. -->
      <span
        class="absolute top-0 bottom-10 w-px bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] {grouped
          ? 'left-[1.125rem]'
          : 'left-2.5'}"
      ></span>
      {#each sessions as session, index (session.sessionId ?? session.tabId ?? session.taskId)}
        <TaskSessionRow
          {session}
          {grouped}
          {onPath}
          leadsToSelection={selectedIndex >= 0 && index <= selectedIndex}
          renaming={!!session.tabId && renamingTabId === session.tabId}
          selected={!!session.tabId && session.tabId === selectedTabId}
          onRename={(next) => onRename(session, next)}
          {onRenameCancel}
          onSelect={() => onSelectSession(session)}
          onMore={(event) => onMoreSession(event, session)}
          onComplete={session.isSubtask
            ? () => onCompleteSession(session)
            : undefined}
          onClose={() => onCloseSession(session)}
        />
      {/each}
    </div>
  {/if}
</div>
