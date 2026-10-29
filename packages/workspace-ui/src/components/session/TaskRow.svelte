<script lang="ts">
  import {
    Network as StartedSessionsIcon,
    ClipboardCheck as ClipboardCheckIcon,
    Undo2 as ArrowUUpLeftIcon,
    AlarmClock as AlarmIcon,
    Check as CheckIcon,
    Laptop as LaptopIcon,
    Moon as MoonIcon,
    Sun as SunIcon,
    User as UserIcon,
    LoaderCircle as SpinnerGapIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { shouldActivateRenameableRow } from "../../lib/rename-input";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import { hostIsManaged } from "../servers/lib/managed-host";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
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
    resolveSidebarRowMark,
    taskRowBranchName,
    shouldEmphasizeTitle,
    shouldRecedeRow,
    type PrChip as PrChipModel,
    type TaskPrChoice,
    type SidebarTask,
  } from "./lib/task-list";
  import { alignStatusAnimationPhase } from "./lib/status-animation-phase";
  import { nestedStateMarks, visibleNestedSessions } from "./lib/session-tree";
  import UserAvatar from "../users/UserAvatar.svelte";
  import type { User } from "@solus/contracts/user";
  import { shareRoleText } from "../../contexts/workspace/shared-sessions";

  interface Props {
    task: SidebarTask;
    /** The owner of a shared row's session, when the directory names them. */
    shareOwner?: User | null;
    prChip: PrChipModel | null;
    prChoices: TaskPrChoice[];
    /** True while the session you are reading is this row's session or one it
     *  delegated. That row leads with full ink and weight; the rest rest at a
     *  legible tone. */
    onPath: boolean;
    bulkSelected?: boolean;
    /** The row's session, for the facts the row states about it. */
    sessions: SidebarSessionChild[];
    /** A share link's guest is not told which host runs the session (host-sharing.md §10). */
    isGuest: boolean;
    /** Every session that the row's session delegated. The row lists them
     *  under itself, or folds them away and states their count. */
    nestedSessions: SidebarSessionChild[];
    /** The row sits in a project folder: one line and no project mark, because
     *  the folder already names the project. */
    inFolder?: boolean;
    /** The sessions it started are unfolded under it. */
    isNestedOpen: boolean;
    /** Fold or unfold the delegated sessions under the row. */
    onToggleNested: () => void;
    /** The tab on screen, which a session under the row marks as current. */
    onScreenTabId: string | null;
    /** Tab whose session name is being edited in place. */
    renamingTabId: string | null;
    onSelect: (event?: MouseEvent) => void;
    /** A click just opened a session and reordered the list under the resting
     *  pointer: the tooltip stays shut until the pointer moves. */
    isTooltipQuiet?: boolean;
    /** The pointer went down on the row: its reads can start before the click lands. */
    onPressStart?: () => void;
    /** Rename a row in place. `null` names the row's own session, matching
     *  `onRename`; a session listed under the row is named by its tab. */
    onStartRename: (session: SidebarSessionChild | null) => void;
    onRename: (session: SidebarSessionChild | null, next: string) => void;
    onRenameCancel: () => void;
    onMore: (event: MouseEvent | PointerEvent) => void;
    /** Whether the row's session can be snoozed (docs/task-snooze.md). */
    canSnooze: boolean;
    /** The snooze menu drops from the button that opened it. */
    onSnooze: (anchor: HTMLElement) => void;
    /** Return a snoozed row to its section immediately. */
    onWake: () => void;
    onComplete: () => void;
    onClose: () => void;
    onOpenPr: (choice: TaskPrChoice) => void;
    onWarmPr?: (choice: TaskPrChoice) => void;
    /** Open a pull request's own menu. */
    onMorePr: (event: MouseEvent, choice: TaskPrChoice) => void;
    /** The way to unlink a pull request from this row, or null when it has none. */
    onUnlinkPr?: (choice: TaskPrChoice) => (() => void) | null;
    onSelectSession: (session: SidebarSessionChild) => void;
    onMoreSession: (event: MouseEvent, session: SidebarSessionChild) => void;
    onCloseSession: (session: SidebarSessionChild) => void;
  }
  let {
    task,
    shareOwner = null,
    prChip,
    prChoices,
    onPath,
    bulkSelected = false,
    sessions,
    isGuest,
    nestedSessions,
    inFolder = false,
    isNestedOpen,
    onToggleNested,
    onScreenTabId,
    renamingTabId,
    onSelect,
    isTooltipQuiet = false,
    onPressStart,
    onStartRename,
    onRename,
    onRenameCancel,
    onMore,
    canSnooze,
    onSnooze,
    onWake,
    onComplete,
    onClose,
    onOpenPr,
    onWarmPr,
    onMorePr,
    onUnlinkPr,
    onSelectSession,
    onMoreSession,
    onCloseSession,
  }: Props = $props();

  const completeLabel = $derived(
    task.status === "done" ? "Reopen session" : "Mark session done",
  );

  // A row on a quiet shelf collapses to a single line. Snoozed and completed
  // work is deliberately out of the way, and a full-height card spends the same
  // vertical budget on it as on the work you are actually doing — which is what
  // made the column read as a wall. The slim row keeps every affordance; it
  // just stops claiming the space of live work.
  // A shared row keeps its card in every state: Shared with you has no shelf.
  const isShelved = $derived(task.lifecycle !== "active" && !task.share);
  // A folder row is one line too: the folder above it names the project.
  const isSlim = $derived(inFolder || isShelved);
  const hasStartedSessions = $derived(nestedSessions.length > 0 && !isShelved);
  // A folded row still lists the session on screen: folding must never hide
  // the session being read.
  const shownSessions = $derived(
    hasStartedSessions ? visibleNestedSessions(nestedSessions, !isNestedOpen, onScreenTabId) : [],
  );
  // The card lifts only while one of those sessions is on screen: it shows
  // where you are inside the session that started it.
  const isCardRaised = $derived(
    hasStartedSessions && nestedSessions.some((listed) => !!listed.tabId && listed.tabId === onScreenTabId),
  );
  // What the sessions under the row are doing, as marks the trailing slot
  // stacks when the row has no mark of its own. The row itself stays where
  // it is: only its own turn moves it to the Working section
  // (`sidebarSectionOf`).
  const nestedMarks = $derived(hasStartedSessions ? nestedStateMarks(nestedSessions) : []);
  const nestedMarksLabel = $derived(
    nestedMarks
      .map((nested) =>
        nested.kind === "spinner" ? "a session it started is working"
        : nested.kind === "unread" ? "a session it started has unread output"
        : `a session it started: ${nested.status}`,
      )
      .join("; "),
  );
  const nestedToggleLabel = $derived(
    `${isNestedOpen ? "Hide" : "Show"} ${nestedSessions.length} ${nestedSessions.length === 1 ? "session" : "sessions"} it started`,
  );
  const reviewGuideStatus = $derived(aggregateReviewGuideStatus(sessions));
  const reviewGuideTooltipStatus = $derived(
    aggregateReviewGuideStatus(
      sessions.map((session) => ({
        reviewGuideStatus: session.reviewGuideTooltipStatus ?? null,
      })),
    ),
  );

  // Which branch or worktree the work sits on. The row itself stays as it is;
  // the tooltip is where the answer belongs.
  const branchName = $derived(taskRowBranchName(task.branchName, sessions));
  const tooltipSession = $derived(sessions.length === 1 ? sessions[0] : null);

  // Which machine, on the same rule as the elapsed readout: with one session
  // under the row there is a single answer and the row states it. Several
  // sessions can sit on different hosts, and no single mark is true of all of
  // them — so the question moves to the task page, where each can answer it.
  const showsHost = $derived(!isGuest && sessions.length <= 1);
  const host = $derived(serversStore.hostFor(task.serverId));
  // A task with no server on it has nothing open, and nothing open runs here.
  const isRemote = $derived(!!host && !host.local);
  // A host Solus no longer has a saved entry for names no operating system;
  // the icon falls back to a globe in that case.
  const remoteOs = $derived(host && "os" in host ? host.os : undefined);

  // With no session listed under it on screen, this row stands for the
  // session you are reading, so it carries the current-session weight and
  // clock itself. A row that lists the session on screen under it leaves both
  // to that row.
  const isCurrentSession = $derived(
    onPath &&
      !nestedSessions.some((session) => session.tabId === onScreenTabId),
  );
  const titleIsEmphasized = $derived(
    shouldEmphasizeTitle(task.status, task.unread, isCurrentSession),
  );
  // Ink is now the row's property, not the title's: the whole row recedes or
  // does not, and the trailing mark keeps its own colour either way. A row
  // whose started session is on screen recedes too: that session leads, and
  // the raised card already says the row is on the way to it.
  const recedes = $derived(
    shouldRecedeRow(task.status, task.unread, task.woke, isCurrentSession),
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

  // A row is named by its session, through its only tab.
  const renamingRow = $derived(
    !!task.tabIds[0] && renamingTabId === task.tabIds[0],
  );

  // A click on the row opens its session, every time. Folding is the caret's
  // job alone, so a row never does two different things under one click.
  function activate(event?: MouseEvent) {
    onSelect(event);
  }

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
      label={attentionLabel(task.attention, task.limitResetsAt)}
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
      onanimationstart={alignStatusAnimationPhase}
      aria-label={mark.state === "ready"
        ? "Review guide ready"
        : "Generating review guide"}
      title={mark.state === "ready"
        ? "Review guide ready"
        : "Generating review guide"}
    >
      <ClipboardCheckIcon
        size={15}
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
      onanimationstart={alignStatusAnimationPhase}
      aria-label={attentionLabel(task.attention, task.limitResetsAt)}
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
      class="shrink-0 text-sidebar-time tabular-nums {isCurrentSession
        ? 'font-medium text-foreground'
        : 'text-[color-mix(in_oklch,var(--foreground)_45%,transparent)]'}"
      >{mark.label}</span
    >
  {:else if mark?.kind === "wake"}
    <!-- The same blue the Snoozed shelf header uses, so a sleeping row and the
         shelf holding it read as one thing. -->
    <span
      class="shrink-0 text-sidebar-time tabular-nums text-(--solus-status-unread)"
      title={`Wakes ${new Date(task.snoozedUntil).toLocaleString()}`}
      >{mark.label}</span
    >
  {:else if mark?.kind === "age"}
    <span
      class="shrink-0 text-sidebar-time tabular-nums text-muted-foreground"
      title={`Completed ${new Date(task.completedAt).toLocaleString()}`}
      >{mark.label}</span
    >
  {:else if nestedMarks.length > 0}
    <!-- A quiet row with sessions under it shows their marks instead,
         stacked: each state once, the ones that want you first. The same
         ring or spinner sits on the session's own row in the drawer, so the
         summary and the detail never disagree. Every mark keeps its own
         colour, so the stack holds at full strength on a receded row. -->
    <!-- The marks overlap like a stack of avatars, each later one cut out
         of the one beneath by a halo in the row's own surface: the sidebar
         at rest, the card on hover, when selected, and inside the raised
         card. -->
    <span
      class="flex shrink-0 items-center {isCurrentSession || isCardRaised
        ? '[--mark-halo:var(--card)]'
        : '[--mark-halo:var(--sidebar)] group-hover/row:[--mark-halo:var(--card)]'}"
      role="img"
      aria-label={nestedMarksLabel}
      title={nestedMarksLabel}
    >
      {#each nestedMarks as nested, index (index)}
        <span
          class="flex shrink-0 items-center rounded-full [box-shadow:0_0_0_1.5px_var(--mark-halo)] {index > 0
            ? '-ml-1'
            : ''}"
        >
          {#if nested.kind === "glyph"}
            <TaskStatusGlyph status={nested.status} size={13} label="" />
          {:else if nested.kind === "unread"}
            <UnreadDot size={12} />
          {:else}
            <span class="flex shrink-0 items-center text-chart-5" onanimationstart={alignStatusAnimationPhase}>
              <SpinnerGapIcon size={13} class="animate-spin" />
            </span>
          {/if}
        </span>
      {/each}
    </span>
  {/if}
{/snippet}

<!--
  Status at rest, actions on hover — in the *same* slot, cross-faded rather than
  appended. Three 24px buttons arriving beside the title used to take 72px out
  of it, so the title collapsed the moment a pointer crossed the row. Here the
  only thing that yields width is the mark the actions replace.

  Touch has no hover to swap on, so a coarse pointer keeps both: the mark holds
  its place and the actions simply stand beside it, exactly as before.

  The faded mark also gives up its pointer events: it goes out of flow at
  right-0, which paints it above the in-flow actions that replaced it, and an
  invisible box still answers a click.
-->
{#snippet trailingSlot()}
  <!-- The slot reserves its column only while it holds a mark. Reserved-when-
       empty, it would take 28px and a gap out of the project line on every
       quiet row — and the actions cost nothing at rest, because they are out of
       flow until the pointer arrives. -->
  <span
    class="relative ml-auto flex h-5 shrink-0 items-center justify-end {mark || nestedMarks.length > 0
      ? 'min-w-[1.75rem]'
      : ''}"
  >
    <span
      class="flex items-center transition-opacity duration-150 pointer-fine:group-hover/row:pointer-events-none pointer-fine:group-hover/row:absolute pointer-fine:group-hover/row:right-0 pointer-fine:group-hover/row:opacity-0 pointer-fine:group-has-[:focus-visible]/row:pointer-events-none pointer-fine:group-has-[:focus-visible]/row:absolute pointer-fine:group-has-[:focus-visible]/row:right-0 pointer-fine:group-has-[:focus-visible]/row:opacity-0"
    >
      {@render stateMark()}
    </span>

    <!-- A session with no conversation here still owns its completion state,
         so completion and archive remain available. -->
    {#if task.tabIds[0] || task.sessionId}
      <span
        class="pointer-events-none absolute inset-y-0 right-0 -mr-1 flex items-center gap-px opacity-0 transition-opacity duration-150 pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100 pointer-fine:group-hover/row:pointer-events-auto pointer-fine:group-hover/row:static pointer-fine:group-hover/row:opacity-100 pointer-fine:group-has-[:focus-visible]/row:pointer-events-auto pointer-fine:group-has-[:focus-visible]/row:static pointer-fine:group-has-[:focus-visible]/row:opacity-100"
      >
        <!-- Reversible first, destructive last, so the pointer never lands on
             remove while aiming for the lifecycle action. Snooze is the one of
             the three a narrow column can drop: it is a move you make on a row
             you are leaving alone, and it stays on the context menu with the
             rest of the session's lifecycle. Wake is not — it is a snoozed
             row's only way back, so it holds at every width. -->
        {#if canSnooze && task.status !== "done" && task.status !== "dropped"}
          {#if task.lifecycle === "snoozed"}
            <button
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
              title="Wake now"
              aria-label="Wake session now"
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
              aria-label="Snooze session"
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
          title={completeLabel}
          aria-label={completeLabel}
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
        <!-- Close takes a row out of the column: it archives the session, on
             every device (docs/plans/session-archive.md). -->
        <button
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
          title="Archive"
          aria-label="Archive session"
          onclick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <XIcon size={14} weight="bold" />
        </button>
      </span>
    {/if}
  </span>
{/snippet}

<!-- A row that started sessions and has no pull request names them on a
     chip, in the bare form the task and pull request chips take: a glyph and
     a count, no plate. The chip opens and closes the drawer of those
     sessions; it is in full ink while they are open and recedes while they
     are folded. A row with a pull request spends one chip on both: the pull
     request chip leads with the pull request and lists the sessions in its
     menu (`PrChip`), so a title line never carries two link chips beside the
     task chip.
     The sessions appear and go at once: a height that animates lays out the
     whole column every frame, on top of the conversation switch. -->
{#snippet startedSessionsChip()}
  {#if hasStartedSessions && !prChip}
    <button
      type="button"
      class="relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] text-xs tabular-nums transition-[color,opacity,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-1 before:content-[''] hover:text-foreground active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring {isNestedOpen
        ? 'text-foreground'
        : 'text-muted-foreground'} {recedes
        ? 'opacity-75 group-hover/row:opacity-100'
        : ''}"
      aria-expanded={isNestedOpen}
      aria-label={nestedToggleLabel}
      title={nestedToggleLabel}
      onkeydown={(event) => event.stopPropagation()}
      onpointerdown={(event) => event.stopPropagation()}
      onclick={(event) => {
        event.stopPropagation();
        onToggleNested();
      }}
    >
      <!-- The chip only counts. What those sessions are doing is the
           trailing slot's to say, with the marks the rest of the sidebar
           uses. -->
      <StartedSessionsIcon size={12.5} class="shrink-0" />
      <span>{nestedSessions.length}</span>
    </button>
  {/if}
{/snippet}

<!-- The one thing the eye scans. The title truncates; nothing else does, and
     nothing else shares its line except the PR token that navigates away from
     it. Colour is inherited from the row, so a receding row's title recedes
     with it rather than being tuned against it. -->
{#snippet rowTitle()}
  {#if renamingRow}
    <SessionNameInput
      value={task.title}
      class="text-workspace-chrome {titleIsEmphasized ? 'font-medium' : ''}"
      onCommit={(next) => onRename(null, next)}
      onCancel={onRenameCancel}
    />
  {:else}
    <span
      class="min-w-0 flex-1 overflow-hidden text-workspace-chrome text-ellipsis whitespace-nowrap transition-[font-weight] duration-150 {titleIsEmphasized
        ? 'font-medium'
        : ''}">{task.title}</span
    >
  {/if}
{/snippet}

<!--
  The row you are reading sits on the plate a hovered row lifts onto, so the
  pointer and the selection say the same thing in the same way. Weight and
  tone carry the rest: the active task and anything asking for a person lead
  in full ink at a heavier weight; every other row recedes as a whole to the
  secondary tone, still plainly legible rather than faded out. The hierarchy is
  a difference in emphasis, never a wall between "readable" and "invisible".
-->
<!-- Pointer down only starts the open's reads early; the row inside is the
     control, and a keyboard open still starts them on its own. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- While a session this row's session started is on screen, the row and its
     sessions lift onto one card, the plate a hovered row lifts onto. The card
     spans the row's own width, so every title keeps its column. -->
<!-- The plate is a pseudo-element under the rows, painted once with its
     colour and shadow, and shown by its opacity, so nothing here changes
     size: a card that grew on arrival shoved the rows around it on every
     click. It fades on the row's own 150ms, and the title's weight eases on
     the same clock (the sans fonts are variable), so a selection reads as
     one event: plate, ink, and weight arriving together. -->
<div
  class="group/task relative isolate -mx-2 rounded-lg px-2 before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-lg before:bg-card before:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] before:transition-opacity before:duration-150 before:content-[''] motion-reduce:before:transition-none dark:before:bg-[color-mix(in_oklch,var(--card)_94%,white)] {isCardRaised
    ? 'before:opacity-100'
    : 'before:opacity-0'}"
  onpointerdown={(event) => { if (event.button === 0) onPressStart?.(); }}>
  <TooltipUI.Root disabled={isTooltipQuiet}>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
  <div
    {...tooltipProps}
    class="group/row relative -mx-2 flex cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 {inFolder ? 'pl-[2.1875rem]' : 'pl-[0.625rem]'} transition-[background,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring {isCardRaised ? 'hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]' : 'hover:bg-card hover:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] dark:hover:bg-[color-mix(in_oklch,var(--card)_94%,white)]'} {isCurrentSession && !isCardRaised
 ? 'bg-card shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] dark:bg-[color-mix(in_oklch,var(--card)_94%,white)]'
 : ''} {bulkSelected
 ? 'bg-[color-mix(in_oklch,var(--primary)_9%,transparent)]'
 : ''} {isSlim ? 'h-[2.25rem]' : 'h-[3.875rem]'} {recedes
 ? 'text-[color-mix(in_oklch,var(--solus-text-secondary)_75%,transparent)] hover:text-foreground'
 : 'text-foreground'}"
    role="treeitem"
    tabindex="0"
    data-task-key={task.key}
    aria-selected={isCurrentSession}
    aria-expanded={hasStartedSessions ? isNestedOpen : undefined}
    aria-label={mark?.kind === "glyph"
      ? `${task.title} — ${attentionLabel(task.attention, task.limitResetsAt)}`
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
      activate(event);
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
        activate();
      }
    }}
  >
    {#if isSlim}
      <!-- One line, and the project mark stands in for the project name it no
           longer has room to spell. Shelved history recedes further than a live
           row does: the mark greys out at rest and comes back on hover, so the
           tail stays scannable when you are hunting through it. -->
      <!-- A folder row has no mark: the folder above it names the project, and
           its title lines up under the folder's name. -->
      {#if !inFolder}
        <span
          class="flex size-4 shrink-0 items-center justify-center transition-[filter,opacity] duration-150 {onPath
            ? ''
            : 'opacity-45 grayscale group-hover/row:opacity-100 group-hover/row:grayscale-0'}"
          aria-hidden="true"
        >
          <ProjectFavicon
            projectKey={task.groupKey}
            class="size-4 pointer-fine:[&_.lucide-icon]:size-[82%]"
          />
        </span>
      {/if}
      {@render rowTitle()}
      {@render startedSessionsChip()}
      {#if prChip}
        <span
          class="flex shrink-0 items-center transition-opacity duration-150 {recedes
            ? 'opacity-75 group-hover/row:opacity-100'
            : ''}"
        >
          <PrChip chip={prChip} choices={prChoices} onOpen={onOpenPr} onMore={onMorePr} onWarm={onWarmPr} onUnlink={onUnlinkPr} startedSessions={hasStartedSessions ? nestedSessions : []} onOpenSession={onSelectSession} />
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
          class="flex h-[1.1875rem] min-w-0 items-center gap-[0.375rem] text-chrome-dense @max-[15rem]:gap-1"
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
              projectKey={task.groupKey}
              class="size-4 shrink-0 @max-[15rem]:size-[0.875rem] pointer-fine:[&_.lucide-icon]:size-[82%]"
            />
            <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              >{task.projectLabel}</span
            >
            {#if task.share}
              <!-- Whose session it is, and what the reader may do in it. The
                   owner's face stands in for their name; the role is words. -->
              <span class="shrink-0">·</span>
              <span
                class="flex min-w-0 shrink items-center gap-1"
                title={shareOwner ? `${shareOwner.displayName} · ${shareRoleText(task.share.role)}` : shareRoleText(task.share.role)}
              >
                {#if shareOwner}
                  <UserAvatar user={shareOwner} size={14} />
                {:else}
                  <span
                    class="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] text-muted-foreground"
                    aria-hidden="true"
                  >
                    <UserIcon size={10} />
                  </span>
                {/if}
                <span class="min-w-0 truncate">{shareRoleText(task.share.role)}</span>
              </span>
            {/if}
            {#if showsHost && !task.share}
              <!-- The separator is pure decoration, and local is the default
                   every row would otherwise repeat. A remote session names its
                   host as well as its operating system: remote and SaaS clients
                   cannot infer the machine from the icon. The host cluster is
                   bounded so it yields to the project name, and both labels
                   truncate before the trailing state or actions. -->
              <span class="shrink-0 @max-[15rem]:hidden">·</span>
              {#if isRemote}
                <span
                  class="flex min-w-0 max-w-[45%] items-center gap-1"
                  title={host?.label}
                >
                  <HostOperatingSystemIcon
                    os={remoteOs}
                    managed={hostIsManaged(host)}
                    size={12}
                    class="size-3 shrink-0"
                  />
                  <span class="min-w-0 truncate">{host?.label}</span>
                </span>
              {:else}
                <LaptopIcon
                  size={12}
                  class="size-3 shrink-0 @max-[15rem]:hidden"
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
             19px line, so they hang 2.5px below it, and the pull request chip
             carries a hit target taller than its own text. At 4px the two
             overlapped, and a click aimed at close or complete opened the pull
             request instead. -->
        <span
          class="mt-2 flex h-[1.1875rem] items-center gap-[0.5625rem] @max-[15rem]:gap-1.5"
        >
          {@render rowTitle()}
          {#if prChip}
            <!-- It shares the title's line because it is navigation rather
                 than state. -->
            <span
              class="flex shrink-0 items-center transition-opacity duration-150 {recedes
                ? 'opacity-75 group-hover/row:opacity-100'
                : ''}"
            >
              <PrChip chip={prChip} choices={prChoices} onOpen={onOpenPr} onMore={onMorePr} onWarm={onWarmPr} onUnlink={onUnlinkPr} startedSessions={hasStartedSessions ? nestedSessions : []} onOpenSession={onSelectSession} />
            </span>
          {/if}
          {@render startedSessionsChip()}
        </span>
      </span>
    {/if}
  </div>
      {/snippet}
    </TooltipUI.Trigger>
    <SessionSidebarTooltip
      title={task.title}
      projectKey={task.projectKey}
      groupKey={task.groupKey}
      projectLabel={task.projectLabel}
      taskTitle={task.linkedTask?.title}
      {branchName}
      serverId={task.serverId}
      {isGuest}
      provider={tooltipSession?.provider}
      modelId={tooltipSession?.modelId}
      attention={task.attention}
      limitResetsAt={task.limitResetsAt}
      reviewGuideStatus={reviewGuideTooltipStatus}
    />
  </TooltipUI.Root>

  {#if shownSessions.length > 0}
    <!-- Every session the row's session started, one step in under its title,
         behind a guide that runs down from the title's first letter so the
         sessions read as the row's own and not as its neighbours. The row's
         title sits at 2.1875rem in a folder and 0.625rem elsewhere, less the
         row's 0.5rem pull; the guide stands there, and a child row pads its
         title 0.625rem past it. -->
    <div
      class="border-l border-[color-mix(in_oklch,var(--foreground)_12%,transparent)] mt-0.5 pb-2 pl-1 {inFolder
        ? 'ml-[1.6875rem]'
        : 'ml-[0.125rem]'}"
    >
      {#each shownSessions as listed (listed.tabId ?? listed.sessionId)}
        <TaskSessionRow
          session={listed}
          isCurrent={!!listed.tabId && listed.tabId === onScreenTabId}
          inRaisedCard={isCardRaised}
          groupKey={task.groupKey}
          projectLabel={task.projectLabel}
          {isGuest}
          renaming={!!listed.tabId && renamingTabId === listed.tabId}
          onRename={(next) => onRename(listed, next)}
          {onRenameCancel}
          onStartRename={() => onStartRename(listed)}
          onSelect={() => onSelectSession(listed)}
          onMore={(event) => onMoreSession(event, listed)}
          onClose={() => onCloseSession(listed)}
        />
      {/each}
    </div>
  {/if}
</div>
