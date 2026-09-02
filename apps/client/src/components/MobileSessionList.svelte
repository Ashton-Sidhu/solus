<script lang="ts">
  import { slide } from "svelte/transition";
  import { SHEET_ROW_META, SHEET_SECTION_LABEL } from "./lib/sheet-styles";
  import { cubicOut } from "svelte/easing";
  import {
    Plus as PlusIcon,
    LibraryBig as BooksIcon,
    Settings as GearIcon,
    Clock as ClockIcon,
    Check as CheckIcon,
    X as XIcon,
    Pin as PushPinIcon,
    ChevronRight as CaretRightIcon,
    Moon as MoonIcon,
    NotebookPen as NotePencilIcon,
    Paperclip as PaperclipIcon,
    ListChecks as ListChecksIcon,
    GitPullRequest as PullRequestIcon,
    Search as MagnifyingGlassIcon,
  } from "@lucide/svelte";
  import {
    getWorkspaceContext,
    getPullRequestsContext,
    getSessionSidebarStore,
    getSettingsContext,
  } from "@solus/workspace-ui/contexts";
  import { visibleRef } from "@solus/workspace-ui/contexts/workspace/routing/location";
  import {
    currentMobileSection,
    mobileSectionSignal,
    type MobileSectionId,
    type MobileSectionSignals,
  } from "../lib/mobile-sections";
  import { filterSidebarTasks } from "@solus/workspace-ui/components/session/lib/task-list";
  import { completedTasksWithinRetention } from "@solus/workspace-ui/lib/completed-task-retention";
  import SnoozeTaskMenu from "@solus/workspace-ui/components/session/SnoozeTaskMenu.svelte";
  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import { requestInputFocus } from "@solus/workspace-ui/lib/inputFocus";
  import { liveActivityClock } from "@solus/workspace-ui/lib/shared-clock";
  import { Skeleton } from "@solus/workspace-ui/components/ui/skeleton";
  import { useKeybinding } from "@solus/workspace-ui/lib/keybindings/use-keybinding.svelte";
  import type { SidebarTask } from "@solus/workspace-ui/components/session/lib/task-list";
  import MobileTaskRow from "./MobileTaskRow.svelte";
  import { swipeActions } from "../lib/swipe-actions";
  import MobileStateGlyph from "./MobileStateGlyph.svelte";
  import {
    MOBILE_STATE_INK,
    MOBILE_STATE_TILE_BG,
    mobileSessionState,
  } from "../lib/mobile-task-row";

  interface Props {
    /** True while the drawer is on screen, so hardware shortcuts never focus
     *  the mounted-but-hidden mobile surface. */
    active?: boolean;
    /** Close the drawer after a navigation action. */
    onSessionSelect: () => void;
    /** Open the server sheet (closing the drawer first). */
    onOpenServers: () => void;
  }
  let { active = true, onSessionSelect, onOpenServers }: Props = $props();

  const session = getWorkspaceContext();
  const store = getSessionSidebarStore();
  const settings = getSettingsContext();
  const pullRequests = getPullRequestsContext();

  // ── The section row ──
  // Five destinations, the same two signals the home cards carry, and a mark on
  // the one you are standing in — so opening the drawer from the PR list tells
  // you where you are rather than only where you could go.
  const sectionSignals: MobileSectionSignals = $derived({
    runningTasks: store.allTasks.filter((task) => task.status === "running").length,
    prsNeedingReview: pullRequests.needsReview.countFor(
      session.serverIdForContext(session.ctx),
      session.ctx,
    ),
  });
  const currentSection = $derived(
    currentMobileSection(visibleRef(session.router.leadingPane)?.name),
  );

  // The same three shelves the desktop sidebar keeps — active work, deferred
  // work, finished work — so a task means the same thing on both surfaces. What
  // changes on a phone is the row: 62px, its state in the sidebar's own glyph on
  // a tile, and its actions on a swipe rather than in a hover cluster.
  let taskQuery = $state("");
  let taskSearchEl = $state<HTMLInputElement | null>(null);
  const activeTasks = $derived(filterSidebarTasks(store.activeTasks, taskQuery));
  const snoozedTasks = $derived(filterSidebarTasks(store.snoozedTasks, taskQuery));
  const completedTasks = $derived(
    filterSidebarTasks(
      completedTasksWithinRetention(
        store.completedTasks,
        settings.sidebarCompletedRetentionDays,
      ),
      taskQuery,
    ),
  );
  const totalTasks = $derived(store.allTasks.length);
  const searching = $derived(taskQuery.trim().length > 0);
  const resultCount = $derived(
    activeTasks.length + snoozedTasks.length + completedTasks.length,
  );
  const hasSessions = $derived(resultCount > 0);
  // Search reaches into the shelves, so a match under a closed one would be
  // invisible. Finding something opens the shelf holding it.
  let completedExpanded = $state(false);
  const isCompletedExpanded = $derived(completedExpanded || searching);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useKeybinding(
    "global.focus-sidebar-task-search",
    () => taskSearchEl?.focus(),
    { enabled: () => active },
  );

  // One clock for the whole list, so forty rows do not each own a timer.
  let now = $state(Date.now());
  $effect(() => {
    if (!active) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  /** Only one row shows its tiles at a time — two open rows and the finger has
   *  no idea which set it is about to hit. */
  let revealedRowKey = $state<string | null>(null);
  let snoozeTarget = $state<{ task: SidebarTask; anchor: HTMLElement } | null>(null);

  // Fixed widths, so the loading list never reshuffles between renders.
  const SKELETON_ROWS = [
    { width: "62%", delay: 0 },
    { width: "44%", delay: 80 },
    { width: "71%", delay: 160 },
    { width: "38%", delay: 240 },
    { width: "55%", delay: 320 },
  ];

  /** Three 68px tiles. The row travels exactly this far on a short swipe. */
  const REVEAL_WIDTH = 204;

  function selectTask(task: SidebarTask) {
    void store.selectTask(task);
    requestInputFocus();
    onSessionSelect();
  }

  function selectSession(child: ReturnType<typeof store.sessionsFor>[number]) {
    void store.selectChild(child);
    requestInputFocus();
    onSessionSelect();
  }

  /** Removal is local sidebar view state. The task, provider run, and session
   *  history stay unchanged, so the toast only needs to offer restoration. */
  function removeTask(task: SidebarTask) {
    revealedRowKey = null;
    store.closeTask(task);
    toasts.show({
      message: task.status === "running"
        ? `Removed “${task.title}”. Its run continues.`
        : `Removed “${task.title}” from the sidebar.`,
      action: task.taskId
        ? {
            label: "Undo",
            onAction: () => {
              if (task.taskId) store.restoreTask(task.taskId);
            },
          }
        : undefined,
    });
  }

  async function finishTask(task: SidebarTask) {
    try {
      if (task.taskId) await session.tasksStore.get(task.taskId).setStatus("done");
      store.closeTask(task);
    } catch (error) {
      toasts.error(
        `Couldn't complete task: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function completeTask(task: SidebarTask) {
    revealedRowKey = null;
    if (task.status !== "running") {
      void finishTask(task);
      return;
    }
    toasts.show({
      message: `Stop the work in “${task.title}” and mark it completed?`,
      actions: [
        { label: "Stop and complete", onAction: () => void finishTask(task) },
        { label: "Keep working", onAction: requestInputFocus },
      ],
    });
  }

  function wakeTask(task: SidebarTask) {
    store.snoozeRow(task.key, null);
    requestInputFocus();
  }

  /** Same two actions the desktop drafts section has: go back to the composer,
   *  or discard with the words held in a toast until it is dismissed. */
  function openDraft(draftId: string) {
    session.openDraft(draftId);
    requestInputFocus();
    onSessionSelect();
  }

  function discardDraft(row: (typeof store.draftRows)[number], e: Event) {
    e.stopPropagation();
    const discarded = session.discardSessionDraft(row.draftId);
    if (!discarded) return;
    toasts.show({
      message: `Discarded “${row.title}”`,
      actions: [
        {
          label: "Undo",
          onAction: () =>
            session.restoreSessionDrafts({
              order: [row.draftId],
              drafts: { [row.draftId]: discarded },
            }),
        },
      ],
    });
  }

  function newSession() {
    session.openSessionDraft({ via: "click" });
    requestInputFocus();
    onSessionSelect();
  }

  function nav(action: () => void) {
    action();
    onSessionSelect();
  }

</script>

<!--
  One task per row, three shelves, and a swipe that reveals the same three
  actions the desktop row keeps behind hover. Grouping is the sidebar's, not the
  calendar's: what is being worked on, what was put off, what is finished.
-->
{#snippet taskRow(task: SidebarTask, shelf: "active" | "snoozed" | "completed")}
  {@const sessions = task.taskId ? store.sessionsFor(task) : []}
  {@const leadTabId = task.tabIds[0]}
  <div class="relative overflow-hidden rounded-2xl">
    <!-- The tiles sit underneath; the row moves off them. Full row height,
         glyph over word, in the warning / success / failure washes. -->
    <div class="absolute inset-y-0 right-0 flex" aria-hidden="true">
      <button
        type="button"
        class="flex w-[4.25rem] shrink-0 cursor-pointer flex-col items-center justify-center gap-1 border-0 font-medium [-webkit-tap-highlight-color:transparent]"
        style="background:{MOBILE_STATE_TILE_BG.warning};color:{MOBILE_STATE_INK.warning}"
        tabindex="-1"
        onclick={(e) => (snoozeTarget = { task, anchor: e.currentTarget })}
      >
        <MoonIcon size={17} />Snooze
      </button>
      <button
        type="button"
        class="flex w-[4.25rem] shrink-0 cursor-pointer flex-col items-center justify-center gap-1 border-0 font-medium [-webkit-tap-highlight-color:transparent]"
        style="background:{MOBILE_STATE_TILE_BG.success};color:{MOBILE_STATE_INK.success}"
        tabindex="-1"
        onclick={() => completeTask(task)}
      >
        <CheckIcon size={17} />Complete
      </button>
      <button
        type="button"
        class="flex w-[4.25rem] shrink-0 cursor-pointer flex-col items-center justify-center gap-1 border-0 font-medium [-webkit-tap-highlight-color:transparent]"
        style="background:{MOBILE_STATE_TILE_BG.failure};color:{MOBILE_STATE_INK.failure}"
        tabindex="-1"
        onclick={() => removeTask(task)}
      >
        <XIcon size={17} />Remove
      </button>
    </div>

    <!-- The row rides *on* the tiles, so its own fill has to be opaque:
         `--solus-container-bg` is 98% and left "Snooze / Complete / Drop"
         legible through every row at rest. The shadow is the leading edge. -->
    <div
      class="relative bg-(--solus-sidebar-bg) shadow-[0.375rem_0_0.875rem_-0.375rem_rgba(0,0,0,0.35)]"
      use:swipeActions={{
        revealWidth: REVEAL_WIDTH,
        open: revealedRowKey === task.key,
        enabled: shelf !== "completed",
        onFullSwipe: () => completeTask(task),
        onRevealChange: (open) => (revealedRowKey = open ? task.key : null),
      }}
    >
      <MobileTaskRow
        {task}
        {now}
        active={task.tabIds.includes(session.onScreenTabId)}
        sessionCount={sessions.length}
        reviewStatus={leadTabId ? store.childForTab(leadTabId).reviewGuideStatus : null}
        onOpen={() => (revealedRowKey === task.key
          ? (revealedRowKey = null)
          : selectTask(task))}
        onWake={shelf === "snoozed" ? () => wakeTask(task) : undefined}
      />
    </div>
  </div>

  <!-- A task's own runs, listed under it while one of them is on screen. -->
  {#if shelf === "active" && sessions.length > 1 && task.tabIds.includes(session.onScreenTabId)}
    {#each sessions as child (child.sessionId ?? child.tabId ?? child.taskId)}
      {@const state = mobileSessionState(child.attention)}
      <button
        type="button"
        class="flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent pr-3 pl-[2.6875rem] text-left active:bg-(--wash-1) [-webkit-tap-highlight-color:transparent]"
        aria-label={state.label ? `${child.label} — ${state.label}` : child.label}
        onclick={() => selectSession(child)}
      >
        <span
          class="min-w-0 flex-1 truncate {child.tabId === session.onScreenTabId
            ? 'text-(--solus-accent)'
            : 'text-(--solus-text-secondary)'}"
        >{child.label}</span>
        <!-- A run under an open task reports itself with the same mark the task
             row above it uses. Idle has nothing to report on a row this short,
             so it stays out of the trailing slot entirely. -->
        {#if state.glyph !== "idle"}
          <span
            class="flex shrink-0 items-center"
            style="color:{MOBILE_STATE_INK[state.tone]}"
            aria-hidden="true"
          >
            <MobileStateGlyph glyph={state.glyph} size={14} />
          </span>
        {/if}
      </button>
    {/each}
  {/if}
{/snippet}

<!-- One surface declaration for the whole drawer (ADR-0013). -->
<div class="flex h-full min-h-0 flex-col text-sm">
  <header class="shrink-0 pt-[env(safe-area-inset-top,0px)]">
    <div class="flex h-14 items-center gap-2 pr-2.5 pl-[1.125rem]">
      <span class="flex-1 text-base font-semibold tracking-[-0.014em] text-(--solus-text-primary)">Tasks</span>
      <!-- The search below reaches the tasks already open here; the board holds
           everything else, so the way to one of those stays on this header. -->
      <button
        type="button"
        class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-(--wash-3) text-(--muted-foreground) transition-transform duration-[120ms] active:scale-[0.96] [-webkit-tap-highlight-color:transparent]"
        onclick={() => {
          session.unifiedPickerOpen = true;
          onSessionSelect();
        }}
        aria-label="Open a task from the board"
      >
        <ListChecksIcon size={15} />
      </button>
      <button
        type="button"
        class="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-(--primary) px-3 font-semibold text-(--primary-foreground) transition-transform duration-[120ms] active:scale-[0.96] [-webkit-tap-highlight-color:transparent]"
        onclick={newSession}
        aria-label="New task"
      >
        <PlusIcon size={14} />New
      </button>
    </div>

    <div class="flex flex-col gap-2.5 px-[1.125rem] pt-1 pb-2.5">
      <label
        class="flex h-11 items-center gap-2.5 rounded-lg bg-(--card) px-3 shadow-[shadow:var(--elev-ring)]"
      >
        <MagnifyingGlassIcon size={15} class="shrink-0 text-(--muted-foreground)" aria-hidden="true" />
        <!-- 16px, or iOS zooms the viewport into the field and never zooms back. -->
        <input
          bind:this={taskSearchEl}
          bind:value={taskQuery}
          type="search"
          placeholder={totalTasks > 1 ? `Search ${totalTasks} tasks` : "Search tasks"}
          aria-label="Search tasks"
          class="min-w-0 flex-1 border-0 bg-transparent text-base tracking-[-0.006em] text-(--solus-text-primary) outline-none placeholder:text-(--muted-foreground) [&::-webkit-search-cancel-button]:hidden"
        />
        {#if searching}
          <span class="shrink-0 font-mono {SHEET_ROW_META}">
            {resultCount} of {totalTasks}
          </span>
          <button
            type="button"
            class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-(--wash-3) text-(--muted-foreground) [-webkit-tap-highlight-color:transparent]"
            aria-label="Clear task search"
            onclick={() => {
              taskQuery = "";
              taskSearchEl?.focus();
            }}
          >
            <XIcon size={12} />
          </button>
        {/if}
      </label>
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2.5 pb-3 [-webkit-overflow-scrolling:touch]">
    <!-- Prompts written but never sent, above the sessions they are on their way
         to becoming. Empty drafts earn no row, so the section is absent until
         something is written. -->
    {#if store.draftRows.length > 0 && !searching}
      <div class="{SHEET_SECTION_LABEL} px-2 pt-2.5 pb-1.5">Drafts</div>
      {#each store.draftRows as row (row.draftId)}
        <div
          class="flex h-[3.875rem] items-center gap-[0.6875rem] rounded-2xl px-3 active:bg-(--wash-1) [-webkit-tap-highlight-color:transparent]"
          role="button"
          tabindex="0"
          onclick={() => openDraft(row.draftId)}
          onkeydown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            openDraft(row.draftId);
          }}
        >
          <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--wash-3) text-(--muted-foreground)">
            <NotePencilIcon size={15} />
          </span>
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate font-medium text-(--solus-text-primary)">{row.title}</span>
            <span class="mt-[0.1875rem] truncate {SHEET_ROW_META}">{row.projectLabel}</span>
          </span>
          {#if row.hasAttachments}
            <span class="shrink-0 text-(--muted-foreground)" aria-label="Has attachments"><PaperclipIcon size={14} /></span>
          {/if}
          <button
            type="button"
            class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-muted) active:bg-(--wash-3) [-webkit-tap-highlight-color:transparent]"
            aria-label="Discard draft"
            onclick={(e) => discardDraft(row, e)}
          >
            <XIcon size={14} />
          </button>
        </div>
      {/each}
    {/if}

    {#if store.pinnedSessions.length > 0 && !searching}
      <div class="{SHEET_SECTION_LABEL} px-2 pt-3.5 pb-1.5">Pinned</div>
      {#each store.pinnedSessions as pin (`${pin.serverId ?? ""}:${pin.sessionId}`)}
        {@const openTabId = store.openTabIdForPinned(pin)}
        {@const isActive = !!openTabId && openTabId === session.onScreenTabId}
        <button
          type="button"
          class="flex h-[3.875rem] w-full cursor-pointer items-center gap-[0.6875rem] rounded-2xl border-0 px-3 text-left [-webkit-tap-highlight-color:transparent] {isActive
            ? 'bg-(--wash-2)'
            : 'bg-transparent active:bg-(--wash-1)'}"
          onclick={() => nav(() => store.openPinnedSession(pin))}
        >
          <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--wash-3) {isActive ? 'text-(--solus-accent)' : 'text-(--muted-foreground)'}">
            <PushPinIcon size={15} />
          </span>
          <span class="min-w-0 flex-1 truncate font-medium {isActive ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">{pin.title}</span>
        </button>
      {/each}
    {/if}

    {#if !session.tasksStore.loaded}
      <!-- Placeholders sit on the same rhythm as the rows they stand in for, so
           the list settles in place rather than reflowing when it arrives. -->
      <div class="flex flex-col" role="status" aria-label="Loading tasks">
        {#each SKELETON_ROWS as row, i (i)}
          <div class="flex h-[3.875rem] items-center gap-[0.6875rem] px-3" style="opacity:{1 - i * 0.13}">
            <Skeleton class="size-7 shrink-0 rounded-lg opacity-60" />
            <Skeleton
              class="h-3 rounded"
              style="width:{row.width};animation-delay:{row.delay}ms"
            />
          </div>
        {/each}
      </div>
    {:else if hasSessions}
      <div class="pt-1.5">
        {#each activeTasks as task (task.id)}
          {@render taskRow(task, "active")}
        {/each}
      </div>

      {#if snoozedTasks.length > 0}
        <div class="flex items-center gap-2 px-2 pt-4 pb-1.5">
          <span class={SHEET_SECTION_LABEL}>Snoozed</span>
          <span class="h-px flex-1 bg-(--hairline)"></span>
          <span class="font-mono {SHEET_ROW_META} opacity-70">{snoozedTasks.length}</span>
        </div>
        {#each snoozedTasks as task (task.id)}
          {@render taskRow(task, "snoozed")}
        {/each}
      {/if}

      {#if completedTasks.length > 0}
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 pt-4 pb-1.5 text-left [-webkit-tap-highlight-color:transparent]"
          aria-expanded={isCompletedExpanded}
          onclick={() => (completedExpanded = !completedExpanded)}
        >
          <span class={SHEET_SECTION_LABEL}>Completed</span>
          <span class="h-px flex-1 bg-(--hairline)"></span>
          <span class="font-mono {SHEET_ROW_META} opacity-70">{completedTasks.length}</span>
          <CaretRightIcon
            size={14}
            class="shrink-0 text-(--muted-foreground) transition-transform duration-150 {isCompletedExpanded ? 'rotate-90' : ''}"
          />
        </button>
        {#if isCompletedExpanded}
          <div transition:slide={{ duration: reduceMotion ? 0 : 120, easing: cubicOut }}>
            {#each completedTasks as task (task.id)}
              {@render taskRow(task, "completed")}
            {/each}
          </div>
        {/if}
      {/if}
    {:else}
      <!-- At the top of the pane, with the move that fixes it — not 600px of
           void with a button centred in it. -->
      <div class="mt-3 rounded-2xl bg-(--card) p-4 shadow-[shadow:var(--elev-ring)]">
        <div class="font-semibold tracking-[-0.01em] text-(--solus-text-primary)">
          {searching ? "No matching tasks" : "No open tasks"}
        </div>
        <p class="mt-1.5 leading-[1.6] text-(--muted-foreground) text-pretty">
          {searching
            ? `Nothing in ${totalTasks} task${totalTasks === 1 ? "" : "s"} matches “${taskQuery.trim()}”.`
            : "Start one here, or reopen something from your history."}
        </p>
        <button
          type="button"
          class="mt-3 h-11 w-full cursor-pointer rounded-lg border-0 bg-(--primary) font-semibold text-(--primary-foreground) [-webkit-tap-highlight-color:transparent]"
          onclick={searching ? () => (taskQuery = "") : newSession}
        >
          {searching ? "Clear search" : "New task"}
        </button>
      </div>
    {/if}
  </div>

  <!--
    The only navigation surface besides the two home cards, so it carries all
    five destinations rather than the three it started with. Labels are short
    because the slot is 62px and a cut label is worse than an abbreviated one;
    the glyphs are the ones the desktop rail uses, so a destination looks the
    same on both surfaces.
  -->
  <footer
    class="flex shrink-0 border-t border-(--hairline) px-1.5 pt-1.5 pb-[max(0.25rem,env(safe-area-inset-bottom,0px))]"
  >
    {#snippet footBtn(
      id: MobileSectionId,
      label: string,
      Icon: typeof GearIcon,
      action: () => void,
    )}
      {@const signal = mobileSectionSignal(id, sectionSignals)}
      {@const isCurrent = currentSection === id}
      <button
        type="button"
        class="relative flex h-[3.25rem] min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border-0 px-0.5 font-medium [-webkit-tap-highlight-color:transparent] {isCurrent
          ? 'bg-(--wash-2) text-(--solus-accent)'
          : 'bg-transparent text-(--muted-foreground) active:bg-(--wash-1) active:text-(--solus-text-secondary)'}"
        aria-current={isCurrent ? "page" : undefined}
        onclick={() => nav(action)}
      >
        <span class="relative flex shrink-0 items-center justify-center">
          <Icon size={18} />
          <!-- The number that decides whether you tap it, in the same two tones
               the home cards use: motion for a run, attention for a review. -->
          {#if signal}
            <span
              class="absolute -top-1 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs font-semibold tabular-nums {signal.tone ===
              'running'
                ? 'bg-(--running) text-(--background)'
                : 'bg-(--primary) text-(--primary-foreground)'}"
            >{signal.count}</span>
          {/if}
        </span>
        <span class="max-w-full truncate">{label}</span>
      </button>
    {/snippet}
    {@render footBtn("workspace", "Workspace", BooksIcon, () => session.toggleFolio())}
    {@render footBtn("tasks", "Tasks", ListChecksIcon, () => session.openTasks())}
    {@render footBtn("prs", "PRs", PullRequestIcon, () => session.openPrs())}
    {@render footBtn("history", "History", ClockIcon, () => window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")))}
    {@render footBtn("settings", "Settings", GearIcon, () => session.showSettings())}
  </footer>
</div>

{#if snoozeTarget}
  <SnoozeTaskMenu
    taskTitle={snoozeTarget.task.title}
    anchor={snoozeTarget.anchor}
    onConfirm={(until, note) => {
      store.snoozeRow(snoozeTarget!.task.key, until, note);
      revealedRowKey = null;
      snoozeTarget = null;
    }}
    onClose={() => (snoozeTarget = null)}
  />
{/if}
