<script lang="ts">
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import {
    getSettingsContext,
    type ProjectPanelSectionId,
  } from "../../contexts/settings.context.svelte";
  import { getGitStatusStore } from "../../contexts/git-status.store.svelte";
  import { DEFAULT_PANEL_WIDTH } from "../../contexts/pane-view.store.svelte";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    ArrowsClockwiseIcon,
    CheckIcon,
    GearSixIcon,
    PlusIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import SidePanel from "../layout/SidePanel.svelte";
  import PanelSection from "./PanelSection.svelte";
  import GitSection from "./GitSection.svelte";
  import RunSection from "./RunSection.svelte";
  import WorksSection from "./WorksSection.svelte";
  import TasksSection from "./TasksSection.svelte";
  import AutomationsSection from "./AutomationsSection.svelte";
  import { buildAutomationBoard } from "./lib/automation-board";
  import { sessionWorks } from "./lib/session-works";
  import { matchesOpenProjects } from "../../lib/sessionUtils";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { tabGitContextFromStatus } from "../../../shared/types";
  import { getRunStore } from "../../contexts/run.store.svelte";

  interface Props {
    open?: boolean;
    width?: number;
    onClose: () => void;
  }
  let { open = true, width, onClose }: Props = $props();

  const session = getWorkspaceContext();
  const runs = getRunStore();
  const settings = getSettingsContext();
  const gitStatus = getGitStatusStore();
  const maxProjectPanelWidth = DEFAULT_PANEL_WIDTH;

  const activeSession = $derived(session.sessionFor(session.activeTabId));
  const cwd = $derived(
    activeSession?.workingDirectory ?? session.globalDefaults.workingDirectory,
  );
  const gitCtx = $derived(
    activeSession?.gitContext ?? session.globalDefaults.gitContext,
  );
  const gitCwd = $derived(gitCtx?.worktreePath ?? cwd);
  const runCwd = $derived(gitCtx?.worktreePath ?? cwd);
  const activeTabId = $derived(session.activeTabId);
  const projectName = $derived(() => {
    const dir = cwd?.replace(/\/$/, "");
    if (!dir || dir === "~") return "~";
    const parts = dir.split("/");
    return parts[parts.length - 1] || "~";
  });

  // Works the active session created or updated — derived from the same messages
  // that drive the conversation, so it's correct live and after a history reload.
  const sessionWorkItems = $derived(
    activeSession
      ? sessionWorks(
          activeSession.messages,
          session.worksStore.works,
          activeSession.agentSessionId,
        )
      : [],
  );

  // Automations scoped to the active project (its repo root, worktree, and cwd),
  // so the panel shows what runs for this project. Reloaded whenever the panel
  // opens so agent-created automations appear without a manual refresh.
  const automationsStore = session.automationsStore;
  const automationScopeRoots = $derived([
    ...new Set([gitCwd, cwd].filter(Boolean)),
  ] as string[]);
  // A glanceable status board, not the full catalog: only automations that need
  // attention right now (running, failed, pinned, soonest-scheduled) surface here.
  const automationBoard = $derived(
    buildAutomationBoard(
      automationsStore.items.filter((a) =>
        matchesOpenProjects(a.action.cwd, automationScopeRoots),
      ),
    ),
  );
  $effect(() => {
    if (open) void automationsStore.loadAll();
  });

  // The works store is "active project" scoped and otherwise only populated
  // lazily (when Folio or the work picker opens). Hydrating a session from disk
  // does not load it, so without this the Works section is empty on a cold
  // reload until something else loads the store. Load it for the active cwd.
  $effect(() => {
    if (cwd) void session.worksStore.loadAll(cwd);
  });

  // Registered here (not in GitSection) so the shortcuts keep working while
  // the Git section is collapsed and unmounted.
  useKeybinding("orb.sync", () => {
    if (gitCtx) void gitActionsFor(activeTabId, session, gitStatus).sync();
  });
  useKeybinding("orb.commit-push", () => {
    if (gitCtx)
      void gitActionsFor(activeTabId, session, gitStatus).commitPush();
  });

  function toggleSection(id: ProjectPanelSectionId) {
    settings.projectPanelCollapsed[id] = !settings.projectPanelCollapsed[id];
    settings.update({ projectPanelCollapsed: settings.projectPanelCollapsed });
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
    const [ok] = await Promise.all([
      gitStatus.refresh(gitCwd, { force: true }),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]);
    if (ok) {
      const refreshedStatus = gitStatus.statusFor(gitCwd);
      const refreshedGitCtx = tabGitContextFromStatus(refreshedStatus);
      if (activeSession && !activeSession.gitContext?.worktreePath) {
        activeSession.gitContext = refreshedGitCtx;
      } else if (
        !activeSession &&
        !session.globalDefaults.gitContext?.worktreePath
      ) {
        session.globalDefaults.gitContext = refreshedGitCtx;
      }
    }
    refreshState = ok ? "success" : "error";
    refreshResetTimer = setTimeout(() => {
      refreshState = "idle";
      refreshResetTimer = null;
    }, 1400);
  }

  function openSettings() {
    if (!cwd) return;
    session.showProjectSettings(cwd);
    requestInputFocus();
  }

  function openFiles() {
    if (!cwd) return;
    session.artifactViewer.openFiles();
    requestInputFocus();
  }

  function newTask() {
    if (!gitCwd) return;
    session.ui.openTaskComposer(gitCwd);
    requestInputFocus();
  }
