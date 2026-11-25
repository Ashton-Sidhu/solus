<script lang="ts">
  import { untrack } from "svelte";
  import {
    codebasesStore,
    getWorkspaceContext,
    getPullRequestsContext,
    getSettingsContext,
    type ProjectPanelSectionId,
    getSessionEnvironmentStore,
    hosts,
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
    RefreshCw as ArrowsClockwiseIcon,
    Check as CheckIcon,
    PanelLeft as SidebarSimpleIcon,
    SlidersHorizontal as CustomizeIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import SidePanel from "../layout/SidePanel.svelte";
  import PanelSection from "./PanelSection.svelte";
  import GoalSection from "./GoalSection.svelte";
  import AgentsSection from "./AgentsSection.svelte";
  import { getClientShellContext } from "../../contexts/app/client-shell.svelte";
  import RunningServers from "./RunningServers.svelte";
  import ServerUrlsEditor from "./ServerUrlsEditor.svelte";
  import { runningServerFolderPaths } from "@solus/client-core/running-servers";
  import { runningServers } from "../../contexts/running-servers/running-servers.store.svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { repositorySetupStore } from "../../contexts/git/repository-setup.store.svelte";
  import EnvironmentSection from "./EnvironmentSection.svelte";
  import GitCard from "./GitCard.svelte";
  import WebhooksSection from "./WebhooksSection.svelte";
  import ProjectPanelItemsMenu from "./ProjectPanelItemsMenu.svelte";
  import {
    allPanelItemsHidden,
    isPanelItemShown,
    isSectionShown,
    pointAnchor,
    type PanelMenuAnchor,
  } from "./lib/panel-items";
  import { webhooksStore } from "../../contexts/webhooks/webhooks.store.svelte";
  import {
    codebaseOf,
    isDispatch,
    projectHome,
    projectRoot,
  } from "../../contexts/workspace/run-location";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import {
    codebaseMembersOn,
    gitCardRepositories,
    showsRepositoryRows,
  } from "./lib/git-repositories";
  import { useDraftRepositoryReads } from "./lib/git-repository-reads.svelte";
  import { isUnconfiguredCwd } from "./lib/project-cwd";
  import { getOuterScrollbarContext } from "../layout/lib/outer-scrollbar.context";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "../ui/tooltip";
  import { Button } from "../ui/button";

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
    /** The workspace width while this conversation has the workspace to itself,
     *  so the rail folds with the session sidebar. Omitted in a split. */
    soleViewWorkspaceWidth?: number;
    /** Temporarily minimize without changing the role's persisted preference. */
    minimized?: boolean;
    /** The user opened the rail in a view too narrow for it to open alone. */
    revealed?: boolean;
    /** False while the owning workspace surface is mounted but hidden. */
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
    soleViewWorkspaceWidth,
    minimized = false,
    revealed = false,
    active = true,
    onCollapse,
  }: Props = $props();

  const session = getWorkspaceContext();
  const shell = getClientShellContext();
  const pullRequests = getPullRequestsContext();
  const settings = getSettingsContext();
  const environmentStore = getSessionEnvironmentStore();
  const outerScrollbar = getOuterScrollbarContext();
  let sectionsElement = $state<HTMLDivElement | null>(null);
  let panelHeight = $state(0);
  const initialRowCount = $derived(panelHeight <= 800 ? 3 : 5);

  $effect(() => {
    const element = sectionsElement;
    if (!outerScrollbar || !element) return;
    // Registration reads and mutates the parent's reactive target list. Keep
    // those implementation reads out of this element-lifecycle effect or the
    // effect subscribes to its own write and repeatedly tears itself down.
    return untrack(() => outerScrollbar.register(element));
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
  const preferredWidth = $derived(
    isSplit ? settings.splitProjectPanelWidth : settings.projectPanelWidth,
  );
  let dragWidth = $state<number | null>(null);
  const panelWidth = $derived(
    projectRailWidth(
      workspaceWidth,
      containerWidth,
      dragWidth ?? preferredWidth,
    ),
  );
  let resizeCleanup: (() => void) | null = null;

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanup?.();

    const startX = event.clientX;
    const startWidth = panelWidth;
    dragWidth = startWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: PointerEvent) => {
      dragWidth = startWidth - (moveEvent.clientX - startX);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");

      const width = dragWidth;
      dragWidth = null;
      resizeCleanup = null;
      if (width === null) return;
      settings.setLayout(
        isSplit ? "splitProjectPanelWidth" : "projectPanelWidth",
        projectRailWidth(workspaceWidth, containerWidth, width),
      );
    };

    resizeCleanup = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  $effect(() => () => resizeCleanup?.());

  // The role owns the preference; this owns whether the current layout can
  // honour it. Temporary minimization leaves that preference intact, so the
  // rail returns when the secondary panel closes.
  const open = $derived(
    isProjectRailOpen(preferOpen, containerWidth, minimized, revealed, soleViewWorkspaceWidth),
  );

  const panelSession = $derived(session.sessionFor(sourceId));
  const panelRun = $derived(session.runFor(sourceId));
  const panelEnvironment = $derived(environmentStore.environmentFor(panelRun));

  // What the person chose to show. A hidden item unmounts, and the reads that
  // only it needs stop with it.
  const hiddenItems = $derived(settings.projectPanelHiddenItems);
  const serversShown = $derived(isSectionShown(hiddenItems, "servers"));
  const serverHostId = $derived(
    serverConnections.serverIdForApi(session.apiFor(sourceId)),
  );
  const gitShown = $derived(isSectionShown(hiddenItems, "git"));
  const gitSetupShown = $derived(isPanelItemShown(hiddenItems, "git.setup"));
  const goalShown = $derived(isSectionShown(hiddenItems, "goal"));
  const webhooksShown = $derived(isSectionShown(hiddenItems, "webhooks"));

  // The project's webhooks: the section exists only while it has some.
  $effect(() => {
    if (webhooksShown) return untrack(() => webhooksStore.watch());
  });
  const projectPath = $derived(projectRoot(panelRun));
  const projectServerId = $derived(projectHome(panelRun)?.serverId);
  const projectWebhooks = $derived(
    projectPath && projectServerId
      ? webhooksStore.rowsForProject(projectServerId, projectPath)
      : [],
  );

  const gitCtx = $derived(panelEnvironment.checkout);
  const gitCwd = $derived(panelEnvironment.cwd);
  // The repositories of the Git card. The folders of a session exist on its
  // host once it has started. A draft whose working directory is no repository
  // lists the repositories of its codebase on the run host.
  const hasStarted = $derived(
    !!panelSession && hasSessionStarted(panelSession),
  );
  const serverCheckoutPaths = $derived(
    runningServerFolderPaths(panelEnvironment.cwd, panelSession?.sessionFolders),
  );
  const serverStore = $derived(runningServers.forHost(serverHostId));
  const canShowServers = $derived(serversShown && active && open && hosts.get(serverHostId).me.may("host.use"));
  const serverRows = $derived(canShowServers
    ? serverStore.rowsForScope({ checkoutPaths: serverCheckoutPaths, sessionId: panelSession?.id })
    : null);
  let otherServersSourceId = $state<string | null>(null);
  const isShowingOtherServers = $derived(otherServersSourceId === sourceId && !!serverRows?.otherRows.length);
  const visibleServerRows = $derived(isShowingOtherServers ? serverRows?.otherRows : serverRows?.sessionRows);
  $effect(() => {
    if (canShowServers) return serverStore.retainCheckouts(serverCheckoutPaths);
  });
  const draftCodebaseId = $derived(
    !hasStarted && !panelEnvironment.repoRoot ? codebaseOf(panelRun) : null,
  );
  useDraftRepositoryReads({
    get active() {
      return active && open && gitShown;
    },
    get codebaseId() {
      return draftCodebaseId;
    },
    codebases: codebasesStore,
  });
  const gitRepositories = $derived(
    gitShown
      ? gitCardRepositories({
          working: {
            path: gitCwd,
            repositoryPath: panelEnvironment.repoRoot,
            // A dispatch has its project home on a different host.
            projectPath: isDispatch(panelRun)
              ? (panelEnvironment.repoRoot ?? gitCwd)
              : projectRoot(panelRun),
          },
          sessionFolders:
            hasStarted && panelSession ? panelSession.sessionFolders : null,
          members: draftCodebaseId
            ? codebaseMembersOn(
                codebasesStore.membersOf(draftCodebaseId),
                serverHostId,
              )
            : [],
        })
      : [],
  );

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
      if (gitCtx)
        void gitActionsFor(
          sourceId,
          session,
          environmentStore,
          pullRequests.projects,
        ).sync();
    },
    { enabled: () => focused },
  );
  useKeybinding(
    "orb.commit-push",
    () => {
      if (gitCtx)
        void gitActionsFor(
          sourceId,
          session,
          environmentStore,
          pullRequests.projects,
        ).run("commit_push");
    },
    { enabled: () => focused },
  );

  function toggleSection(id: ProjectPanelSectionId) {
    collapsedSections[id] = !collapsedSections[id];
    settings.setLayout(
      isSplit ? "splitProjectPanelCollapsed" : "projectPanelCollapsed",
      collapsedSections,
    );
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
    // The repository's setup (a remote added outside Solus) is read once per
    // checkout; a person's refresh reads it again.
    if (gitCwd && gitCwd !== "~")
      void repositorySetupStore.refresh(
        session.apiFor(sourceId),
        serverHostId,
        gitCwd,
      );
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

  // The menu of what the panel shows: from the header button, a right-click,
  // or the context-menu key (Shift+F10) anywhere in the panel.
  let itemsMenuOpen = $state(false);
  let serverUrlsOpen = $state(false);
  let itemsMenuAnchor = $state<PanelMenuAnchor | null>(null);
  let customizeButton = $state<HTMLButtonElement | null>(null);

  function openItemsMenuAt(event: MouseEvent) {
    // A text field keeps its own menu (spelling, paste).
    if (
      event.target instanceof Element &&
      event.target.closest("input, textarea, [contenteditable]")
    )
      return;
    event.preventDefault();
    itemsMenuAnchor = pointAnchor(event.clientX, event.clientY);
    itemsMenuOpen = true;
  }

  function openItemsMenuFromKeyboard(event: KeyboardEvent) {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))
      return;
    if (
      event.target instanceof Element &&
      event.target.closest("input, textarea, [contenteditable]")
    )
      return;
    event.preventDefault();
    itemsMenuAnchor =
      event.target instanceof HTMLElement ? event.target : customizeButton;
    itemsMenuOpen = true;
  }

  function toggleItemsMenu() {
    if (itemsMenuOpen) {
      itemsMenuOpen = false;
      return;
    }
    itemsMenuAnchor = customizeButton;
    itemsMenuOpen = true;
  }

  function showAllItems() {
    settings.setPersonal("projectPanelHiddenItems", []);
    requestInputFocus();
  }

  function openFiles() {
    if (!gitCwd) return;
    session.openFiles(sourceId);
    requestInputFocus();
  }
