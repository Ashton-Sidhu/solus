<script lang="ts">
  import { serverConnections } from "@client-core/server-connections";
  import { existingTaskId } from "../../contexts/workspace/session-draft.svelte";
  import {
    getWorkspaceContext,
    getSettingsContext,
    type ProjectPanelSectionId,
    getSessionEnvironmentStore,
    serversStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { isProjectRailOpen, projectRailWidth } from "./lib/rail-width";
  import {
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
  } from "../layout/lib/workspace-body";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    ArrowsClockwiseIcon,
    CheckIcon,
    ClockIcon,
    PlusIcon,
    SidebarSimpleIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import SidePanel from "../layout/SidePanel.svelte";
  import { Button } from "../ui/button";
  import PanelSection from "./PanelSection.svelte";
  import GoalSection from "./GoalSection.svelte";
  import EnvironmentSection from "./EnvironmentSection.svelte";
  import GitSection from "./GitSection.svelte";
  import GitSetupSection from "./GitSetupSection.svelte";
  import TaskSection from "./TaskSection.svelte";
  import AutomationsSection from "./AutomationsSection.svelte";
  import {
    automationMatchesProject,
    buildAutomationBoard,
  } from "./lib/automation-board";
  import { isUnconfiguredCwd } from "./lib/project-cwd";
  import { taskRef } from "../tasks/task-page/lib/task-page";
  import { taskRefTooltip } from "./lib/rail-task-card";
  import { getOuterScrollbarContext } from "../layout/lib/outer-scrollbar.context";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "@renderer/components/ui/tooltip";

  interface Props {
    /** The tab or draft this rail describes — it lives inside that view. The
     *  rail is about where work happens, so it resolves a run from whichever it
     *  was handed rather than requiring a conversation to exist. */
    sourceId: string;
    /** Whether this rail belongs to a pinned split chat rather than the leading
     *  conversation. Every piece of the rail's view state — open, and which
     *  sections are collapsed — is stored per role, so adjusting the split
     *  chat's rail never moves the leading one's. */
    isSplit?: boolean;
    /** Width of the hosting conversation view. Decides whether there is room for
     *  the rail at all, and caps it in a split too narrow to give the full
     *  width away. */
    containerWidth: number;
    /** Width of the whole workspace body — the same measure the session sidebar
     *  sizes against, so the two rails match. */
    workspaceWidth: number;
    /** Temporarily minimize without changing the role's persisted preference. */
    minimized?: boolean;
    /** False while the owning Editor/web surface is mounted but hidden. */
    active?: boolean;
    /** Collapse the rail through its owning conversation so transient and
     *  persisted open state stay in sync. */
    onCollapse: () => void;
  }
  let {
    sourceId,
    isSplit = false,
    containerWidth,
    workspaceWidth,
    minimized = false,
    active = true,
    onCollapse,
  }: Props = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const environmentStore = getSessionEnvironmentStore();
  const outerScrollbar = getOuterScrollbarContext();
  let sectionsElement = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!outerScrollbar || !sectionsElement) return;
    return outerScrollbar.register(sectionsElement);
  });

  // Both rails render the same component, so every piece of their view state is
  // stored per role. Reading it through one pair of deriveds is what keeps a
  // split chat's rail from moving the leading one's when either is adjusted.
  const preferOpen = $derived(
    isSplit ? settings.splitProjectPanelOpen : settings.projectPanelOpen,
  );
  const collapsedSections = $derived(
    isSplit
      ? settings.splitProjectPanelCollapsed
      : settings.projectPanelCollapsed,
  );

  // The role owns the preference; this owns whether the current layout can
  // honour it. Temporary minimization leaves that preference intact, so the
  // rail returns when the secondary panel closes.
  const open = $derived(
    isProjectRailOpen(preferOpen, containerWidth, minimized),
  );

  // Present only once a conversation has started: the goal and the session's own
  // task links are the two things a draft genuinely does not have yet.
  const panelSession = $derived(session.sessionFor(sourceId));
  const panelRun = $derived(session.runFor(sourceId));
  const panelServerId = $derived(
    panelRun?.serverId
      ? serverConnections.resolveId(panelRun.serverId)
      : serverConnections.connectionFor()?.serverId ?? null,
  );
  const panelEnvironment = $derived(environmentStore.environmentFor(panelRun));

  // Where this session runs. Local is the unmarked case — the machine under the
  // user's hands never needs stating — so the chip appears only for a remote
  // host, and states its reachability in the same breath.
  const remoteHost = $derived(serversStore.hostFor(panelRun?.serverId));
  const remoteHostAffinity = $derived(
    serversStore.affinityFor(panelRun?.serverId),
  );

  const cwd = $derived(
    panelRun?.workingDirectory ?? session.globalDefaults.workingDirectory,
  );
  const gitCtx = $derived(panelEnvironment.checkout);
  const gitCwd = $derived(panelEnvironment.cwd);

  // The task the session is working, or the one a draft will be filed under —
  // which is why the target is read rather than the session's links alone. It
  // covers the window between "started from a task" and the first agent session
  // id existing, so the card is there from the tab's first frame.
  const panelTaskTarget = $derived(
    panelSession?.task ?? session.sessionDrafts.get(sourceId)?.task,
  );
  const namedTaskId = $derived(
    panelTaskTarget ? existingTaskId(panelTaskTarget) : null,
  );
  const panelTask = $derived(
    (namedTaskId ? session.tasksStore.taskForId(namedTaskId) : null) ??
      (panelSession
        ? session.tasksStore.taskForSession(panelSession.agentSessionId)
        : null),
  );

  // Automations scoped to the focused project (its repo root, worktree, and cwd),
  // so the panel shows what runs for this project.
  const automationsStore = session.automationsStore;
  const automationScopeRoots = $derived(
    isUnconfiguredCwd(gitCwd)
      ? []
      : [...new Set([gitCwd, cwd].filter((root): root is string => !!root))],
  );
  // A glanceable status board, not the full catalog: only automations that need
  // attention right now (running, failed, pinned, soonest-scheduled) surface here.
  const automationBoard = $derived(
    buildAutomationBoard(
      automationsStore.items.filter((a) =>
        automationMatchesProject(
          a,
          automationsStore.hostFor(a.id),
          panelServerId,
          automationScopeRoots,
        ),
      ),
    ),
  );
  // The automations store is otherwise only populated lazily (when the
  // Automations page opens), so hydrating a session from disk would leave the
  // section empty on a cold reload. Load only when the focused project's
  // resolved Git cwd changes so focus events within a pane do not churn the
  // project-scoped stores.
  let loadedProjectCwd = $state<string>();
  const shouldLoadProject = $derived(
    active && open && !isUnconfiguredCwd(gitCwd) && gitCwd !== loadedProjectCwd,
  );
  $effect(() => {
    if (!shouldLoadProject || !gitCwd) return;
    loadedProjectCwd = gitCwd;
    void automationsStore.loadAll(panelServerId ?? undefined);
  });

  // A split chat mounts a second rail, so both instances register these ids and
  // the dispatcher fires only the first enabled handler. Each rail arms its
  // bindings solely while its own conversation holds focus, so the shortcut acts
  // on the chat the user is actually in rather than always the primary one. A
  // rail on a draft has no tab to compare against, so it arms them whenever the
  // pane it belongs to is the one on screen.
  const focused = $derived(
    active &&
      (panelSession
        ? (session.focusedChatTabId ?? session.activeTabId) === sourceId
        : !isSplit),
  );

  // Registered here (not in GitSection) so the shortcuts keep working while
  // the Git section is collapsed and unmounted.
  useKeybinding(
    "orb.sync",
    () => {
      if (gitCtx) void gitActionsFor(sourceId, session, environmentStore).sync();
    },
    { enabled: () => focused },
  );
  useKeybinding(
    "orb.commit-push",
    () => {
      if (gitCtx)
        void gitActionsFor(sourceId, session, environmentStore).run("commit_push");
    },
    { enabled: () => focused },
  );

  function toggleSection(id: ProjectPanelSectionId) {
    collapsedSections[id] = !collapsedSections[id];
    settings.update(
      isSplit
        ? { splitProjectPanelCollapsed: collapsedSections }
        : { projectPanelCollapsed: collapsedSections },
    );
  }

  function completeTask() {
    const task = panelTask;
    if (!task) return;
    void session.tasksStore
      .setStatus(task.id, "done")
      .catch((err) =>
        toasts.error("Couldn't complete the task", {
          description: err instanceof Error ? err.message : String(err),
        }),
      );
    requestInputFocus();
  }

  type RefreshState = "idle" | "spinning" | "success" | "error";
  let refreshState = $state<RefreshState>("idle");
  let refreshResetTimer: ReturnType<typeof setTimeout> | null = null;
  async function refreshGit(e: MouseEvent) {
    e.stopPropagation();
    requestInputFocus();
    if (refreshState === "spinning") return;
    if (refreshResetTimer) {
      clearTimeout(refreshResetTimer);
      refreshResetTimer = null;
    }
    refreshState = "spinning";
    // Floor the spin at one full rotation so a fast refresh still reads.
    const [result] = await Promise.all([
      environmentStore.refreshEnvironment(session, {
        sourceId,
        cwd: gitCwd,
        level: "full",
      }),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]);
    refreshState = result.ok ? "success" : "error";
    if (!result.ok)
      toasts.error(result.error ?? "Couldn't refresh the Git environment.");
    refreshResetTimer = setTimeout(() => {
      refreshState = "idle";
      refreshResetTimer = null;
    }, 1400);
  }

  function openFiles() {
    if (!gitCwd) return;
    session.openFiles(sourceId);
    requestInputFocus();
  }

  function newAutomation() {
    session.openAutomationBuilder(null, "focused", sourceId);
    requestInputFocus();
  }
