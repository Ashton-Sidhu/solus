<script lang="ts">
  import { DesktopWindow } from "./shell/desktop-window.svelte";
  import { DesktopDialogs } from "./shell/desktop-dialogs.svelte";
  import { installDesktopRuntime } from "./shell/desktop-runtime.svelte";
  import { installDesktopUpdates } from "./shell/desktop-updates.svelte";
  import { installDesktopKeybindings } from "./shell/desktop-keybindings.svelte";
  import { createDesktopProjectPicker } from "./shell/desktop-project-picker.svelte";
  import { createDesktopPalette } from "./shell/desktop-palette.svelte";
  import {
    attachmentTarget,
    createDesktopAttachments,
  } from "./shell/desktop-attachments.svelte";

  import { untrack } from "svelte";
  import { Download as DownloadSimpleIcon } from "@lucide/svelte";
  import ConnectionStatusOverlay from "@solus/workspace-ui/components/servers/ConnectionStatusOverlay.svelte";
  import FatalErrorScene from "@solus/workspace-ui/components/servers/FatalErrorScene.svelte";
  import { openProjectStore } from "@solus/workspace-ui/components/servers/open-project.store.svelte";
  import type { ProjectRef } from "@solus/workspace-ui/contexts/projects/project-catalog";
  import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";

  import DesignAnnotation from "@solus/workspace-ui/components/artifact/DesignAnnotation.svelte";
  import RenameSessionDialog from "@solus/workspace-ui/components/session/RenameSessionDialog.svelte";
  import { Toaster } from "@solus/workspace-ui/components/ui/sonner/index.js";
  import * as Tooltip from "@solus/workspace-ui/components/ui/tooltip";

  import { connectionsStore, serversStore } from "@solus/workspace-ui/contexts";

  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import { setPopoverLayer } from "@solus/workspace-ui/components/popoverLayer.svelte";
  import { worktreeProjectRoot } from "@solus/contracts/types";
  import type { GitCheckout } from "@solus/contracts/types";

  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import { unsupportedOnHost } from "@solus/client-core/host-capabilities";

  import { localApi } from "@solus/client-core/local-api";

  import BrowserWebviewLayer from "./shell/BrowserWebviewLayer.svelte";
  import { uploadFileObjects } from "@solus/workspace-ui/components/input/lib/attachment-upload";

  import { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
  import { installGlobalDispatcher } from "@solus/workspace-ui/lib/keybindings/use-keybinding.svelte";

  const TOAST_HOTKEY = ["altKey", "shiftKey", "KeyT"];

  type EditorLayoutModule =
    typeof import("@solus/workspace-ui/components/layout/EditorLayout.svelte");
  type EditorLayoutComponent = EditorLayoutModule["default"];
  const commandPaletteModulePromise =
    import("@solus/workspace-ui/components/command-palette/CommandPalette.svelte");
  interface Props {
    initialEditorLayout?: EditorLayoutComponent;
  }
  let { initialEditorLayout }: Props = $props();

  const windowCtx = new DesktopWindow();
  const core = createAppCore(windowCtx);
  $effect(() => {
    windowCtx.conversationVisible =
      !windowCtx.isOverlayWindow || core.session.isExpanded;
  });
  const { settings, projectConfigStore, session, keybindings } = core;

  installDesktopRuntime(core, windowCtx);
  installDesktopUpdates(core, windowCtx);
  const ui = new DesktopDialogs();
  const {
    handleScreenshot,
    handleAttachFile,
    handleDesignMode,
    handleDesignConfirm,
    handleDesignCancel,
  } = createDesktopAttachments(core, ui);
  const {
    handleDirectorySelected,
    handleDirectoryPickerClose,
    startOpenProject,
    openProjectAtPath,
    browseForOpenProject,
  } = createDesktopProjectPicker(core, ui, () => directoryPickerServerId);
  const palette = createDesktopPalette(core, ui, startOpenProject);

  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return overlayEl;
    },
  });
  serversStore.init();

  // The standalone create-task composer (project cwd + optional session seed)
  // lives on the UI store so the palette, the action orb, and create-from-session
  // can all open it. Saves straight through to the provider.
  const taskComposer = $derived(session.ui.taskComposer);
  const sessionRename = $derived(session.ui.sessionRename);
  const taskComposerServerId = $derived(
    taskComposer
      ? (session.tasksStore.hostForProject(taskComposer.projectKey) ??
          serverConnections.defaultServerId())
      : null,
  );
  const taskComposerHost = $derived(
    taskComposerServerId
      ? {
          serverId: taskComposerServerId,
          api: serverConnections.apiFor(taskComposerServerId),
        }
      : null,
  );
  const taskComposerConfig = $derived(
    taskComposer
      ? projectConfigStore.configFor(
          taskComposerServerId,
          taskComposer.projectKey,
        )
      : undefined,
  );
  const taskComposerProvider = $derived(
    taskComposerConfig?.taskProvider ?? "local",
  );
  const taskComposerTasks = $derived(
    taskComposer
      ? session.tasksStore.tasksForProject(taskComposer.projectKey)
      : [],
  );
  const taskComposerEpics = $derived(
    taskComposerTasks.filter((t) => t.kind === "epic"),
  );
  const taskComposerLabels = $derived(
    taskComposer ? session.tasksStore.knownLabels(taskComposer.projectKey) : [],
  );

  $effect(() => {
    if (!taskComposer || !taskComposerHost) return;
    void projectConfigStore.load(taskComposerHost, taskComposer.projectKey);
  });

  const isExpanded = $derived(session.isExpanded);
  // Each Electron window is mode-locked (`?mode=` in its URL), so exactly one
  // layout mounts for the window's lifetime — no dual trees, no display:none
  // toggling. Switching modes surfaces the other OS window via switchMode.
  const viewMode = $derived(windowCtx.viewMode);
  const isEditorMode = $derived(viewMode === "editor");
  // Native hide/show leaves the mounted surface active. Electron preserves the
  // DOM exactly, so summoning the same window causes no renderer state change.
  // The shell passes each layout its native surface state.
  const editorSurfaceActive = $derived(isEditorMode);
  const pillSurfaceActive = $derived(!isEditorMode);
  type PillLayoutModule = typeof import("./shell/PillLayout.svelte");
  const initialViewMode = untrack(() => windowCtx.viewMode);
  let editorLayoutComponent = $state.raw<Promise<EditorLayoutModule> | null>(
    initialViewMode === "editor" && !untrack(() => initialEditorLayout)
      ? import("@solus/workspace-ui/components/layout/EditorLayout.svelte")
      : null,
  );
  let pillLayoutComponent = $state.raw<Promise<PillLayoutModule> | null>(
    initialViewMode === "pill" ? import("./shell/PillLayout.svelte") : null,
  );

  // Keep the native window's layout mounted for its lifetime.
  $effect(() => {
    if (isEditorMode) {
      editorLayoutComponent ??=
        import("@solus/workspace-ui/components/layout/EditorLayout.svelte");
    } else {
      pillLayoutComponent ??= import("./shell/PillLayout.svelte");
    }
  });

  // These components previously stayed mounted and managed their own open
  // guards. Keep that lifetime after the first lazy load so local draft/focus
  // state is not reset on every close.
  $effect(() => {
    if (ui.directoryPickerOpen) ui.hasMountedDirectoryPicker = true;
    if (ui.shortcutsModalOpen) ui.hasMountedShortcuts = true;
    if (ui.commandPaletteOpen) ui.hasMountedCommandPalette = true;
    if (ui.projectSearchOpen) ui.hasMountedProjectSearch = true;
    if (ui.goToFileOpen) ui.hasMountedGoToFile = true;
    if (serversStore.addServerOpen) ui.hasMountedAddServer = true;
    if (openProjectStore.isOpen) ui.hasMountedOpenProject = true;
    if (hostOnboardingStore.isOpen) ui.hasMountedHostOnboarding = true;
  });

  // Warm the components a keystroke can summon, so the first ⌘K / Open project
  // only opens them. Mounting is what pulls the lazy chunk in; doing it on the
  // click meant paying a fetch-and-parse behind a "Loading…" placeholder every
  // first time. Their data stays deferred until the store actually opens.
  $effect(() => {
    if (
      ui.hasMountedCommandPalette &&
      ui.hasMountedOpenProject &&
      ui.hasMountedDirectoryPicker
    )
      return;
    const warm = () => {
      ui.hasMountedCommandPalette = true;
      ui.hasMountedOpenProject = true;
      // Home hands straight off to the picker, so it is on the same hot path.
      ui.hasMountedDirectoryPicker = true;
    };
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(warm, { timeout: 1_500 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timeoutId = globalThis.setTimeout(warm, 250);
    return () => globalThis.clearTimeout(timeoutId);
  });

  // A bare host has no commit identity; this machine's is the obvious prefill,
  // so read it once from the local host rather than from the one being set up.
  $effect(() => {
    if (!openProjectStore.isOpen || ui.localGitIdentity) return;
    void serverConnections
      .localHostApi()
      ?.setupHostReadiness()
      .then((readiness) => (ui.localGitIdentity = readiness.git.identity))
      .catch(() => {});
  });
  const activeTabId = $derived(session.activeTabId);
  const keyboardTabId = $derived(session.focusedChatTabId ?? activeTabId);
  const desktopHandlersAvailable = $derived(
    connectionsStore.desktopHandlersAvailable,
  );
  const directoryPickerCreatesTab = $derived(
    ui.directoryPickerNewTab ||
      (!ui.directoryPickerTargetTabId && !!session.activeSession?.agentSessionId),
  );
  // Borrowed by the Open project flow, where the folder being chosen is a place
  // to put a clone rather than a project to open — so it gets its own wording.
  const directoryPickerTitle = $derived.by(() => {
    if (ui.directoryPickerForOpenProject) {
      return openProjectStore.source === "local"
        ? "Open a folder"
        : "Choose where to clone";
    }
    if (ui.directoryPickerForAddProject) return "Add a project";
    return directoryPickerCreatesTab
      ? "Open project in a new tab"
      : "Change project folder";
  });
  const directoryPickerAction = $derived.by(() => {
    if (ui.directoryPickerForOpenProject) {
      return openProjectStore.source === "local" ? "Open" : "Clone here";
    }
    if (ui.directoryPickerForAddProject) return "Add project";
    return directoryPickerCreatesTab ? "Open in new tab" : "Choose";
  });
  // Browse the host the tab actually runs on — a new tab inherits the active
  // session's host, so both flows resolve to the same place the commit lands.
  // An explicit override wins: it names a host before any tab points at it.
  const directoryPickerServerId = $derived(
    ui.directoryPickerServerIdOverride ??
      (ui.directoryPickerTargetTabId
        ? session.sessionFor(ui.directoryPickerTargetTabId)?.run.serverId
        : session.activeSession?.run.serverId) ??
      serverConnections.defaultServerId() ??
      LOCAL_SERVER_ID,
  );
  // apiFor() opens the connection as a side effect, so only reach for the
  // chosen host's api while the picker is actually on screen.
  const directoryPickerApi = $derived(
    ui.directoryPickerOpen
      ? serverConnections.apiFor(directoryPickerServerId)
      : serverConnections.apiFor(
          serverConnections.defaultServerId() ?? LOCAL_SERVER_ID,
        ),
  );
  const directoryPickerHostLabel = $derived(
    directoryPickerServerId === serversStore.activeServerId
      ? undefined
      : serversStore.servers.find((s) => s.id === directoryPickerServerId)?.label,
  );
  // Changing an existing tab's folder starts where that tab already is. Every
  // other entry point lets the picker resolve the selected host's projects root.
  const directoryPickerInitialPath = $derived.by(() => {
    const targetSession = ui.directoryPickerTargetTabId
      ? session.sessionFor(ui.directoryPickerTargetTabId)
      : null;
    if (targetSession?.run.serverId === directoryPickerServerId) {
      return targetSession.run.workingDirectory;
    }
    return undefined;
  });

  // Mount global scope and the single dispatcher listener (shared with web).
  installGlobalDispatcher(keybindings, () => settings.keybindings);
  installDesktopKeybindings(core, windowCtx, ui, {
    startOpenProject,
    handleScreenshot,
    handleAttachFile,
    handleDesignMode,
  });

  $effect(() => {
    if (!isEditorMode && !isExpanded && session.router.at("plan")) {
      session.closePlanModal();
    }
  });

  $effect(() => {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail:
        | {
            tabId?: string;
            draftId?: string;
            /** A tab id or a draft id — the surface that asked, when the emitter
             *  (RunOnPicker) does not know which kind it is scoped to. */
            requesterId?: string;
            serverId?: string;
            intent?: "dispatch" | "open-project" | "add-project";
            onProjectAdded?: (project: ProjectRef) => void;
          }
        | undefined = event.detail;
      const requesterId = detail?.requesterId;
      const requesterDraftId =
        requesterId && session.sessionDrafts.has(requesterId)
          ? requesterId
          : undefined;
      ui.directoryPickerDraftId = detail?.draftId ?? requesterDraftId;
      const targetTabId =
        detail?.tabId ?? (requesterDraftId ? undefined : requesterId);
      const tab = targetTabId ? session.tabs[targetTabId] : null;
      const opensInNewTab = tab?.sessionId != null;
      ui.directoryPickerNewTab = opensInNewTab;
      ui.directoryPickerTargetTabId = opensInNewTab ? undefined : targetTabId;
      ui.directoryPickerServerIdOverride = detail?.serverId;
      // Adding a project retargets nothing, so it keeps the plain open-project
      // run intent and states itself with its own flag.
      const requestedIntent = detail?.intent ?? "open-project";
      ui.directoryPickerForAddProject = requestedIntent === "add-project";
      ui.directoryPickerOnProjectAdded = detail?.onProjectAdded;
      ui.directoryPickerIntent =
        requestedIntent === "add-project" ? "open-project" : requestedIntent;
      ui.directoryPickerForOpenProject = false;
      ui.directoryPickerOpen = true;
    };
    const openProjectHandler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: { tabId?: string } | undefined = event.detail;
      startOpenProject({ sourceId: detail?.tabId });
    };
    // The git "Review a PR" action reuses the palette's PR list: open the
    // command palette drilled straight into the "Review PR…" sub-page.
    const reviewPrHandler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail:
        | {
            tabId?: string;
            cwd?: string;
            checkout?: GitCheckout | null;
          }
        | undefined = event.detail;
      const targetTabId = detail?.tabId ?? activeTabId;
      const targetSession = session.sessionFor(targetTabId);
      const dir =
        detail?.cwd ??
        targetSession?.run.gitContext?.repoRoot ??
        targetSession?.run.workingDirectory;
      ui.paletteGitTarget = {
        tabId: targetTabId,
        ctx: detail?.cwd
          ? session.ctxForEnvironment(
              detail.cwd,
              detail.checkout ?? null,
              targetTabId,
            )
          : session.ctxFor(targetTabId),
        projectRoot: dir && dir !== "~" ? worktreeProjectRoot(dir) : null,
      };
      ui.paletteInitialPage = { id: "review-pr", title: "Review PR" };
      ui.commandPaletteOpen = true;
    };
    // The nearby-host discovery toast fires from a store, which has no way to
    // reach the settings pane on its own.
    const showConnectionsHandler = () => session.showSettings("api-access");
    window.addEventListener("solus:open-directory-picker", handler);
    window.addEventListener("solus:open-project", openProjectHandler);
    window.addEventListener("solus:review-pr", reviewPrHandler);
    window.addEventListener("solus:show-connections", showConnectionsHandler);
    return () => {
      window.removeEventListener("solus:open-directory-picker", handler);
      window.removeEventListener("solus:open-project", openProjectHandler);
      window.removeEventListener("solus:review-pr", reviewPrHandler);
      window.removeEventListener(
        "solus:show-connections",
        showConnectionsHandler,
      );
    };
  });

  let isDraggingFile = $state(false);
  let dragCounter = 0;

  $effect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      dragCounter++;
      isDraggingFile = true;
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        isDraggingFile = false;
      }
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      isDraggingFile = false;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const { targetTabId, serverId, ctx } = attachmentTarget(session);
      try {
        const capabilities = await serverConnections.capabilitiesFor(serverId);
        if (capabilities.attachUpload !== true) {
          const hostLabel =
            serversStore.hostFor(serverId)?.label ??
            serverConnections.connectionFor(serverId)?.target.label ??
            "this host";
          toasts.info(unsupportedOnHost("File attachments", hostLabel));
          return;
        }
        if (!hostPolicy.isClientMachine(serverId)) {
          const attachments = await uploadFileObjects(
            serverConnections.apiFor(serverId),
            ctx,
            serverId,
            Array.from(files),
          );
          session.addAttachments(attachments, targetTabId);
          return;
        }
        const paths = Array.from(files)
          .map((file) => localApi.getPathForFile(file))
          .filter(Boolean);
        if (paths.length === 0) return;
        const attachments = await serverConnections
          .localHostApi()
          ?.attachFilePaths(paths, ctx);
        if (attachments) session.addAttachments(attachments, targetTabId);
      } catch (error) {
        toasts.error(
          error instanceof Error ? error.message : "Couldn't attach files",
        );
      }
    };
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  });
</script>

