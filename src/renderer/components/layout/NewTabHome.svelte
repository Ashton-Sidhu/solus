<script lang="ts" module>
  import { projectsStore } from "../../contexts/projects.store.svelte";

  export function invalidateHomeCache(): void {
    projectsStore.invalidateRecentProjects();
  }
</script>

<script lang="ts">
  import {
    FolderOpenIcon,
    GitBranchIcon,
    GitForkIcon,
    ArrowRightIcon,
    CaretDownIcon,
    LightningIcon,
    CheckCircleIcon,
    XCircleIcon,
    CircleNotchIcon,
    ClockCountdownIcon,
    ArrowSquareInIcon,
  } from "phosphor-svelte";
  import { untrack } from "svelte";
  import { getGitStatusStore } from "../../contexts/git-status.store.svelte";
  import { createSessionHistoryStore } from "../../contexts/session-history.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import { abbreviateHome } from "../../lib/paths";
  import { formatTimeAgo } from "../../lib/sessionUtils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { sessionHistorySourcesFromRoots } from "../../lib/sessionPickerHistory";
  import {
    formatBranchDisplayName,
    sessionEnvironment,
  } from "../../lib/git-context";
  import { comboHint } from "../../lib/keybindings/manifest";
  import type {
    Tab,
    Automation,
    RecentProject,
    SessionMeta,
  } from "../../../shared/types";
  import { worktreeProjectRoot } from "../../../shared/types";
  import type { Task } from "../../../shared/task-types";
  import {
    recentAutomationActivity,
    latestRun,
    runPreview,
    nextTasks,
    taskCounts,
  } from "./lib/home-control-hub";
  import { relativeTime } from "../automations/lib/automation-format";
  import { STATUS_META } from "../tasks/lib/tasks-api";
  import SetupChecklist from "../server-setup/SetupChecklist.svelte";
  import Kbd from "../ui/Kbd.svelte";

  // Shared fade-in for staggered list items; per-item delay via --item-index.
  const fadeIn =
    "[animation:home-fade-in_0.2s_ease-out_both] [animation-delay:calc(var(--item-index,0)*40ms)]";
  const sectionLabel =
    "text-[0.6875rem] uppercase tracking-wide font-medium px-1 text-(--solus-text-tertiary)";

  interface Props {
    tab?: Tab;
  }
  let { tab }: Props = $props();

  const session = getWorkspaceContext();
  const gitStatus = getGitStatusStore();
  const windowCtx = getWindowContext();
  const sess = $derived(tab ? session.sessionFor(tab.id) : undefined);
  const isEditorMode = $derived(
    windowCtx.viewMode === "editor" || windowCtx.isWeb,
  );
  const isMobile = $derived(runtime.isMobileViewport);
  // On laptop-width screens, trim the recent-sessions list to reclaim vertical
  // space — reuse the app's 1800px laptop/desktop cutoff (see InputBarRow).

  let sessionsLoaded = $state(false);
  let sessionsLoadSeq = 0;
  const projectMetadata = projectsStore;
  const projects = $derived(projectMetadata.recentProjects.slice(0, 3));
  const recentSessions = createSessionHistoryStore();
  const sessions = $derived(recentSessions.sessions);

  const currentDir = $derived(
    sess?.workingDirectory || session.globalDefaults.workingDirectory || "~",
  );
  const projectRoot = $derived(
    currentDir && currentDir !== "~" ? worktreeProjectRoot(currentDir) : null,
  );
  const gitRefs = $derived(gitStatus.refsFor(projectRoot));
  const worktrees = $derived(gitRefs.worktrees);
  // One environment model so the hero matches the sidebar/panel. No live status
  // needed here — the hero is about identity (branch name) and worktree intent.
  const env = $derived(
    sessionEnvironment(
      sess?.gitContext ?? session.globalDefaults.gitContext,
      sess?.worktreeBaseBranch ?? null,
    ),
  );
  const worktreeBaseBranch = $derived(
    sess?.gitContext?.targetBranch ??
      session.globalDefaults.gitContext?.targetBranch ??
      "main",
  );
  // Worktree start only makes sense on a git repo that isn't already isolated.
  const canToggleWorktree = $derived(
    !!sess?.gitContext?.targetBranch && !sess?.gitContext?.worktreePath,
  );
  const isActiveHome = $derived(
    tab ? session.activeTabId === tab.id : session.tabOrder.length === 0,
  );

  function toggleWorktree() {
    if (!canToggleWorktree) return;
    session.toggleWorktreeMode();
    requestInputFocus();
  }

  // ── Launch target: the cwd the next session starts in ──
  const workspacePath = $derived(session.staticInfo?.workspacePath ?? null);
  const isWorkspaceTarget = $derived(
    !!workspacePath &&
      currentDir.replace(/\/+$/, "") === workspacePath.replace(/\/+$/, ""),
  );
  const launchName = $derived(
    isWorkspaceTarget
      ? "your workspace"
      : currentDir.replace(/\/+$/, "").split("/").pop() ||
          abbreviateHome(currentDir),
  );
  const sessionsLabel = $derived(
    isWorkspaceTarget ? "Recent in workspace" : `Recent in ${launchName}`,
  );
  const visibleSessions = $derived(sessions.slice(0, 3));

  function changeDirectory() {
    window.dispatchEvent(new Event("solus:open-directory-picker"));
  }

  function goToWorkspace() {
    if (!workspacePath || isWorkspaceTarget) return;
    invalidateHomeCache();
    void session.setBaseDirectory(workspacePath).then(
      () => requestInputFocus(),
      () => {},
    );
  }

  const visibleWorktrees = $derived(worktrees.slice(0, 3));

  // Empty-session tabs and the zero-tab home both mount NewTabHome. Hidden tab
  // homes stay quiet, while the zero-tab home loads against the global defaults.
  // Loaded flags start false, so a just-activated home shows its skeleton rather
  // than flashing empty while the first fetch resolves.
  $effect(() => {
    if (!isActiveHome) return;
    void projectMetadata.recentVersion;
    untrack(() => {
      void projectMetadata.loadRecentProjects();
    });
  });

  // Recent sessions for the launch-target directory — refetches whenever the
  // target cwd changes so the list reflects where the next session will run.
  $effect(() => {
    if (!isActiveHome) return;
    const cacheVersion = projectMetadata.recentVersion;
    const dir = currentDir;
    if (!dir || dir === "~") {
      sessionsLoadSeq++;
      recentSessions.cancel({ clear: true });
      sessionsLoaded = true;
      return;
    }
    const seq = ++sessionsLoadSeq;
    sessionsLoaded = false;
    const ctx = untrack(() => session.ctxForDirectory(dir));
    void recentSessions
      .load({
        sources: sessionHistorySourcesFromRoots([dir]),
        ctx,
        scopeKey: `home:${cacheVersion}:${dir}`,
      })
      .finally(() => {
        if (seq !== sessionsLoadSeq || currentDir !== dir) return;
        sessionsLoaded = true;
      });
  });

  $effect(() => {
    if (!isActiveHome) return;
    if (!projectRoot) return;
    const root = projectRoot;
    const ctx = untrack(() => session.ctxForDirectory(root));
    void gitStatus.refreshRefs(root, ctx);
  });

  // ── Control hub: automations + tasks ──
  const automationsStore = session.automationsStore;
  const tasksStore = session.tasksStore;

  $effect(() => {
    if (!isActiveHome) return;
    void automationsStore.loadAll();
  });

  const automationActivity = $derived(
    recentAutomationActivity(automationsStore.items, 3),
  );

  // Lazily pull run history for the shown automations so each row can preview
  // its latest output — the whole reason they're surfaced ("what did it do?").
  $effect(() => {
    if (!isActiveHome) return;
    for (const a of automationActivity) {
      if (!automationsStore.runs.has(a.id))
        void automationsStore.loadRuns(a.id);
    }
  });

  function automationOutput(a: Automation): string {
    return runPreview(latestRun(automationsStore.runs.get(a.id)));
  }
  const hasAutomations = $derived(automationActivity.length > 0);

  // Tasks for the launch-target directory. The store is project-scoped and
  // shared, so reads are guarded on cwd to never render a stale project.
  $effect(() => {
    if (!isActiveHome) return;
    const dir = currentDir;
    if (dir && dir !== "~") void tasksStore.load(dir).catch(() => {});
  });
  const tasksForDir = $derived(
    tasksStore.cwd === currentDir && !tasksStore.error ? tasksStore.tasks : [],
  );
  const visibleTasks = $derived(nextTasks(tasksForDir, 3));
  const tCounts = $derived(taskCounts(tasksForDir));
  const hasTasks = $derived(visibleTasks.length > 0);

  function openAutomation(a: Automation) {
    session.openAutomations(a.id);
    requestInputFocus();
  }
  function viewAllAutomations() {
    session.openAutomations();
    requestInputFocus();
  }
  function openTask(t: Task) {
    session.goToTask(t);
    requestInputFocus();
  }
  function viewAllTasks() {
    session.toggleTasks();
    requestInputFocus();
  }

  const totalItems = $derived(projects.length + visibleSessions.length);

  function activateProject(proj: RecentProject) {
    invalidateHomeCache();
    void session.setBaseDirectory(proj.path).then(
      () => requestInputFocus(),
      () => {},
    );
  }

  function activateSession(meta: SessionMeta) {
    void session.resumeSession(meta);
  }

  function activateWorktree(wt: WorktreeEntry) {
    void session.switchToWorktree(wt.path).then(
      () => requestInputFocus(),
      () => {},
    );
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (tab && session.activeTabId !== tab.id) return;
    if ((sess?.messages.length ?? 0) > 0) return;

    // ⌥W = snap the launch target back to the workspace
    if (
      e.altKey &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      e.code === "KeyW"
    ) {
      if (workspacePath && !isWorkspaceTarget) {
        e.preventDefault();
        goToWorkspace();
      }
      return;
    }

    const match = e.code.match(/^Digit(\d)$/);
    if (!match) return;
    const num = parseInt(match[1], 10);

    // ⌥1-5 = worktrees (opt + digit, no shift)
    if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (num < 1 || num > visibleWorktrees.length) return;
      e.preventDefault();
      activateWorktree(visibleWorktrees[num - 1]);
      return;
    }

    // ⌥⇧1-8 = projects then sessions
    if (!e.altKey || !e.shiftKey) return;
    if (num < 1 || num > totalItems) return;
    e.preventDefault();
    const idx = num - 1;
    if (idx < projects.length) {
      activateProject(projects[idx]);
    } else {
      const sessionIdx = idx - projects.length;
      if (sessionIdx < visibleSessions.length) {
        activateSession(visibleSessions[sessionIdx]);
      }
    }
  }

  let projectScrollEl = $state<HTMLDivElement | null>(null);
  let showScrollFadeRight = $state(true);
  let activeProjectDot = $state(0);
  let currentCardIndex = 0;
  let touchStartX = 0;

  function getCardWidth(): number {
    if (!projectScrollEl || !projectScrollEl.children[0]) return 210;
    const card = projectScrollEl.children[0] as HTMLElement;
    return card.offsetWidth + 10;
  }

  function scrollToCard(index: number) {
    if (!projectScrollEl) return;
    const clamped = Math.max(0, Math.min(index, projects.length - 1));
    currentCardIndex = clamped;
    activeProjectDot = clamped;
    projectScrollEl.scrollTo({
      left: clamped * getCardWidth(),
      behavior: "smooth",
    });
  }

  function onProjectTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
  }

  function onProjectTouchEnd(e: TouchEvent) {
    const diff = touchStartX - e.changedTouches[0].clientX;
    const threshold = 40;
    if (diff > threshold) {
      scrollToCard(currentCardIndex + 1);
    } else if (diff < -threshold) {
      scrollToCard(currentCardIndex - 1);
    } else {
      scrollToCard(currentCardIndex);
    }
  }

  function updateScrollIndicators() {
    if (!projectScrollEl) return;
    const { scrollLeft, scrollWidth, clientWidth } = projectScrollEl;
    showScrollFadeRight = scrollLeft + clientWidth < scrollWidth - 10;
  }

  $effect(() => {
    if (projectScrollEl) updateScrollIndicators();
  });

  function sessionTitle(meta: SessionMeta): string {
    return (
      meta.customTitle ||
      meta.firstMessage?.replace(/\s+/g, " ") ||
      meta.slug ||
      "Unnamed session"
    );
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<!-- On/off switch shared by the two worktree rows so both speak the same control
     language (the per-session toggle and the persistent default). -->
{#snippet wtSwitch(on: boolean)}
  <span
    class="relative w-[2.125rem] h-[1.1875rem] rounded-full border shrink-0 [transition:background_0.2s_ease,border-color_0.2s_ease] {on
      ? 'bg-(--solus-accent) border-(--solus-accent)'
      : 'bg-(--solus-surface-secondary) border-(--solus-container-border) group-hover/wt:border-(--solus-accent-border-medium)'}"
  >
    <span
      class="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12)] [transition:left_0.2s_ease]"
      style="left:{on ? 16 : 2}px"
    ></span>
  </span>
{/snippet}

<!-- Launch target hero: the directory the next session runs in (shared by all viewports) -->
{#snippet launchTarget()}
  <div
    class="flex flex-col items-center gap-3 w-full py-[clamp(0.75rem,3vw,1.25rem)] {fadeIn}"
    style="--item-index:0"
  >
    <div
      class="flex flex-row items-center gap-[clamp(0.625rem,2vw,1rem)] max-w-full min-w-0"
    >
      <span
        class="inline-flex flex-none w-[clamp(2.25rem,7vw,3rem)] h-[clamp(2.25rem,7vw,3rem)] text-(--solus-accent)"
        aria-hidden="true"
      >
        <svg viewBox="0 0 18 18" fill="none" class="w-full h-full">
          <circle cx="9" cy="9" r="4.8" fill="currentColor" />
          <g stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <path d="M9,1 A8,8 0 0 1 17,9" />
            <path d="M15.72,14.44 A8,8 0 0 1 6.44,16.68" />
            <path d="M2.28,14.44 A8,8 0 0 1 1,6.44" />
          </g>
        </svg>
      </span>
      <div class="flex flex-col items-start gap-1 min-w-0">
        <div
          class="flex flex-wrap items-center justify-start gap-[0.4375rem] max-w-full min-w-0 text-[clamp(1.25rem,1rem+1.8vw,1.625rem)] font-light leading-[1.2] tracking-[-0.01em]"
        >
          <span class="flex-none text-(--solus-text-secondary)"
            >Starting in</span
          >
          <button
            class="group/dir inline-flex items-center gap-1.5 max-w-full min-w-0 py-px px-1.5 mx-[-0.125rem] rounded-[0.625rem] bg-transparent border-none cursor-pointer [font-family:inherit] [font-size:inherit] [line-height:inherit] font-semibold text-(--solus-text-primary) transition-[background-color,color] duration-150 hover:bg-(--solus-accent-light) hover:text-(--solus-accent)"
            onclick={changeDirectory}
            title={`Change directory (${comboHint("global.select-project")})`}
          >
            <span class="truncate min-w-0">{launchName}</span>
            <span
              class="inline-flex flex-none text-(--solus-text-tertiary) transition-[transform,color] duration-150 group-hover/dir:text-(--solus-accent) group-hover/dir:translate-y-px"
            >
              <CaretDownIcon size={16} weight="bold" />
            </span>
          </button>
        </div>
        <div
          class="flex flex-wrap items-center gap-x-2 gap-y-1.5 max-w-full text-xs text-(--solus-text-tertiary)"
        >
          {#if !isWorkspaceTarget}
            <span class="font-mono truncate">{abbreviateHome(currentDir)}</span>
          {/if}
          {#if env.pending}
            <!-- Worktree requested; the branch name is AI-derived on the first
                 turn, so show an honest "creating from <base>" until it lands. -->
            <span
              class="inline-flex items-center gap-[0.1875rem] flex-none text-(--solus-accent)"
            >
              <GitForkIcon size={11} />
              <span class="truncate max-w-[12rem]"
                >Worktree · creating from {worktreeBaseBranch}</span
              >
            </span>
          {:else if sess?.gitContext}
            <span
              class="inline-flex items-center gap-[0.1875rem] flex-none text-(--solus-text-secondary)"
            >
              {#if env.isolated}
                <GitForkIcon size={11} />
              {:else}
                <GitBranchIcon size={11} />
              {/if}
              <span class="truncate max-w-[7rem]">{env.name}</span>
            </span>
          {/if}
        </div>
      </div>
    </div>
    {#if canToggleWorktree || (!isWorkspaceTarget && workspacePath)}
      <!-- Bottom controls row: the worktree toggle moved off the crowded branch
           line down here where it has room, sitting beside the workspace jump. -->
      <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        {#if canToggleWorktree}
          <button
            class="group/wt inline-flex items-center gap-1.5 bg-transparent border-none cursor-pointer"
            type="button"
            role="switch"
            aria-checked={env.pending}
            onclick={toggleWorktree}
            title={env.pending
              ? `Next session branches into its own worktree from ${worktreeBaseBranch}`
              : `Start the next session in an isolated git worktree (branches from ${worktreeBaseBranch})`}
          >
            <span
              class="text-[0.6875rem] font-medium {env.pending
                ? 'text-(--solus-accent)'
                : 'text-(--solus-text-secondary)'}">Worktree</span
            >
            <Kbd variant="standalone">{comboHint("global.toggle-worktree")}</Kbd
            >
            {@render wtSwitch(env.pending)}
          </button>
        {/if}
        {#if !isWorkspaceTarget && workspacePath}
          <button
            class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full border border-(--solus-tool-border) bg-transparent text-(--solus-text-secondary) text-[0.6875rem] cursor-pointer transition-[background-color,border-color] duration-150 hover:bg-(--solus-surface-hover) hover:border-(--solus-accent-border-medium)"
            onclick={goToWorkspace}
            title="Back to My Workspace"
          >
            <span
              class="inline-flex w-3.5 h-3.5 text-(--solus-accent)"
              aria-hidden="true"
            >
              <svg viewBox="0 0 18 18" fill="none" class="w-full h-full">
                <circle cx="9" cy="9" r="4.8" fill="currentColor" />
                <g
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                >
                  <path d="M9,1 A8,8 0 0 1 17,9" />
                  <path d="M15.72,14.44 A8,8 0 0 1 6.44,16.68" />
                  <path d="M2.28,14.44 A8,8 0 0 1 1,6.44" />
                </g>
              </svg>
            </span>
            <span>My Workspace</span>
            <Kbd variant="standalone">⌥W</Kbd>
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<!-- Loading placeholder row for a recent session (shimmering bars) -->
{#snippet sessionSkeleton(i: number)}
  <div
    class="flex items-center justify-between px-3.5 py-2.5 h-10 box-border border-b border-(--solus-tool-border) last:border-b-0"
  >
    <span
      class="block h-[0.6875rem] rounded bg-(--solus-surface-secondary) opacity-70 relative overflow-hidden [&::after]:content-[''] [&::after]:absolute [&::after]:inset-0 [&::after]:[background:linear-gradient(90deg,transparent_0%,var(--solus-surface-hover)_50%,transparent_100%)] [&::after]:[transform:translateX(-100%)] [&::after]:[animation:home-skel-shimmer_1.4s_ease-in-out_infinite]"
      style="width:{[65, 48, 72][i]}%"
    ></span>
    <span
      class="block h-[0.5625rem] rounded bg-(--solus-surface-secondary) opacity-45 relative overflow-hidden [&::after]:content-[''] [&::after]:absolute [&::after]:inset-0 [&::after]:[background:linear-gradient(90deg,transparent_0%,var(--solus-surface-hover)_50%,transparent_100%)] [&::after]:[transform:translateX(-100%)] [&::after]:[animation:home-skel-shimmer_1.4s_ease-in-out_infinite]"
      style="width:{[22, 18, 26][i]}%"
    ></span>
  </div>
{/snippet}

<!-- ── Control-hub snippets: automation activity + task glance ── -->

<!-- Run-status glyph for an automation row (success / failure / running / queued). -->
{#snippet runStatusIcon(a: Automation)}
  {#if a.lastRunStatus === "running"}
    <CircleNotchIcon
      size={13}
      weight="bold"
      class="shrink-0 animate-spin text-(--solus-accent)"
    />
  {:else if a.lastRunStatus === "failed"}
    <XCircleIcon
      size={13}
      weight="fill"
      class="shrink-0 text-(--solus-status-error)"
    />
  {:else if a.lastRunStatus === "succeeded" || a.lastRunStatus === "dispatched"}
    <CheckCircleIcon
      size={13}
      weight="fill"
      class="shrink-0 text-[var(--solus-art-3,#5a9e6f)]"
    />
  {:else}
    <ClockCountdownIcon
      size={13}
      class="shrink-0 text-(--solus-text-tertiary)"
    />
  {/if}
{/snippet}

<!-- One automation: name + last-run status, with its latest output as a quiet
     second line so you can see what it did without opening it. -->
{#snippet automationRow(a: Automation, itemIndex: number)}
  {@const output = automationOutput(a)}
  <button
    class="group w-full flex items-start gap-2 text-left cursor-pointer px-4 py-3 sm:px-3.5 sm:py-2.5 bg-transparent border-b border-(--solus-tool-border) last:border-b-0 transition-[background-color,transform] hover:bg-(--solus-accent-light) active:scale-[0.99] {fadeIn}"
    style="--item-index:{itemIndex}"
    onclick={() => openAutomation(a)}
  >
    <span class="mt-px shrink-0">{@render runStatusIcon(a)}</span>
    <div class="flex flex-col min-w-0 flex-1">
      <div class="flex items-center gap-2 min-w-0">
        <span
          class="truncate text-[0.875rem] sm:text-[0.75rem] text-(--solus-text-primary) min-w-0"
        >
          {a.name}
        </span>
        <span
          class="ml-auto shrink-0 text-[0.6875rem] sm:text-[0.625rem] tabular-nums text-(--solus-text-tertiary)"
        >
          {relativeTime(a.lastRunAt) || "—"}
        </span>
      </div>
      <div
        class="truncate text-[0.6875rem] sm:text-[0.625rem] mt-0.5 {a.lastRunStatus ===
        'failed'
          ? 'text-(--solus-status-error)'
          : 'text-(--solus-text-tertiary)'}"
      >
        {output || (a.lastRunStatus === "running" ? "Running…" : "No output")}
      </div>
    </div>
  </button>
{/snippet}

{#snippet automationsSection()}
  <section class="flex flex-col gap-2 min-w-0">
    <div class="flex items-center justify-between px-1">
      <div class={sectionLabel}>Automations</div>
      <button
        class="group inline-flex shrink-0 items-center gap-1 text-[0.6875rem] sm:text-[0.625rem] text-(--solus-text-tertiary) cursor-pointer bg-transparent border-none hover:text-(--solus-accent) transition-colors"
        onclick={viewAllAutomations}
      >
        View all
        <ArrowRightIcon
          size={10}
          class="transition-transform group-hover:translate-x-0.5"
        />
      </button>
    </div>
    {#if hasAutomations}
      <div
        class="rounded-[0.875rem] sm:rounded-xl overflow-hidden border border-(--solus-tool-border)"
      >
        {#each automationActivity as a, i (a.id)}
          {@render automationRow(a, i + 1)}
        {/each}
      </div>
    {:else}
      <button
        class="flex items-center gap-2 px-4 py-3.5 sm:px-3.5 sm:py-3 text-left text-[0.875rem] sm:text-xs text-(--solus-text-tertiary) border border-dashed border-(--solus-tool-border) rounded-[0.875rem] sm:rounded-xl cursor-pointer hover:border-(--solus-accent-border-medium) hover:text-(--solus-text-secondary) transition-colors"
        onclick={viewAllAutomations}
      >
        <LightningIcon size={15} class="shrink-0" />
        No automation runs yet — set one up
      </button>
    {/if}
  </section>
{/snippet}

<!-- One pending task — two lines (title + priority/status) so it matches the
     height of the session and worktree cards beside it. -->
{#snippet taskRow(t: Task, itemIndex: number)}
  <button
    class="group w-full flex items-center gap-2.5 text-left cursor-pointer px-4 py-3 sm:px-3.5 sm:py-2.5 bg-transparent border-b border-(--solus-tool-border) last:border-b-0 transition-[background-color,transform] hover:bg-(--solus-accent-light) active:scale-[0.99] {fadeIn}"
    style="--item-index:{itemIndex}"
    onclick={() => openTask(t)}
  >
    <span
      class="shrink-0 w-2 h-2 rounded-full {STATUS_META[t.status].dotClass}"
      aria-hidden="true"
    ></span>
    <div class="flex flex-col min-w-0 flex-1">
      <span
        class="truncate text-[0.875rem] sm:text-[0.75rem] text-(--solus-text-primary)"
      >
        {t.title}
      </span>
      <span
        class="truncate text-[0.6875rem] sm:text-[0.625rem] mt-0.5 text-(--solus-text-tertiary)"
      >
        {#if t.priority}<span class="uppercase tracking-wide font-medium"
            >{t.priority}</span
          > ·
        {/if}{STATUS_META[t.status].label}
      </span>
    </div>
    <ArrowSquareInIcon
      size={13}
      class="shrink-0 text-(--solus-text-tertiary) opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
    />
  </button>
{/snippet}

{#snippet tasksSection()}
  <section class="flex flex-col gap-2 flex-1 min-w-0">
    <div class="flex items-center justify-between px-1">
      <div class="flex items-center gap-2 min-w-0">
        <div class={sectionLabel}>Tasks</div>
        {#if tCounts.open + tCounts.inProgress > 0}
          <span
            class="truncate text-[0.6875rem] sm:text-[0.625rem] tabular-nums text-(--solus-text-tertiary)"
          >
            {tCounts.inProgress} in progress · {tCounts.open} open
          </span>
        {/if}
      </div>
      <button
        class="group inline-flex shrink-0 items-center gap-1 text-[0.6875rem] sm:text-[0.625rem] text-(--solus-text-tertiary) cursor-pointer bg-transparent border-none hover:text-(--solus-accent) transition-colors"
        onclick={viewAllTasks}
      >
        View all
        <ArrowRightIcon
          size={10}
          class="transition-transform group-hover:translate-x-0.5"
        />
      </button>
    </div>
    <div
      class="rounded-[0.875rem] sm:rounded-xl overflow-hidden border border-(--solus-tool-border)"
    >
      {#each visibleTasks as t, i (t.id)}
        {@render taskRow(t, i + 1)}
      {/each}
    </div>
  </section>
{/snippet}

<!-- Recent-sessions column (loading skeleton / list / empty). Shared by the
     desktop hub and the mobile stack; sized mobile-first (larger touch rows),
     tightening to the dense desktop scale at sm. -->
{#snippet sessionsCol()}
  <section class="flex flex-col gap-2 flex-1 min-w-0">
    <div class={sectionLabel}>{sessionsLabel}</div>
    {#if !sessionsLoaded}
      <div
        class="rounded-[0.875rem] sm:rounded-xl overflow-hidden border border-(--solus-tool-border)"
        role="status"
      >
        {#each { length: 3 } as _, i}
          {@render sessionSkeleton(i)}
        {/each}
      </div>
    {:else if visibleSessions.length > 0}
      <div
        class="rounded-[0.875rem] sm:rounded-xl overflow-hidden border border-(--solus-tool-border)"
      >
        {#each visibleSessions as meta, i}
          {@const shortcut = projects.length + i + 1}
          <button
            class="group w-full flex items-start gap-2 text-left cursor-pointer px-4 py-3 sm:px-3.5 sm:py-2.5 bg-transparent border-b border-(--solus-tool-border) last:border-b-0 transition-[background-color,transform] hover:bg-(--solus-accent-light) active:scale-[0.99] [@media(max-height:900px)]:[&:nth-child(n+4)]:hidden [@media(max-height:900px)]:[&:nth-child(3)]:border-b-0 {fadeIn}"
            style="--item-index:{i + 1}"
            onclick={() => activateSession(meta)}
          >
            <div class="flex flex-col min-w-0 flex-1">
              <div
                class="truncate text-[0.875rem] sm:text-[0.75rem] text-(--solus-text-primary)"
              >
                {sessionTitle(meta)}
              </div>
              <div
                class="text-[0.6875rem] sm:text-[0.625rem] mt-0.5 text-(--solus-text-tertiary)"
              >
                {formatTimeAgo(meta.lastTimestamp)}
              </div>
            </div>
            <Kbd
              variant="standalone"
              class="shrink-0 mt-0.5 hidden sm:inline-flex">⌥⇧{shortcut}</Kbd
            >
          </button>
        {/each}
      </div>
    {:else}
      <div
        class="px-3.5 py-4 sm:py-3.5 text-center text-[0.875rem] sm:text-xs text-(--solus-text-tertiary) border border-(--solus-tool-border) rounded-[0.875rem] sm:rounded-xl"
      >
        No sessions here yet
      </div>
    {/if}
  </section>
{/snippet}

<!-- Active-worktrees column. Shared by the desktop hub and the mobile stack; the
     keyboard switch hint is desktop-only (no hover/keys on touch). -->
{#snippet worktreesCol()}
  <section class="flex flex-col gap-2 flex-1 min-w-0">
    <div class={sectionLabel}>Active Worktrees</div>
    <div
      class="rounded-[0.875rem] sm:rounded-xl overflow-hidden border border-(--solus-tool-border)"
    >
      {#each visibleWorktrees as wt, i}
        <button
          class="group w-full flex items-center gap-2 text-left cursor-pointer px-4 py-3 sm:px-3.5 sm:py-2.5 bg-transparent border-b border-(--solus-tool-border) last:border-b-0 transition-[background-color,transform] hover:bg-(--solus-accent-light) active:scale-[0.99] {fadeIn}"
          style="--item-index:{i + 1}"
          onclick={() => activateWorktree(wt)}
        >
          <GitForkIcon
            size={14}
            class="shrink-0"
            color="var(--solus-text-tertiary)"
          />
          <div class="flex flex-col min-w-0 flex-1">
            <span
              class="truncate text-[0.875rem] sm:text-[0.75rem] text-(--solus-text-primary)"
            >
              {formatBranchDisplayName(wt.branch, "", true)}
            </span>
            <span
              class="text-[0.6875rem] sm:text-[0.625rem] font-mono truncate mt-0.5 text-(--solus-text-tertiary)"
            >
              {abbreviateHome(wt.path)}
            </span>
          </div>
          <span
            class="relative hidden sm:inline-grid place-items-center shrink-0 min-w-[2.875rem] h-5"
          >
            <span
              class="[grid-area:1/1] transition-[opacity,transform] duration-[0.14s] group-hover:opacity-0 group-hover:translate-x-px group-focus-visible:opacity-0 group-focus-visible:translate-x-px"
            >
              <Kbd variant="standalone">⌥{i + 1}</Kbd>
            </span>
            <span
              class="[grid-area:1/1] inline-flex items-center justify-center w-5 h-5 rounded border border-(--solus-accent-border-medium) bg-(--solus-accent-light) text-(--solus-text-secondary) opacity-0 -translate-x-0.5 transition-[opacity,transform] duration-[0.14s] group-hover:opacity-100 group-hover:translate-x-0 group-focus-visible:opacity-100 group-focus-visible:translate-x-0"
            >
              <ArrowRightIcon size={11} />
            </span>
          </span>
        </button>
      {/each}
    </div>
  </section>
{/snippet}

<!-- Recent-projects row — shared by both desktop hub layouts. -->
{#snippet projectsRow()}
  <section class="flex flex-col gap-2">
    <div class={sectionLabel}>Recent Projects</div>
    <div class="flex gap-2.5 [&>*]:flex-1">
      {#each projects as proj, i}
        {@const shortcut = i + 1}
        <button
          class="group min-w-0 flex flex-col gap-1.5 p-3 rounded-xl text-left cursor-pointer bg-transparent border border-(--solus-tool-border) transition-[background-color,border-color,transform] hover:bg-(--solus-accent-light) hover:border-(--solus-accent-border-medium) active:scale-[0.98] {fadeIn}"
          style="--item-index:{i + 1}"
          onclick={() => activateProject(proj)}
        >
          <div class="flex items-center gap-1.5 min-w-0">
            <FolderOpenIcon
              size={14}
              weight="duotone"
              class="shrink-0"
              color="var(--solus-text-secondary)"
            />
            <span
              class="text-[0.8125rem] font-medium truncate text-(--solus-text-primary)"
            >
              {proj.folderName}
            </span>
            <Kbd variant="standalone" class="ml-auto shrink-0">⌥⇧{shortcut}</Kbd
            >
          </div>
          <div
            class="text-[0.6875rem] font-mono truncate text-(--solus-text-tertiary)"
          >
            {abbreviateHome(proj.path)}
          </div>
          <div class="text-[0.6875rem] text-(--solus-text-tertiary)">
            {formatTimeAgo(proj.lastOpened)}
          </div>
        </button>
      {/each}
    </div>
  </section>
{/snippet}

{#if isMobile}
  <!-- ═══ Mobile New Tab Home ═══ -->
  <div
    class="flex flex-col h-full px-4 pb-25 overflow-y-auto [-webkit-overflow-scrolling:touch]"
  >
    <div class="shrink-0 pt-3 mb-5">
      {@render launchTarget()}
    </div>
    <SetupChecklist active={isActiveHome} />

    <div class="flex flex-col gap-6">
        {#if projects.length > 0}
          <section class="flex flex-col gap-2.5">
            <div class={sectionLabel}>Recent Projects</div>
            <div class="relative">
              <div
                class="flex gap-2.5 overflow-x-hidden pb-1 [touch-action:pan-y_pinch-zoom] [&::-webkit-scrollbar]:hidden"
                role="list"
                aria-label="Recent projects"
                bind:this={projectScrollEl}
                onscroll={updateScrollIndicators}
                ontouchstart={onProjectTouchStart}
                ontouchend={onProjectTouchEnd}
              >
                {#each projects as proj, i}
                  <button
                    class="shrink-0 w-50 flex flex-col px-4 py-3.5 rounded-[0.875rem] bg-transparent border border-(--solus-tool-border) text-left cursor-pointer transition-[background-color,border-color] duration-150 [-webkit-tap-highlight-color:transparent] active:bg-(--solus-accent-light) active:border-(--solus-accent-border-medium) active:scale-[0.97] {fadeIn}"
                    style="--item-index:{i}"
                    onclick={() => activateProject(proj)}
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <div
                        class="w-7 h-7 rounded-lg flex items-center justify-center bg-(--solus-surface-hover) shrink-0"
                      >
                        <FolderOpenIcon
                          size={16}
                          weight="duotone"
                          color="var(--solus-text-secondary)"
                        />
                      </div>
                      <span
                        class="text-[0.875rem] font-medium truncate text-(--solus-text-primary)"
                      >
                        {proj.folderName}
                      </span>
                    </div>
                    <div
                      class="text-[0.6875rem] font-mono truncate mt-1 text-(--solus-text-tertiary)"
                    >
                      {abbreviateHome(proj.path)}
                    </div>
                    <div
                      class="text-[0.6875rem] mt-0.5 text-(--solus-text-muted)"
                    >
                      {formatTimeAgo(proj.lastOpened)}
                    </div>
                  </button>
                {/each}
              </div>
              <div
                class="absolute top-0 right-0 bottom-1 w-10 [background:linear-gradient(to_right,transparent,var(--solus-surface-primary))] pointer-events-none rounded-r-[0.875rem] transition-opacity duration-200"
                style:opacity={showScrollFadeRight ? 1 : 0}
              ></div>
            </div>
            {#if projects.length > 1}
              <div class="flex items-center justify-center gap-1.5 pt-2.5">
                {#each projects as _, i}
                  <span
                    class="w-1.5 h-1.5 rounded-full bg-(--solus-text-tertiary) transition-[opacity,transform] duration-200 {i ===
                    activeProjectDot
                      ? 'opacity-85 scale-[1.35]'
                      : 'opacity-30'}"
                  ></span>
                {/each}
              </div>
            {/if}
          </section>
        {/if}

        <!-- Sessions / worktrees / automations / tasks reuse the shared
             control-hub snippets, which size up for touch on this viewport. -->
        {@render sessionsCol()}

        {#if visibleWorktrees.length > 0}
          {@render worktreesCol()}
        {/if}

        {#if hasTasks}
          {@render tasksSection()}
        {/if}

        {#if hasAutomations}
          {@render automationsSection()}
        {/if}
    </div>
  </div>
{:else}
  <!-- ═══ Desktop New Tab Home (Control Hub) ═══ -->
  <!-- Scrollable column: my-auto on the inner block centers it when there's room
       and top-aligns + scrolls when the hub outgrows a short laptop screen. -->
  <div
    class="flex flex-col items-center px-4 overflow-y-auto {isEditorMode
      ? 'h-full flex-1 min-h-0 py-6'
      : 'py-8'}"
    style={isEditorMode ? "" : "min-height:var(--pill-body-max)"}
  >
    <div
      class="my-auto w-full flex flex-col gap-3 {isEditorMode
        ? 'max-w-[43.75rem]'
        : 'max-w-[38.75rem]'}"
    >
      {@render launchTarget()}
      <SetupChecklist active={isActiveHome} />

      {#if projects.length > 0}
        {@render projectsRow()}
      {/if}

      <!-- Work row: sessions, active worktrees, and the task agenda as up to
           three equal columns. They drop to a single column on narrow windows
           so nothing cramps on a laptop. Automation activity follows below. -->
      <div class="flex flex-col min-[34rem]:flex-row gap-3">
        {@render sessionsCol()}
        {#if visibleWorktrees.length > 0}
          {@render worktreesCol()}
        {/if}
        {#if hasTasks}
          {@render tasksSection()}
        {/if}
      </div>

      {@render automationsSection()}
    </div>
  </div>
{/if}
