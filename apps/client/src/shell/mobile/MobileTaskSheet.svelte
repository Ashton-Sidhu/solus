<script lang="ts">
  import {
    Check as CheckIcon,
    ChevronRight as CaretRightIcon,
    Folder as FolderIcon,
    GitBranch as GitBranchIcon,
    GitCompareArrows as GitDiffIcon,
    GitPullRequest as GitPullRequestIcon,
    Globe as GlobeIcon,
    ListChecks as ListChecksIcon,
    Moon as MoonIcon,
    Plus as PlusIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import {
    SHEET_CARD,
    SHEET_ROW_LABEL,
    SHEET_ROW_META,
    SHEET_SECTION_LABEL,
  } from "./lib/sheet-styles";
  import { localApi } from "@solus/client-core/local-api";
  import { parseGitHubPullRequestUrl } from "@solus/contracts/providers";
  import { projectScopeOf } from "@solus/contracts/types";
  import {
    getWorkspaceContext,
    getPullRequestsContext,
    getSessionEnvironmentStore,
    getSessionSidebarStore,
    hostStatusDotClass,
    hostStatusLabel,
    serversStore,
  } from "@solus/workspace-ui/contexts";
  import { projectDirLabel } from "@solus/workspace-ui/lib/paths";
  import {
    mobileBranchLabel,
    mobileChangesSummary,
    mobileCurrentBranch,
    mobilePullRequestRow,
    type MobilePullRequestRow,
  } from "./lib/mobile-branch";
  import GitDropdown from "@solus/workspace-ui/components/GitDropdown.svelte";
  import SnoozeTaskMenu from "@solus/workspace-ui/components/session/SnoozeTaskMenu.svelte";
  import { formatElapsed } from "@solus/workspace-ui/components/session/lib/task-list";
  import { taskRef } from "@solus/workspace-ui/components/tasks/task-page/lib/task-page";
  import { liveActivityClock } from "@solus/workspace-ui/lib/shared-clock";
  import { requestInputFocus } from "@solus/workspace-ui/lib/inputFocus";
  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import type { WorktreeEntry } from "@solus/contracts/types";
  import type { SidebarSessionChild } from "@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte";
  import MobileSheet from "./MobileSheet.svelte";
  import MobileStateGlyph from "./MobileStateGlyph.svelte";
  import { MOBILE_STATE_INK, mobileSessionState } from "./lib/mobile-task-row";

  interface Props {
    open: boolean;
    onClose: () => void;
    onOpenServers: () => void;
    /** Open the branch's own changes on the diff. */
    onReviewBranch: () => void;
  }
  let { open, onClose, onOpenServers, onReviewBranch }: Props = $props();

  const session = getWorkspaceContext();
  const sidebar = getSessionSidebarStore();
  const environmentStore = getSessionEnvironmentStore();
  const pullRequests = getPullRequestsContext();

  // This sheet is the phone's answer to "where am I": the task, the project and
  // host it runs on, and every run inside it. The desktop breadcrumb states the
  // same three things across the top of a 1440px window.
  const tabId = $derived(session.activeTabId);
  const sess = $derived(session.sessionFor(tabId));
  const task = $derived(sidebar.taskForTab(tabId));
  const durableTask = $derived(
    session.tasksStore.peek(task?.taskId),
  );
  const taskFinished = $derived(
    durableTask
      ? durableTask.status === "done" || durableTask.status === "dropped"
      : task?.status === "done",
  );
  const sessions = $derived(task ? sidebar.sessionsFor(task) : []);
  const runningCount = $derived(
    sessions.filter((child) => child.attention === "running").length,
  );

  const projectLabel = $derived(
    projectDirLabel(
      sess?.run.gitContext?.repoRoot ?? sess?.run.workingDirectory ?? "~",
      session.staticInfo?.workspacePath,
    ),
  );
  const host = $derived(serversStore.hostFor(sess?.run.serverId));
  // A host Solus has no saved entry for reports nothing rather than guessing;
  // "not checked" is exactly what the dot's fifth state means.
  const hostStatus = $derived(host && "status" in host ? host.status : "saved");

  const pendingDispatch = $derived(
    sess?.run.pendingHostDispatch?.intent === "dispatch"
      ? sess.run.pendingHostDispatch
      : null,
  );
  const selectedDispatchWorktree = $derived(pendingDispatch?.worktree ?? null);
  const selectedDispatchBaseBranch = $derived(pendingDispatch?.baseBranch ?? null);
  // The live environment, not the checkout captured at start: a switch made
  // inside the session shows here the same frame it shows in the desktop rail.
  const environment = $derived(environmentStore.environmentFor(sess?.run));
  const branch = $derived(
    mobileCurrentBranch(environment) ?? sess?.run.gitContext?.branch,
  );
  const displayedWorktree = $derived(
    selectedDispatchWorktree?.branch ??
      selectedDispatchBaseBranch ??
      (pendingDispatch ? "New worktree" : branch),
  );
  // What the rows print: the picker keeps the raw ref above, the rows drop a
  // worktree's `solus/` prefix the way the navbar and the desktop rail do.
  const displayedBranchLabel = $derived(
    pendingDispatch ? displayedWorktree : (mobileBranchLabel(environment) ?? displayedWorktree),
  );

  // --- The branch's changes and its pull request ---------------------------
  // The same three facts the desktop Git section states in its rows. The
  // navbar already holds the details watch and the pull request read for the
  // session on screen, so this sheet only reads what those landed.
  const gitStatus = $derived(environment.status);
  const hasGitStatus = $derived(!!environment.branch && !!gitStatus);
  const changesSummary = $derived(mobileChangesSummary(gitStatus));
  const environmentCtx = $derived(
    environment.cwd && environment.cwd !== "~"
      ? session.ctxForEnvironment(environment.cwd, environment.checkout, tabId)
      : null,
  );
  const environmentServerId = $derived(sess ? session.serverIdFor(tabId) : null);
  const branchPullRequest = $derived(
    pullRequests.projects
      .at(environmentServerId, environmentCtx ? projectScopeOf(environmentCtx.session) : null)
      ?.prForBranch(mobileCurrentBranch(environment)) ?? null,
  );
  const pullRequestRow = $derived(mobilePullRequestRow(gitStatus, branchPullRequest));

  function reviewBranch() {
    onClose();
    onReviewBranch();
  }

  /** The pull request review page for the branch's pull request. A link the
   *  host named but this client cannot read as a GitHub number opens in the
   *  browser, the way the desktop rail's "View pull request" does. */
  function openPullRequest(row: Exclude<MobilePullRequestRow, { kind: "none" }>) {
    onClose();
    const ctx = environmentCtx;
    if (!ctx || !environmentServerId) return;
    if (row.kind === "open") {
      // An open row exists only once the store described the pull request.
      if (branchPullRequest) {
        void session.openPullRequest(branchPullRequest, {
          ctx,
          serverId: environmentServerId,
          via: "click",
        });
      }
      return;
    }
    const parsed = parseGitHubPullRequestUrl(row.url);
    if (!parsed) {
      void localApi.openExternal(row.url);
      return;
    }
    void session.openPullRequest(
      { number: parsed.number, url: parsed.url, expectedRepo: parsed.baseRepo },
      { ctx, serverId: environmentServerId, via: "click" },
    );
  }

  let gitOpen = $state(false);
  let gitTriggerEl: HTMLButtonElement | null = $state(null);
  let snoozeAnchor = $state<HTMLElement | null>(null);

  // Ticks only while something under this task is running.
  let now = $state(Date.now());
  $effect(() => {
    if (!open || runningCount === 0) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  function selectBranch(picked: string) {
    if (pendingDispatch) return;
    // The branch you are already on means this checkout as it stands,
    // uncommitted work and all, so it names no base to cut a worktree from.
    session.setWorktreeBaseBranch(picked === branch ? null : picked);
  }

  async function selectWorktree(worktree: WorktreeEntry) {
    if (pendingDispatch) {
      session.setDispatchWorktree(worktree, tabId);
      return;
    }
    await session.switchToWorktree(worktree.path, tabId);
  }

  function selectNewDispatchWorktree(baseBranch?: string) {
    if (baseBranch) session.setDispatchBaseBranch(baseBranch, tabId);
    else session.setDispatchWorktree(null, tabId);
  }

  async function completeTask() {
    if (!task) return;
    try {
      await sidebar.completeTask(task);
      onClose();
    } catch (error) {
      toasts.error(
        `Couldn't update task: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A drop removes the row and nothing else — the session and its history stay
   *  on the host, which is why five seconds of undo is enough. */
  function dropTask() {
    if (!task) return;
    const dropped = task;
    sidebar.closeTask(dropped);
    onClose();
    toasts.show({
      message: `Dropped “${dropped.title}”`,
      actions: [{ label: "Undo", onAction: () => void sidebar.selectTask(dropped) }],
    });
  }

  /** The task's own page — the sheet names the task, so it has to be able to
   *  reach it. A phone has no breadcrumb menu to right-click. */
  function openTaskPage() {
    const taskId = task?.taskId;
    if (!taskId) return;
    onClose();
    session.goToTask(taskId, "click");
  }

  function newSessionInTask() {
    session.openSessionDraft({ via: "click" });
    onClose();
    requestInputFocus();
  }

  function openSession(child: SidebarSessionChild) {
    void sidebar.selectChild(child);
    onClose();
    requestInputFocus();
  }

</script>

<MobileSheet
  {open}
  {onClose}
  title={task?.title ?? "This session"}
  subtitle={[task?.projectLabel, durableTask ? taskRef(durableTask) : ""].filter(Boolean).join(" / ")}
>
  {#if task}
    <div class="flex flex-col gap-2 px-4 pt-1">
      {#if task.taskId}
        <button
          type="button"
          class="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-transparent font-semibold text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.99] [-webkit-tap-highlight-color:transparent]"
          onclick={openTaskPage}
        >
          <ListChecksIcon size={16} />Open task page
        </button>
      {/if}
      <div class="flex gap-2">
        <button
          type="button"
          class="flex h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-0 bg-transparent font-medium text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.97] [-webkit-tap-highlight-color:transparent]"
          onclick={(e) => (snoozeAnchor = e.currentTarget)}
        >
          <MoonIcon size={15} />Snooze
        </button>
        <button type="button" class="flex h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-0 bg-transparent font-medium text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.97] [-webkit-tap-highlight-color:transparent]" onclick={completeTask}>
          <CheckIcon size={15} style="color:{MOBILE_STATE_INK.success}" />{taskFinished ? "Reopen" : "Complete"}
        </button>
        <button
          type="button"
          class="flex h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-0 bg-transparent font-medium transition-transform duration-[120ms] active:scale-[0.97] [-webkit-tap-highlight-color:transparent]"
          style="box-shadow:0 0 0 0.03125rem color-mix(in oklch, var(--failure) 40%, transparent);color:{MOBILE_STATE_INK.failure}"
          onclick={dropTask}
        >
          <XIcon size={15} />Drop
        </button>
      </div>
    </div>
  {/if}

  <div class="flex flex-col gap-4 px-4 pt-4 text-sm">
    <!-- Where this runs. The two rows the navbar used to stack as chips. -->
    <div class={SHEET_CARD}>
      <button
        type="button"
        class="flex h-[3.125rem] w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 text-left active:bg-(--wash-1) [-webkit-tap-highlight-color:transparent]"
        onclick={() => {
          onClose();
          window.dispatchEvent(
            new CustomEvent("solus:open-directory-picker", {
              detail: { requesterId: tabId },
            }),
          );
        }}
      >
        <FolderIcon size={15} class="shrink-0 text-(--muted-foreground)" />
        <span class="min-w-0 flex-1 truncate {SHEET_ROW_LABEL}">
          {task?.projectLabel ?? projectLabel}
        </span>
        {#if displayedBranchLabel}
          <span class="shrink-0 truncate font-mono {SHEET_ROW_META}">{displayedBranchLabel}</span>
        {/if}
      </button>

      {#if displayedWorktree}
        <div class="h-px bg-(--hairline)"></div>
        <button
          bind:this={gitTriggerEl}
          type="button"
          class="flex h-[3.125rem] w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 text-left active:bg-(--wash-1) [-webkit-tap-highlight-color:transparent]"
          onclick={() => (gitOpen = !gitOpen)}
        >
          <GitBranchIcon size={15} class="shrink-0 text-(--muted-foreground)" />
          <span class="min-w-0 flex-1 truncate {SHEET_ROW_LABEL}">Branch</span>
          <span class="shrink-0 truncate font-mono {SHEET_ROW_META}">{displayedBranchLabel}</span>
        </button>
      {/if}

      {#if host}
        <div class="h-px bg-(--hairline)"></div>
        <button
          type="button"
          class="flex h-[3.125rem] w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 text-left active:bg-(--wash-1) [-webkit-tap-highlight-color:transparent]"
          onclick={onOpenServers}
        >
          <GlobeIcon size={15} class="shrink-0 text-(--muted-foreground)" />
          <span class="min-w-0 flex-1 truncate {SHEET_ROW_LABEL}">{host.label}</span>
          <!-- The availability dot the servers sheet already uses, from the same
               table: five host states, one of which is "connecting" — which the
               two words this row used to print could not say. -->
          <span
            class="size-2 shrink-0 rounded-full {hostStatusDotClass(hostStatus)}"
            role="img"
            aria-label={hostStatusLabel(hostStatus)}
          ></span>
        </button>
      {/if}
    </div>

    <!-- What is on the branch: its uncommitted work, opened on the diff, and
         the pull request that stands for it. Only once Git has answered — a
         card that said "None" before the tree was read would be lying. -->
    {#if sess && hasGitStatus}
      <div class="flex flex-col gap-2.5">
        <span class="px-0.5 {SHEET_SECTION_LABEL}">Changes</span>
        <div class={SHEET_CARD}>
          <button
            type="button"
            class="flex h-[3.125rem] w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 text-left active:bg-(--wash-1) [-webkit-tap-highlight-color:transparent]"
            onclick={reviewBranch}
          >
            <GitDiffIcon size={15} class="shrink-0 text-(--muted-foreground)" />
            <span class="min-w-0 flex-1 truncate {SHEET_ROW_LABEL}">Review changes</span>
            {#if changesSummary}
              <span class="shrink-0 truncate font-mono {SHEET_ROW_META}">{changesSummary}</span>
            {/if}
            <CaretRightIcon size={15} class="shrink-0 text-(--muted-foreground) opacity-70" />
          </button>
          <div class="h-px bg-(--hairline)"></div>
          {#if pullRequestRow.kind === "none"}
            <!-- Not a button: there is nothing to open, and the answer to
                 "is there a pull request already" is the row itself. -->
            <div class="flex h-[3.125rem] w-full items-center gap-2.5 px-3.5">
              <GitPullRequestIcon size={15} class="shrink-0 text-(--muted-foreground)" />
              <span class="min-w-0 flex-1 truncate {SHEET_ROW_LABEL}">Pull request</span>
              <span class="shrink-0 {SHEET_ROW_META}">None</span>
            </div>
          {:else}
            {@const row = pullRequestRow}
            <button
              type="button"
              class="flex h-[3.125rem] w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 text-left active:bg-(--wash-1) [-webkit-tap-highlight-color:transparent]"
              onclick={() => openPullRequest(row)}
            >
              <!-- Open is the host's green; a draft stays neutral, because it
                   is not asking to land yet. -->
              <GitPullRequestIcon
                size={15}
                class="shrink-0"
                style={row.kind === "open" && !row.draft
                  ? `color:${MOBILE_STATE_INK.success}`
                  : "color:var(--muted-foreground)"}
              />
              <span class="min-w-0 flex-1 truncate {SHEET_ROW_LABEL}">
                {row.kind === "open" ? row.title : "Pull request"}
              </span>
              <span class="shrink-0 font-mono tabular-nums {SHEET_ROW_META}">
                {#if row.kind === "open"}
                  {row.draft ? `Draft #${row.number}` : `#${row.number}`}
                {:else if row.number !== null}
                  #{row.number}
                {:else}
                  Linked
                {/if}
              </span>
              <CaretRightIcon size={15} class="shrink-0 text-(--muted-foreground) opacity-70" />
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- The runs inside this task, current first. This is where the hierarchy
         project / task / session becomes visible on a phone. -->
    {#if sessions.length > 0}
      <div class="flex flex-col gap-2.5">
        <div class="flex items-baseline gap-2 px-0.5">
          <span class={SHEET_SECTION_LABEL}>Sessions</span>
          <span class="flex-1"></span>
          <span class="font-mono {SHEET_ROW_META} opacity-75">
            {sessions.length} run{sessions.length === 1 ? "" : "s"}
          </span>
        </div>
        <div class={SHEET_CARD}>
          {#each sessions as child, index (child.sessionId ?? child.tabId ?? index)}
            {@const isCurrent = child.tabId === tabId}
            {@const state = mobileSessionState(child.attention)}
            {#if index > 0}<div class="h-px bg-(--hairline)"></div>{/if}
            <button
              type="button"
              class="flex h-[3.75rem] w-full cursor-pointer items-center gap-2.5 border-0 px-3.5 text-left [-webkit-tap-highlight-color:transparent] {isCurrent
                ? 'bg-[color-mix(in_oklch,var(--primary)_9%,transparent)]'
                : 'bg-transparent active:bg-(--wash-1)'}"
              aria-label={state.label ? `${child.label} — ${state.label}` : child.label}
              onclick={() => openSession(child)}
            >
              <!-- The mark states the run's state; the button above states it in
                   words, so the slot is decoration to a screen reader. Idle keeps
                   the slot filled rather than leaving the rows unaligned. -->
              <span
                class="flex w-[1.375rem] shrink-0 items-center justify-center"
                style="color:{MOBILE_STATE_INK[state.tone]}"
                aria-hidden="true"
              >
                <MobileStateGlyph glyph={state.glyph} size={14} />
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="truncate {SHEET_ROW_LABEL}">
                  {child.label}{#if isCurrent}<span class="font-normal text-(--muted-foreground)">&nbsp;· current</span>{/if}
                </span>
                {#if child.branchName}
                  <span class="truncate font-mono {SHEET_ROW_META} text-(--muted-foreground)"
                    >{child.branchName}</span
                  >
                {/if}
              </span>
              {#if child.runStartedAt}
                <span class="shrink-0 font-mono tabular-nums {SHEET_ROW_META}">
                  {formatElapsed(now - child.runStartedAt)}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- A new run starts from the task it belongs to, not from the drawer. -->
    <button
      type="button"
      class="flex h-[2.875rem] cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-transparent font-semibold text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] transition-transform duration-[120ms] active:scale-[0.99] [-webkit-tap-highlight-color:transparent]"
      onclick={newSessionInTask}
    >
      <PlusIcon size={16} />New session in this task
    </button>
  </div>
</MobileSheet>

{#if snoozeAnchor && task}
  <SnoozeTaskMenu
    taskTitle={task.title}
    anchor={snoozeAnchor}
    onConfirm={(until, note) => {
      sidebar.snoozeRow(task.key, until, note);
      snoozeAnchor = null;
      onClose();
    }}
    onClose={() => (snoozeAnchor = null)}
  />
{/if}

{#if displayedWorktree && sess}
  <GitDropdown
    bind:open={gitOpen}
    triggerEl={gitTriggerEl}
    displayBranch={displayedWorktree}
    selectedBranch={selectedDispatchWorktree?.branch ??
      selectedDispatchBaseBranch ??
      sess.run.worktree?.baseBranch ??
      displayedWorktree}
    workingDirectory={sess.run.gitContext?.worktreePath ?? sess.run.workingDirectory}
    run={sess.run}
    onSelectBranch={selectBranch}
    onSelectWorktree={selectWorktree}
    onSelectNewWorktree={selectNewDispatchWorktree}
  />
{/if}