<!-- Mouse back/forward drive the same history the keybindings do. The
     pointer's 3rd/4th buttons have no default action here, so nothing is lost
     by claiming them. -->
<svelte:window
  onmouseup={(e) => {
    if (e.button === 3) session.router.back();
    else if (e.button === 4) session.router.forward();
  }}
/>

<!--
  Without this, a thrown render leaves an empty window with nothing to act on.
  The boundary keeps the failure inside the app, where the user still has a way
  back to a working host.
-->
<svelte:boundary onerror={(error) => console.error("renderer crashed", error)}>
  <Tooltip.Provider
    delayDuration={700}
    skipDelayDuration={300}
    disableHoverableContent
    ignoreNonKeyboardFocus
  >
    <Toaster
      theme={settings.isDark ? "dark" : "light"}
      position="top-right"
      offset={{ top: "1rem", right: "1rem" }}
      visibleToasts={3}
      duration={3000}
      closeButton
      hotkey={TOAST_HOTKEY}
    />

    <!-- Popover overlay layer: sits above everything, ignores events except where portals opt in. -->
    <div
      bind:this={overlayEl}
      data-solus-ui
      class="click-through-shell"
      style="position:fixed;inset:0;z-index:10010;pointer-events:none"
    ></div>

    {#if initialEditorLayout}
      {@const EditorLayout = initialEditorLayout}
      <div class="mode-shell h-full w-full" class:mode-hidden={!isEditorMode}>
        <EditorLayout
          active={editorSurfaceActive}
          onAttachFile={handleAttachFile}
          onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
          onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
        />
      </div>
    {:else if editorLayoutComponent}
      {#await editorLayoutComponent}
        <div
          class="mode-shell grid h-full w-full place-items-center text-xs text-(--solus-text-tertiary)"
          class:mode-hidden={!isEditorMode}
          role="status"
        >
          Loading workspace…
        </div>
      {:then editorLayoutModule}
        {@const EditorLayout = editorLayoutModule.default}
        <div class="mode-shell h-full w-full" class:mode-hidden={!isEditorMode}>
          <EditorLayout
            active={editorSurfaceActive}
            onAttachFile={handleAttachFile}
            onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
            onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
          />
        </div>
      {:catch}
        <div
          class="mode-shell grid h-full w-full place-items-center text-xs text-(--solus-status-error)"
          class:mode-hidden={!isEditorMode}
          role="alert"
        >
          Couldn’t load the workspace.
        </div>
      {/await}
    {/if}

    {#if pillLayoutComponent}
      {#await pillLayoutComponent}
        <div
          class="mode-shell grid h-full w-full place-items-center text-xs text-(--solus-text-tertiary)"
          class:mode-hidden={isEditorMode}
          role="status"
        >
          Loading workspace…
        </div>
      {:then pillLayoutModule}
        {@const PillLayout = pillLayoutModule.default}
        <div class="mode-shell" class:mode-hidden={isEditorMode}>
          <PillLayout
            active={pillSurfaceActive}
            onAttachFile={handleAttachFile}
            onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
            onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
          />
        </div>
      {:catch}
        <div
          class="mode-shell grid h-full w-full place-items-center text-xs text-(--solus-status-error)"
          class:mode-hidden={isEditorMode}
          role="alert"
        >
          Couldn’t load the workspace.
        </div>
      {/await}
    {/if}

    {#if ui.hasMountedDirectoryPicker}
      {#await import("@solus/workspace-ui/components/pickers/DirectoryPicker.svelte")}
        {#if ui.directoryPickerOpen}
          <div class="lazy-modal-loading" role="status">Loading folders…</div>
        {/if}
      {:then directoryPickerModule}
        {@const DirectoryPicker = directoryPickerModule.default}
        <DirectoryPicker
          bind:open={ui.directoryPickerOpen}
          onClose={handleDirectoryPickerClose}
          onSelect={handleDirectorySelected}
          initialPath={directoryPickerInitialPath}
          title={directoryPickerTitle}
          actionLabel={directoryPickerAction}
          api={directoryPickerApi}
          hostLabel={directoryPickerHostLabel}
          serverId={directoryPickerServerId}
        />
      {/await}
    {/if}

    {#if ui.hasMountedShortcuts}
      {#await import("@solus/workspace-ui/components/KeyboardShortcutsModal.svelte")}
        {#if ui.shortcutsModalOpen}
          <div class="lazy-modal-loading" role="status">Loading shortcuts…</div>
        {/if}
      {:then shortcutsModule}
        {@const KeyboardShortcutsModal = shortcutsModule.default}
        <KeyboardShortcutsModal
          bind:open={ui.shortcutsModalOpen}
          activeScopes={ui.shortcutsActiveScopes}
        />
      {/await}
    {/if}

    {#if ui.hasMountedGoToFile}
      {#await import("@solus/workspace-ui/components/search/FilePickerOverlay.svelte")}
        {#if ui.goToFileOpen}
          <div class="lazy-modal-loading" role="status">Loading files…</div>
        {/if}
      {:then filePickerModule}
        {@const FilePickerOverlay = filePickerModule.default}
        <FilePickerOverlay bind:open={ui.goToFileOpen} tabId={keyboardTabId} />
      {/await}
    {/if}

    {#if ui.hasMountedProjectSearch}
      {#await import("@solus/workspace-ui/components/search/ProjectSearchOverlay.svelte")}
        {#if ui.projectSearchOpen}
          <div class="lazy-modal-loading" role="status">Loading search…</div>
        {/if}
      {:then projectSearchModule}
        {@const ProjectSearchOverlay = projectSearchModule.default}
        <ProjectSearchOverlay
          bind:open={ui.projectSearchOpen}
          isDark={settings.isDark}
          tabId={keyboardTabId}
        />
      {/await}
    {/if}

    {#if ui.hasMountedCommandPalette}
      {#await commandPaletteModulePromise}
        {#if ui.commandPaletteOpen}
          <div class="lazy-modal-loading" role="status">Loading commands…</div>
        {/if}
      {:then commandPaletteModule}
        {@const CommandPalette = commandPaletteModule.default}
        <CommandPalette
          bind:open={ui.commandPaletteOpen}
          bind:initialPage={ui.paletteInitialPage}
          commands={palette.commands}
        />
      {/await}
    {/if}

    <!-- Paste-a-link import. Lazy like the other dialogs — most sessions never
     open it, and it pulls the works store's upstream path with it. -->
    {#if ui.importDocOpen}
      {#await import("@solus/workspace-ui/components/work/ImportDocDialog.svelte") then importDocModule}
        {@const ImportDocDialog = importDocModule.default}
        <ImportDocDialog
          open={ui.importDocOpen}
          onClose={() => (ui.importDocOpen = false)}
        />
      {/await}
    {/if}

    <ConnectionStatusOverlay dimBackdrop={isEditorMode} />

    {#if ui.hasMountedAddServer}
      {#await import("@solus/workspace-ui/components/servers/AddServerModal.svelte")}
        {#if serversStore.addServerOpen}
          <div class="lazy-modal-loading" role="status">
            Loading server setup…
          </div>
        {/if}
      {:then addServerModule}
        {@const AddServerModal = addServerModule.default}
        <AddServerModal />
      {/await}
    {/if}

    <!-- First run only. Mounted over everything, and never lazily pre-warmed: a
     client that has already been through it must not pay for the chunk. -->
    {#if !settings.onboardingCompleted}
      {#await import("@solus/workspace-ui/components/onboarding/OnboardingSurface.svelte")}
        <!-- Opaque from the first frame: without this the workspace is visible for
         as long as the lazy chunk takes to arrive. Same composite as the
         surface itself — --background alone is translucent in dark mode. -->
        <div
          class="fixed inset-0 z-[10005]"
          style="background: linear-gradient(var(--background), var(--background)) var(--solus-edge-bg)"
        ></div>
      {:then onboardingModule}
        {@const OnboardingSurface = onboardingModule.default}
        <OnboardingSurface />
      {/await}
    {/if}

    {#if ui.hasMountedOpenProject}
      {#await import("@solus/workspace-ui/components/servers/OpenProjectDialog.svelte")}
        {#if openProjectStore.isOpen}
          <div class="lazy-modal-loading" role="status">Loading projects…</div>
        {/if}
      {:then openProjectModule}
        {@const OpenProjectDialog = openProjectModule.default}
        <OpenProjectDialog
          onOpenProject={(path) =>
            void openProjectAtPath(path, openProjectStore.source !== "local")}
          onBrowse={browseForOpenProject}
          onBackgroundCloneFailure={(failure) =>
            toasts.error(failure.title, { description: failure.detail })}
          localIdentity={ui.localGitIdentity}
        />
      {/await}
    {/if}

    {#if ui.hasMountedHostOnboarding}
      {#await import("@solus/workspace-ui/components/servers/HostOnboarding.svelte")}
        {#if hostOnboardingStore.isOpen}
          <div class="lazy-modal-loading" role="status">
            Loading host setup…
          </div>
        {/if}
      {:then hostOnboardingModule}
        {@const HostOnboarding = hostOnboardingModule.default}
        <HostOnboarding />
      {/await}
    {/if}

    {#if sessionRename && session.tabs[sessionRename.tabId]}
      <RenameSessionDialog
        tabId={sessionRename.tabId}
        onClose={() => (session.ui.sessionRename = null)}
      />
    {/if}

    {#if taskComposer && taskComposerConfig !== undefined}
      {#await import("@solus/workspace-ui/components/tasks/TaskComposer.svelte")}
        <div class="lazy-modal-loading" role="status">
          Loading task composer…
        </div>
      {:then taskComposerModule}
        {@const TaskComposer = taskComposerModule.default}
        <TaskComposer
          epics={taskComposerEpics}
          allowEpics={taskComposerProvider === "local"}
          canPlan={taskComposerProvider === "local"}
          knownLabels={taskComposerLabels}
          workingDirectory={taskComposer.workingDirectory}
          provider={settings.activeAgent}
          onCreate={async (input) => {
            const context = taskComposer;
            if (!context) return;
            try {
              await session.tasksStore.create({
                ...input,
                projectKey: context.projectKey,
              });
              toasts.success("Task created");
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              toasts.error("Couldn't create task", { description: message });
              // Rethrow so the composer keeps the modal open; it owns dismissal on
              // success (via onCancel) so "Create more" can stay open.
              throw err;
            }
          }}
          onCancel={() => (session.ui.taskComposer = null)}
        />
      {/await}
    {/if}

    {#if ui.designModeScreenshot}
      <DesignAnnotation
        screenshotDataUrl={ui.designModeScreenshot}
        onConfirm={handleDesignConfirm}
        onCancel={handleDesignCancel}
      />
    {/if}

    <!-- Every native browser surface in the app, mounted once and positioned over
     whichever pane asks for it. It cannot live inside a pane: reparenting a
     `<webview>` reloads its guest and `display: none` stops it rendering. -->
    <BrowserWebviewLayer />

    {#if isDraggingFile}
      <div data-solus-ui class="drop-overlay">
        <div class="drop-overlay-content">
          <DownloadSimpleIcon size={24} />
          <span>Drop files to attach</span>
        </div>
      </div>
    {/if}
    <!-- Keep this native no-drag rectangle outside Sonner's transformed cards.
         Their overflowing close buttons do not exclude the titlebar beneath. -->
    <div class="toast-close-drag-guard" aria-hidden="true"></div>
  </Tooltip.Provider>

  {#snippet failed(error)}
    <FatalErrorScene {error} />
  {/snippet}
</svelte:boundary>

<style>
  .toast-close-drag-guard {
    display: none;
    position: fixed;
    top: 0;
    right: 0;
    width: calc(1rem + 44px);
    height: var(--solus-titlebar-height);
    pointer-events: none;
    -webkit-app-region: no-drag;
    z-index: 999999999;
  }

  :global(html.is-mac-editor:has(.toaster[data-x-position="right"][data-y-position="top"] [data-sonner-toast][data-visible="true"] [data-close-button]))
    .toast-close-drag-guard {
    display: block;
  }

  .mode-hidden {
    display: none !important;
  }

  .lazy-modal-loading {
    position: fixed;
    inset: 0;
    z-index: 10024;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--solus-container-bg) 72%, transparent);
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    pointer-events: auto;
  }

  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--color-zinc-900) 40%, transparent);
    backdrop-filter: blur(0.125rem);
    pointer-events: none;
  }

  .drop-overlay-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
    padding: 1.5rem 2.5rem;
    border-radius: 1rem;
    border: 0.0938rem dashed var(--color-zinc-600);
    color: var(--color-zinc-400);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  :global(.light) .drop-overlay {
    background: color-mix(in oklab, var(--color-zinc-100) 40%, transparent);
  }

  :global(.light) .drop-overlay-content {
    border-color: var(--color-zinc-400);
    color: var(--color-zinc-500);
  }
</style>