</script>

{#snippet environmentHeaderBadge()}
  {#if remoteHostAffinity && remoteHost}
    {@const HostIcon = remoteHostAffinity.icon}
    <!-- Read-only: the host is chosen before the session starts and locked
         after, so the chip states a fact rather than offering a picker. -->
    <span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--solus-text-primary)_6%,transparent)] px-1.5 py-0.5 text-menu-meta font-medium tracking-normal text-(--solus-text-secondary) normal-case dark:bg-[color-mix(in_srgb,var(--solus-text-primary)_10%,transparent)]"
      title={remoteHostAffinity.tooltip}
    >
      <HostIcon size={11} class={remoteHostAffinity.className} />
      <span class="max-w-24 truncate">{remoteHost.label}</span>
    </span>
  {/if}
{/snippet}

{#snippet environmentHeaderExtra()}
  <span class="header-extra">
    <button
      class="tiny-icon"
      class:is-success={refreshState === "success"}
      class:is-error={refreshState === "error"}
      type="button"
      aria-label={refreshState === "success"
        ? "Git status refreshed"
        : refreshState === "error"
          ? "Git status refresh failed"
          : "Refresh git status"}
      onclick={refreshGit}
    >
      {#if refreshState === "success"}
        <span class="refresh-icon refresh-result"
          ><CheckIcon size={12} weight="bold" /></span
        >
      {:else if refreshState === "error"}
        <span class="refresh-icon refresh-result"
          ><WarningCircleIcon size={12} weight="bold" /></span
        >
      {:else}
        <span class="refresh-icon" class:spinning={refreshState === "spinning"}>
          <ArrowsClockwiseIcon size={12} />
        </span>
      {/if}
    </button>
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button
            {...tooltipProps}
            class="tiny-icon"
            type="button"
            aria-label="Collapse project panel"
            onclick={onCollapse}
          >
            <SidebarSimpleIcon size={12} mirrored />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        value={`Collapse project panel (${comboHint("global.toggle-project-panel")})`}
      />
    </TooltipUI.Root>
  </span>
{/snippet}

{#snippet taskHeaderExtra()}
  <!-- The card's own header carries the task's short ref in mono, the way the
       Git card carries a branch: the one machine-readable name for what the
       card is about, and the card's only way out to the task page. Complete and
       Snooze follow it as glyphs, then the section's own disclosure caret. -->
  <span class="header-extra">
    <button
      class="cursor-pointer font-mono text-menu-meta underline decoration-[color-mix(in_oklch,var(--foreground)_22%,transparent)] underline-offset-[3px] opacity-85 transition-colors hover:text-(--solus-text-primary) hover:opacity-100"
      type="button"
      title={panelTask ? taskRefTooltip(panelTask) : "Open task page"}
      onclick={(e) => {
        e.stopPropagation();
        if (panelTask) session.goToTask(panelTask.id, "click");
      }}
    >
      {panelTask ? taskRef(panelTask) : ""}
    </button>
    <!-- Completing a task in Solus only moves its status — no session is
         stopped by it — so the button acts rather than confirming. -->
    <button
      class="tiny-icon"
      type="button"
      title="Mark complete"
      aria-label="Mark task complete"
      onclick={(e) => {
        e.stopPropagation();
        completeTask();
      }}
    >
      <CheckIcon size={12} />
    </button>
    <!-- Snooze has no behaviour behind it yet — the same placeholder the
         sidebar's task row keeps, so the header geometry is not re-tuned the
         day tasks can be snoozed. -->
    <button
      class="tiny-icon"
      type="button"
      title="Snooze"
      aria-label="Snooze task"
      onclick={(e) => e.stopPropagation()}
    >
      <ClockIcon size={12} />
    </button>
  </span>
{/snippet}

{#snippet automationsHeaderExtra()}
  <span class="header-extra">
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-(--solus-text-tertiary)"
      type="button"
      aria-label="New automation"
      onclick={(e) => {
        e.stopPropagation();
        newAutomation();
      }}
    >
      <PlusIcon size={14} />
    </Button>
  </span>
{/snippet}

<SidePanel
  side="right"
  {open}
  flush
  width={projectRailWidth(workspaceWidth, containerWidth)}
  minWidth={SIDEBAR_MIN_WIDTH}
  maxWidth={SIDEBAR_MAX_WIDTH}
  background="var(--solus-container-bg)"
>
  <div
    bind:this={sectionsElement}
    class="project-sections"
    class:outer-scroll-source={!!outerScrollbar}
  >
    <PanelSection
      title="Environment"
      titlebar
      collapsed={collapsedSections.environment}
      onToggle={() => toggleSection("environment")}
      headerBadge={environmentHeaderBadge}
      headerExtra={environmentHeaderExtra}
    >
      <EnvironmentSection
        {sourceId}
        active={active && open}
        onOpenFiles={openFiles}
      />
    </PanelSection>
    {#if panelEnvironment.branch}
      <PanelSection
        title="Git"
        collapsed={collapsedSections.git}
        onToggle={() => toggleSection("git")}
      >
        <GitSection {sourceId} />
        <GitSetupSection {sourceId} />
      </PanelSection>
    {:else if !isUnconfiguredCwd(gitCwd)}
      <!-- No repository yet — the Environment section above already names the
           folder; this card is only the way in. -->
      <PanelSection
        title="Git"
        collapsed={collapsedSections.git}
        onToggle={() => toggleSection("git")}
      >
        <GitSetupSection {sourceId} />
      </PanelSection>
    {/if}
    <!-- The section exists only while a goal is set. It owns its own card
         because the header controls share edit/confirm state with the body. -->
    {#if panelSession?.goal}
      <!-- Only ever reached with a session behind it — a goal is something a
           conversation has, so the section names that conversation. -->
      <GoalSection
        sessionId={panelSession.id}
        collapsed={collapsedSections.goal}
        onToggle={() => toggleSection("goal")}
      />
    {/if}
    {#if panelTask}
      <!-- The header carries the whole of the task's identity — label, ref and
           actions — so the card's body is only its two lists. -->
      <PanelSection
        title="Task"
        collapsed={collapsedSections.task}
        onToggle={() => toggleSection("task")}
        headerExtra={taskHeaderExtra}
      >
        <TaskSection
          task={panelTask}
          projectCwd={panelTask.projectKey ?? cwd}
          currentSessionId={panelSession?.agentSessionId ?? null}
          active={active && open}
        />
      </PanelSection>
    {/if}
    {#if automationBoard.total > 0}
      <PanelSection
        title="Automations"
        headerDetail={automationBoard.summary}
        collapsed={collapsedSections.automations}
        onToggle={() => toggleSection("automations")}
        headerExtra={automationsHeaderExtra}
      >
        <AutomationsSection board={automationBoard} />
      </PanelSection>
    {/if}
  </div>
</SidePanel>

<style>
  .project-sections {
    --project-icon-blue: oklch(0.62 0.18 252);
    --project-icon-green: oklch(0.65 0.16 148);
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    /* The rail is the same surface as the conversation view beside it — no tray,
       no recess — so the section cards separate themselves with a hairline. The
       even gutter still makes a collapsed section read as a gap, not a shorter
       list. */
    background: var(--solus-container-bg);
    gap: 0.5rem;
    padding: 0.5rem;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    scrollbar-gutter: stable;
  }

  .tiny-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      color 0.15s ease,
      background-color 0.15s ease;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
    flex-shrink: 0;
  }

  .tiny-icon:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }
  .tiny-icon:active {
    background: color-mix(in srgb, var(--solus-accent) 12%, transparent);
  }

  .tiny-icon:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }

  .header-extra {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    min-width: 0;
    max-width: 10rem;
  }

  .refresh-icon {
    display: inline-flex;
  }
  @media (prefers-reduced-motion: no-preference) {
    .refresh-icon.spinning {
      animation: refresh-spin 0.6s cubic-bezier(0.5, 0, 0.5, 1) infinite;
    }
  }
  @keyframes refresh-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Result states win over the tiny-icon hover color. */
  .tiny-icon.is-success,
  .tiny-icon.is-success:hover {
    color: var(--solus-status-complete);
    background: transparent;
  }
  .tiny-icon.is-error,
  .tiny-icon.is-error:hover {
    color: var(--solus-status-error);
    background: transparent;
  }
  @media (prefers-reduced-motion: no-preference) {
    .refresh-result {
      animation: refresh-pop 0.32s cubic-bezier(0.16, 1, 0.3, 1);
    }
  }
  @keyframes refresh-pop {
    0% {
      transform: scale(0.5);
      opacity: 0;
    }
    60% {
      transform: scale(1.15);
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
</style>
