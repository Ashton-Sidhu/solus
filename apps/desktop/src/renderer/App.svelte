<script lang="ts">
  import { DesktopWindow } from "./shell/desktop-window.svelte";
  import { DesktopDialogs } from "./shell/desktop-dialogs.svelte";
  import { installDesktopRuntime } from "./shell/desktop-runtime.svelte";
  import { installDesktopUpdates } from "./shell/desktop-updates.svelte";
  import { installDesktopKeybindings } from "./shell/desktop-keybindings.svelte";
  import { createDesktopPalette } from "./shell/desktop-palette.svelte";
  import {
    attachmentTarget,
    createDesktopAttachments,
  } from "./shell/desktop-attachments.svelte";

  import { untrack } from "svelte";
  import { afterPaint } from "@solus/workspace-ui/lib/after-paint";
  import { Download as DownloadSimpleIcon } from "@lucide/svelte";
  import ConnectionStatusOverlay from "@solus/workspace-ui/components/servers/ConnectionStatusOverlay.svelte";
  import FatalErrorScene from "@solus/workspace-ui/components/servers/FatalErrorScene.svelte";
  import LazyDialog from "@solus/workspace-ui/components/pickers/LazyDialog.svelte";
  import { openProjectStore } from "@solus/workspace-ui/components/servers/open-project.store.svelte";
  import { createProjectPicker } from "@solus/workspace-ui/components/servers/project-picker.svelte";
  import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";
  import { skipsOnboarding } from "@solus/workspace-ui/components/onboarding/lib/skip-onboarding";

  import DesignAnnotation from "@solus/workspace-ui/components/artifact/DesignAnnotation.svelte";
  import RenameSessionDialog from "@solus/workspace-ui/components/session/RenameSessionDialog.svelte";
  import SessionLinkPrompts from "@solus/workspace-ui/components/session/SessionLinkPrompts.svelte";
  import { Toaster } from "@solus/workspace-ui/components/ui/sonner/index.js";
  import * as Tooltip from "@solus/workspace-ui/components/ui/tooltip";

  import { connectionsStore, serversStore, sharesStore } from "@solus/workspace-ui/contexts";

  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import { setPopoverLayer } from "@solus/workspace-ui/components/popoverLayer.svelte";
  import { worktreeProjectRoot } from "@solus/contracts/types";
  import type { GitCheckout } from "@solus/contracts/types";

  import { serverConnections } from "@solus/client-core/server-connections";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import { unsupportedOnHost } from "@solus/client-core/host-capabilities";

  import { localApi } from "@solus/client-core/local-api";

  import BrowserWebviewLayer from "./shell/BrowserWebviewLayer.svelte";
  import { uploadFileObjects } from "@solus/workspace-ui/components/input/lib/attachment-uploads.svelte";

  import { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
  import { installGlobalDispatcher } from "@solus/workspace-ui/lib/keybindings/use-keybinding.svelte";

  const TOAST_HOTKEY = ["altKey", "shiftKey", "KeyT"];
  const skipOnboarding = skipsOnboarding(window.location.search);

  type WorkspaceLayoutModule =
    typeof import("@solus/workspace-ui/components/layout/WorkspaceLayout.svelte");
  type WorkspaceLayoutComponent = WorkspaceLayoutModule["default"];
  interface Props {
    initialWorkspaceLayout?: WorkspaceLayoutComponent;
  }
  let { initialWorkspaceLayout }: Props = $props();

  const windowCtx = new DesktopWindow();
  const core = createAppCore(windowCtx);
  const { settings, session, keybindings } = core;

  installDesktopRuntime(core);
  installDesktopUpdates(core);
  const ui = new DesktopDialogs();
  const {
    handleScreenshot,
    handleAttachFile,
    handleDesignMode,
    handleDesignConfirm,
    handleDesignCancel,
  } = createDesktopAttachments(core, ui);
  const projectPicker = createProjectPicker(session);
  const { startOpenProject } = projectPicker;
  const palette = createDesktopPalette(core, ui, startOpenProject);

  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return overlayEl;
    },
  });
  serversStore.init();

  const sessionRename = $derived(session.ui.sessionRename);
  let workspaceLayoutComponent = $state.raw<Promise<WorkspaceLayoutModule> | null>(
    !untrack(() => initialWorkspaceLayout)
      ? import("@solus/workspace-ui/components/layout/WorkspaceLayout.svelte")
      : null,
  );

  $effect(() => {
    if (sharesStore.dialog) ui.hasMountedShareDialog = true;
  });

  // Warm the dialogs a keystroke can summon (go to file, find in files, open
  // project), so their first open only shows them. Mounting is what pulls the
  // lazy chunk in; doing it on the keystroke meant paying a fetch-and-parse
  // behind a skeleton every first time. Their data stays deferred until they
  // open. Home hands straight off to the folder picker, so it is warmed too.
  $effect(() => {
    if (ui.hasWarmedDialogs) return;
    const warm = () => (ui.hasWarmedDialogs = true);
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
  // Mount global scope and the single dispatcher listener (shared with web).
  installGlobalDispatcher(keybindings, () => settings.keybindings);
  installDesktopKeybindings(core, ui, {
    startOpenProject,
    handleScreenshot,
    handleAttachFile,
    handleDesignMode,
  });

  $effect(() => {
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
    window.addEventListener("solus:review-pr", reviewPrHandler);
    window.addEventListener("solus:show-connections", showConnectionsHandler);
    return () => {
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

    {#if initialWorkspaceLayout}
      {@const WorkspaceLayout = initialWorkspaceLayout}
      <div class="workspace-shell h-full w-full">
        <WorkspaceLayout
          onAttachFile={handleAttachFile}
          onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
          onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
        />
      </div>
    {:else if workspaceLayoutComponent}
      {#await workspaceLayoutComponent}
        <div
          class="workspace-shell grid h-full w-full place-items-center text-xs text-(--solus-text-tertiary)"
          role="status"
        >
          Loading workspace…
        </div>
      {:then workspaceLayoutModule}
        {@const WorkspaceLayout = workspaceLayoutModule.default}
        <div class="workspace-shell h-full w-full">
          <WorkspaceLayout
            onAttachFile={handleAttachFile}
            onScreenshot={desktopHandlersAvailable ? handleScreenshot : null}
            onDesignMode={desktopHandlersAvailable ? handleDesignMode : null}
          />
        </div>
      {:catch}
        <div
          class="workspace-shell grid h-full w-full place-items-center text-xs text-(--solus-status-error)"
          role="alert"
        >
          Couldn’t load the workspace.
        </div>
      {/await}
    {/if}

    {#if projectPicker.directoryPickerApi}
    {@const directoryPickerApi = projectPicker.directoryPickerApi}
    <LazyDialog
      open={projectPicker.directoryPickerOpen}
      warm={ui.hasWarmedDialogs}
      load={() => import("@solus/workspace-ui/components/pickers/DirectoryPicker.svelte")}
      placeholder="Filter folders"
      centered
      class="h-[clamp(28rem,65vh,43rem)] max-h-none w-[clamp(42rem,72vw,64rem)]"
      onclose={projectPicker.handleDirectoryPickerClose}
    >
      {#snippet children(DirectoryPicker)}
        <DirectoryPicker
          bind:open={projectPicker.directoryPickerOpen}
          onClose={projectPicker.handleDirectoryPickerClose}
          onSelect={projectPicker.handleDirectorySelected}
          initialPath={projectPicker.directoryPickerInitialPath}
          title={projectPicker.directoryPickerTitle}
          actionLabel={projectPicker.directoryPickerAction}
          api={directoryPickerApi}
          hostLabel={projectPicker.directoryPickerHostLabel}
          serverId={projectPicker.directoryPickerServerId}
        />
      {/snippet}
    </LazyDialog>
    {/if}

    <LazyDialog
      open={ui.shortcutsModalOpen}
      load={() => import("@solus/workspace-ui/components/KeyboardShortcutsModal.svelte")}
      placeholder="Search shortcuts…"
      centered
      class="max-h-[70vh] w-[41.25rem]"
      onclose={() => (ui.shortcutsModalOpen = false)}
    >
      {#snippet children(KeyboardShortcutsModal)}
        <KeyboardShortcutsModal
          bind:open={ui.shortcutsModalOpen}
          activeScopes={ui.shortcutsActiveScopes}
        />
      {/snippet}
    </LazyDialog>

    <LazyDialog
      open={ui.goToFileOpen}
      warm={ui.hasWarmedDialogs}
      load={() => import("@solus/workspace-ui/components/search/FilePickerOverlay.svelte")}
      placeholder="Go to file…"
      onclose={() => (ui.goToFileOpen = false)}
    >
      {#snippet children(FilePickerOverlay)}
        <FilePickerOverlay bind:open={ui.goToFileOpen} tabId={keyboardTabId} />
      {/snippet}
    </LazyDialog>

    <LazyDialog
      open={ui.projectSearchOpen}
      warm={ui.hasWarmedDialogs}
      load={() => import("@solus/workspace-ui/components/search/ProjectSearchOverlay.svelte")}
      placeholder="Search in files…"
      class="h-[min(34rem,70vh)] max-h-none w-[clamp(22rem,64vw,46rem)]"
      onclose={() => (ui.projectSearchOpen = false)}
    >
      {#snippet children(ProjectSearchOverlay)}
        <ProjectSearchOverlay
          bind:open={ui.projectSearchOpen}
          isDark={settings.isDark}
          tabId={keyboardTabId}
        />
      {/snippet}
    </LazyDialog>

    <!-- The command palette is keyboard-critical and cheap while hidden. It mounts
         with the app, after first paint, so the first shortcut only opens it. -->
    <LazyDialog
      open={ui.commandPaletteOpen}
      warm
      load={() =>
        afterPaint().then(() => import("@solus/workspace-ui/components/command-palette/CommandPalette.svelte"))}
      placeholder="Type a command or search…"
      class="max-h-[60vh]"
      onclose={() => (ui.commandPaletteOpen = false)}
    >
      {#snippet children(CommandPalette)}
        <CommandPalette
          bind:open={ui.commandPaletteOpen}
          bind:initialPage={ui.paletteInitialPage}
          commands={palette.commands}
        />
      {/snippet}
    </LazyDialog>

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

    <ConnectionStatusOverlay dimBackdrop />

    <LazyDialog
      open={serversStore.addServerOpen}
      load={() => import("@solus/workspace-ui/components/servers/AddServerModal.svelte")}
      title="Add server"
      class="w-[28rem]"
      onclose={() => serversStore.closeAddServer()}
    >
      {#snippet children(AddServerModal)}
        <AddServerModal />
      {/snippet}
    </LazyDialog>

    <!-- First run only. Mounted over everything, and never lazily pre-warmed: a
     client that has already been through it must not pay for the chunk. -->
    {#if !skipOnboarding && !settings.onboardingCompleted}
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

    <LazyDialog
      open={openProjectStore.isOpen}
      warm={ui.hasWarmedDialogs}
      load={() => import("@solus/workspace-ui/components/servers/OpenProjectDialog.svelte")}
      title="Open project"
      class="w-[42rem]"
      onclose={() => openProjectStore.close()}
    >
      {#snippet children(OpenProjectDialog)}
        <OpenProjectDialog
          onOpenProject={(path) =>
            void projectPicker.openProjectAtPath(path, openProjectStore.source)}
          onBrowse={projectPicker.browseForOpenProject}
          onBackgroundCloneFailure={(failure) =>
            toasts.error(failure.title, { description: failure.detail })}
          localIdentity={ui.localGitIdentity}
        />
      {/snippet}
    </LazyDialog>

    <LazyDialog
      open={hostOnboardingStore.isOpen}
      load={() => import("@solus/workspace-ui/components/servers/HostOnboarding.svelte")}
      title="Set up host"
      centered
      class="min-h-[26rem] w-[58.75rem]"
      onclose={() => hostOnboardingStore.close()}
    >
      {#snippet children(HostOnboarding)}
        <HostOnboarding />
      {/snippet}
    </LazyDialog>


    <SessionLinkPrompts />

    {#if sessionRename && session.tabs[sessionRename.tabId]}
      <RenameSessionDialog
        tabId={sessionRename.tabId}
        onClose={() => (session.ui.sessionRename = null)}
      />
    {/if}

    {#if ui.hasMountedShareDialog}
      {#await import("@solus/workspace-ui/components/sharing/ShareDialog.svelte") then module}
        {@const ShareDialog = module.default}
        <ShareDialog />
      {:catch}
        {#if sharesStore.dialog}
          <p role="alert">Could not load the share dialog.</p>
        {/if}
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

  :global(html.is-mac-workspace:has(.toaster[data-x-position="right"][data-y-position="top"] [data-sonner-toast][data-visible="true"] [data-close-button]))
    .toast-close-drag-guard {
    display: block;
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