</script>

{#snippet headerActions()}
  <button
    class="panel-header-btn"
    type="button"
    aria-label="Project settings"
    onclick={openSettings}
  >
    <GearSixIcon size={15} />
  </button>
{/snippet}

{#snippet gitHeaderExtra()}
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
  </span>
{/snippet}

{#snippet tasksHeaderExtra()}
  <span class="header-extra">
    <button
      class="tiny-icon"
      type="button"
      aria-label="New task"
      onclick={(e) => {
        e.stopPropagation();
        newTask();
      }}
    >
      <PlusIcon size={14} />
    </button>
  </span>
{/snippet}

<SidePanel
  title={projectName() ?? "Project"}
  side="right"
  {open}
  {width}
  minWidth={240}
  maxWidth={maxProjectPanelWidth}
  onAction={onClose}
  actionTooltip={`Close project panel (${comboHint("global.toggle-project-panel")})`}
  actionAriaLabel="Close project panel"
  background="color-mix(in srgb, var(--solus-container-bg) 90%, color-mix(in srgb, var(--solus-input-pill-bg) 70%, var(--solus-surface-primary)) 10%)"
  headerTopPadding="compact"
  {headerActions}
>
  <div class="project-sections">
    <PanelSection
      title="Environment"
      collapsed={settings.projectPanelCollapsed.git}
      onToggle={() => toggleSection("git")}
      headerExtra={gitHeaderExtra}
    >
      <GitSection cwd={gitCwd} tabId={activeTabId} onOpenFiles={openFiles} />
    </PanelSection>
    {#if runs.runsFor(runCwd)?.length > 0}
      <PanelSection
        title="Run"
        collapsed={settings.projectPanelCollapsed.run}
        onToggle={() => toggleSection("run")}
      >
        <RunSection cwd={runCwd} onConfigure={openSettings} />
      </PanelSection>
    {/if}
    {#if sessionWorkItems.length > 0}
      <PanelSection
        title="Works"
        collapsed={settings.projectPanelCollapsed.works}
        onToggle={() => toggleSection("works")}
      >
        <WorksSection items={sessionWorkItems} />
      </PanelSection>
    {/if}
    {#if automationBoard.total > 0}
      <PanelSection
        title="Automations"
        collapsed={settings.projectPanelCollapsed.automations}
        onToggle={() => toggleSection("automations")}
      >
        <AutomationsSection board={automationBoard} />
      </PanelSection>
    {/if}
    <PanelSection
      title="Tasks"
      collapsed={settings.projectPanelCollapsed.tasks}
      onToggle={() => toggleSection("tasks")}
      headerExtra={tasksHeaderExtra}
    >
      <TasksSection cwd={gitCwd} active={open} />
    </PanelSection>
  </div>
</SidePanel>

<style>
  .project-sections {
    --project-icon-blue: oklch(0.62 0.18 252);
    --project-icon-green: oklch(0.65 0.16 148);
    --project-icon-amber: oklch(0.74 0.17 75);
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
  }

  .panel-header-btn,
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
  }

  .panel-header-btn {
    width: 1.625rem;
    height: 1.625rem;
    border-radius: 0.375rem;
  }

  .tiny-icon {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
    flex-shrink: 0;
  }

  .panel-header-btn:hover,
  .tiny-icon:hover {
    color: var(--solus-text-primary);
    background: color-mix(in srgb, var(--solus-accent) 7%, transparent);
  }
  .panel-header-btn:active,
  .tiny-icon:active {
    background: color-mix(in srgb, var(--solus-accent) 12%, transparent);
  }

  .panel-header-btn:focus-visible,
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
