<script lang="ts">
  import {
    getWorkspaceContext,
    getSettingsContext,
    type ProjectPanelSectionId,
    getSessionEnvironmentStore,
  } from "../../contexts";
  import { DEFAULT_PANEL_WIDTH } from "../../contexts/workspace/pane-view.store.svelte";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    ArrowsClockwiseIcon,
    CheckIcon,
    PlusIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import SidePanel from "../layout/SidePanel.svelte";
  import { Button } from "../ui/button";
  import PanelSection from "./PanelSection.svelte";
  import GitSection from "./GitSection.svelte";
  import WorksSection from "./WorksSection.svelte";
  import TasksSection from "./TasksSection.svelte";
  import AutomationsSection from "./AutomationsSection.svelte";
  import { buildAutomationBoard } from "./lib/automation-board";
  import { isUnconfiguredCwd } from "./lib/project-cwd";
  import { sessionWorks } from "./lib/session-works";
  import { matchesOpenProjects } from "../../lib/sessionUtils";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { getOuterScrollbarContext } from "../layout/lib/outer-scrollbar.context";

  interface Props {
    open?: boolean;
    managedWidth?: boolean;
    onClose: () => void;
  }
  let { open = true, managedWidth = false, onClose }: Props = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const environmentStore = getSessionEnvironmentStore();
  const outerScrollbar = getOuterScrollbarContext();
  let sectionsElement = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!outerScrollbar || !sectionsElement) return;
    return outerScrollbar.register(sectionsElement);
  });
  const maxProjectPanelWidth = DEFAULT_PANEL_WIDTH;

  const panelTabId = $derived(
    session.focusedChatTabId ?? session.activeTabId,
  );
  const panelSession = $derived(session.sessionFor(panelTabId));
  const panelEnvironment = $derived(environmentStore.environmentFor(panelTabId));
  const cwd = $derived(
    panelSession?.workingDirectory ?? session.globalDefaults.workingDirectory,
  );
  const gitCtx = $derived(
    panelEnvironment.checkout,
  );
  const gitCwd = $derived(panelEnvironment.cwd);
  const isSplitScope = $derived(panelTabId !== session.activeTabId);
  const projectName = $derived(() => {
    const dir = cwd?.replace(/\/$/, "");
    if (!dir || dir === "~") return "~";
    const parts = dir.split("/");
    return parts[parts.length - 1] || "~";
  });

  // Works the focused session created or updated — derived from the same messages
  // that drive the conversation, so it's correct live and after a history reload.
  const sessionWorkItems = $derived(
    panelSession
      ? sessionWorks(
          panelSession.messages,
          session.worksStore.works,
          panelSession.agentSessionId,
        )
      : [],
  );

  // Automations scoped to the focused project (its repo root, worktree, and cwd),
  // so the panel shows what runs for this project.
  const automationsStore = session.automationsStore;
  const automationScopeRoots = $derived(
    isUnconfiguredCwd(gitCwd)
      ? []
      : ([...new Set([gitCwd, cwd].filter(Boolean))] as string[]),
  );
  // A glanceable status board, not the full catalog: only automations that need
  // attention right now (running, failed, pinned, soonest-scheduled) surface here.
  const automationBoard = $derived(
    buildAutomationBoard(
      automationsStore.items.filter((a) =>
        matchesOpenProjects(a.action.cwd, automationScopeRoots),
      ),
    ),
  );
  // The works store is "active project" scoped and otherwise only populated
  // lazily (when Folio or the work picker opens). Hydrating a session from disk
  // does not load it, so without this the Works section is empty on a cold
  // reload until something else loads the store. Load only when the focused
  // project's resolved Git cwd changes so focus events within a pane do not
  // churn the project-scoped stores.
  let loadedProjectCwd = $state<string>();
  const shouldLoadProject = $derived(
    open && !isUnconfiguredCwd(gitCwd) && gitCwd !== loadedProjectCwd,
  );
  $effect(() => {
    if (!shouldLoadProject || !gitCwd) return;
    loadedProjectCwd = gitCwd;
    void automationsStore.loadAll();
    if (cwd) void session.worksStore.loadAll(cwd);
  });

  // Registered here (not in GitSection) so the shortcuts keep working while
  // the Git section is collapsed and unmounted.
  useKeybinding("orb.sync", () => {
    if (gitCtx) void gitActionsFor(panelTabId, session, environmentStore).sync();
  });
  useKeybinding("orb.commit-push", () => {
    if (gitCtx)
      void gitActionsFor(panelTabId, session, environmentStore).commitPush();
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
    const [result] = await Promise.all([
      environmentStore.refreshTab(session, {
        tabId: panelTabId,
        cwd: gitCwd,
        level: "full",
      }),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]);
    refreshState = result.ok ? "success" : "error";
    refreshResetTimer = setTimeout(() => {
      refreshState = "idle";
      refreshResetTimer = null;
    }, 1400);
  }

  function openFiles() {
    if (!gitCwd) return;
    session.panes.openFiles(panelTabId, panelEnvironment.cwd, panelEnvironment.checkout);
    requestInputFocus();
  }

  function newTask() {
    if (isUnconfiguredCwd(gitCwd)) return;
    session.ui.openTaskComposer(gitCwd);
    requestInputFocus();
  }

</script>

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
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-(--solus-text-tertiary)"
      type="button"
      aria-label="New task"
      disabled={isUnconfiguredCwd(gitCwd)}
      onclick={(e) => {
        e.stopPropagation();
        newTask();
      }}
    >
      <PlusIcon size={14} />
    </Button>
  </span>
{/snippet}

{#snippet panelHeaderActions()}
  {#if isSplitScope}
    <span
      class="inline-flex h-4 items-center rounded-full bg-(--solus-surface-hover) px-1.5 text-[0.5625rem] font-semibold tracking-[0.04em] text-(--solus-text-tertiary) uppercase"
      aria-label="Project panel scoped to split pane"
    >
      Split
    </span>
  {/if}
{/snippet}

<SidePanel
  title={projectName() ?? "Project"}
  side="right"
  {open}
  {managedWidth}
  minWidth={240}
  maxWidth={maxProjectPanelWidth}
  onAction={onClose}
  actionTooltip={`Close project panel (${comboHint("global.toggle-project-panel")})`}
  actionAriaLabel="Close project panel"
  headerActions={panelHeaderActions}
  background="color-mix(in srgb, var(--solus-container-bg) 90%, color-mix(in srgb, var(--solus-input-pill-bg) 70%, var(--solus-surface-primary)) 10%)"
  headerTopPadding="compact"
>
  <div
    bind:this={sectionsElement}
    class="project-sections"
    class:outer-scroll-source={!!outerScrollbar}
  >
    <PanelSection
      title="Environment"
      collapsed={settings.projectPanelCollapsed.git}
      onToggle={() => toggleSection("git")}
      headerExtra={gitHeaderExtra}
    >
      <GitSection tabId={panelTabId} active={open} onOpenFiles={openFiles} />
    </PanelSection>
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