</script>

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
    <button
      bind:this={customizeButton}
      class="tiny-icon"
      type="button"
      aria-label="Choose what the panel shows"
      title="Choose what the panel shows"
      aria-haspopup="menu"
      aria-expanded={itemsMenuOpen}
      onclick={toggleItemsMenu}
    >
      <CustomizeIcon size={12} />
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

<SidePanel
  side="right"
  region="project-panel"
  {open}
  flush
  width={panelWidth}
  minWidth={SIDEBAR_MIN_WIDTH}
  maxWidth={SIDEBAR_MAX_WIDTH}
  isResizing={dragWidth !== null}
  background="var(--solus-container-bg)"
>
  <!-- The menu listeners catch a right-click or the context-menu key from any
       control inside; the region itself takes no focus. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={sectionsElement}
    bind:clientHeight={panelHeight}
    class="project-sections"
    class:outer-scroll-source={!!outerScrollbar}
    role="region"
    aria-label="Project panel"
    oncontextmenu={openItemsMenuAt}
    onkeydown={openItemsMenuFromKeyboard}
  >
    {#if isSectionShown(hiddenItems, "environment")}
      <PanelSection
        title="Environment"
        titlebar
        collapsed={collapsedSections.environment}
        onToggle={() => toggleSection("environment")}
        headerExtra={environmentHeaderExtra}
        onResizePointerDown={startResize}
      >
        <EnvironmentSection
          {sourceId}
          active={active && open}
          onOpenFiles={openFiles}
          {hiddenItems}
        />
      </PanelSection>
    {:else}
      <!-- Environment is hidden. The panel's controls and the window's drag
           band stay, in a bar with no card. -->
      <div
        class="workspace-titlebar flex min-h-6 shrink-0 items-center justify-end px-1.5"
      >
        {@render environmentHeaderExtra()}
      </div>
    {/if}
    {#if allPanelItemsHidden(hiddenItems, shell.supportsNativeSettings)}
      <!-- Every section is hidden: say so, and give the way back. -->
      <div
        class="flex flex-col items-start gap-2 px-1.5 text-(--solus-text-tertiary)"
      >
        <p class="m-0">The panel shows no sections.</p>
        <span class="flex gap-1.5">
          <Button size="sm" variant="secondary" onclick={showAllItems}
            >Show all</Button
          >
          <Button size="sm" variant="ghost" onclick={toggleItemsMenu}
            >Choose…</Button
          >
        </span>
      </div>
    {/if}
    <!-- The card shows for a repository, and for a folder that holds
         repositories: it then lists them, and its Git rows work in the chosen
         one. With no repository at all, the card is only the way in: the
         Environment section above already names the folder. -->
    {#if gitShown && (gitCtx || showsRepositoryRows(gitRepositories) || (gitSetupShown && !isUnconfiguredCwd(gitCwd)))}
      <PanelSection
        title="Git"
        collapsed={collapsedSections.git}
        onToggle={() => toggleSection("git")}
        onResizePointerDown={startResize}
      >
        <GitCard
          {sourceId}
          active={active && open}
          {hiddenItems}
          rows={gitRepositories}
        />
      </PanelSection>
    {/if}
    {#if visibleServerRows?.length && serverRows}
      {#key isShowingOtherServers}
        <RunningServers
          hostId={serverHostId}
          rows={visibleServerRows}
          otherCheckoutCount={serverRows.otherRows.length}
          isShowingOther={isShowingOtherServers}
          onToggleOther={() => { otherServersSourceId = isShowingOtherServers ? null : sourceId; }}
          {initialRowCount}
          collapsed={collapsedSections.servers}
          onToggle={() => toggleSection("servers")}
          onResizePointerDown={startResize}
        />
      {/key}
    {/if}
    <!-- The section exists only while a goal is set. It owns its own card
         because the header controls share edit/confirm state with the body. -->
    {#if goalShown && panelSession?.goal}
      <!-- Only ever reached with a session behind it — a goal is something a
           conversation has, so the section names that conversation. -->
      <GoalSection
        sessionId={panelSession.id}
        collapsed={collapsedSections.goal}
        onToggle={() => toggleSection("goal")}
        onResizePointerDown={startResize}
        {hiddenItems}
      />
    {/if}
    {#if shell.supportsNativeSettings && panelSession && isSectionShown(hiddenItems, "agents")}
      {#key panelSession.id}
        <AgentsSection
          tabId={sourceId}
          sessionId={panelSession.id}
          serverId={session.serverIdFor(sourceId)}
          active={active && open}
          {initialRowCount}
          collapsed={collapsedSections.agents}
          onToggle={() => toggleSection("agents")}
          onResizePointerDown={startResize}
          {hiddenItems}
        />
      {/key}
    {/if}
    {#if webhooksShown && projectWebhooks.length > 0}
      <WebhooksSection
        rows={projectWebhooks}
        collapsed={collapsedSections.webhooks}
        onToggle={() => toggleSection("webhooks")}
        onResizePointerDown={startResize}
      />
    {/if}
  </div>
  <ProjectPanelItemsMenu
    bind:open={itemsMenuOpen}
    anchor={itemsMenuAnchor}
    onShowOtherServers={serverRows?.otherRows.length && !serverRows.sessionRows.length && !isShowingOtherServers
      ? () => {
          otherServersSourceId = sourceId;
          if (collapsedSections.servers) toggleSection("servers");
        }
      : undefined}
    onConfigureServerUrls={serverCheckoutPaths.length > 0
      ? () => {
          serverUrlsOpen = true;
        }
      : undefined}
  />
  {#if serverUrlsOpen && serverCheckoutPaths.length > 0}
    {#key serverHostId}
      <ServerUrlsEditor
        hostId={serverHostId}
        checkoutPaths={serverCheckoutPaths}
        onClose={() => {
          serverUrlsOpen = false;
        }}
      />
    {/key}
  {/if}
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
       list. The surface itself is painted once, by the SidePanel root below:
       --solus-container-bg carries alpha in dark mode over a transparent
       window, so a second coat here would read lighter than the conversation
       card. */
    gap: 0.5rem;
    padding: 0.5rem;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    scrollbar-gutter: stable;
    /* Row labels: 13px with a precise pointer, 14px on touch. Supporting text
       (counts, durations, reset times) steps down to the dense rung on its own
       element. */
    font-size: 0.8125rem;
    line-height: 1.1875rem;
  }
  @media (pointer: coarse) {
    .project-sections {
      font-size: var(--text-workspace-chrome);
    }
  }

  /* At the rail's narrow measure the fixed gutter is a large share of
     the column, so the cards give chrome back to their content. */
  @container (max-width: 17rem) {
    .project-sections {
      gap: 0.375rem;
      padding: 0.375rem;
    }
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
