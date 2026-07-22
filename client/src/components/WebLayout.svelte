<script lang="ts">
  import { untrack } from "svelte";
  import ConversationView from "@renderer/components/conversation/ConversationView.svelte";
  import NewTabHome from "@renderer/components/layout/NewTabHome.svelte";
  import SessionPicker from "@renderer/components/session/SessionPicker.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { getPlanStore, getWorkspaceContext, runtime } from "@renderer/contexts";
  import WebMobileLayout from "./WebMobileLayout.svelte";
  import WebDesktopLayout from "./WebDesktopLayout.svelte";
  import { router } from "../lib/router.svelte";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
  import { toasts } from "../lib/toast.store.svelte";
  import { webState } from "../lib/web-state.svelte";
  import {
    FILE_PREVIEW_EVENT,
    type FilePreviewRequest,
  } from "@renderer/lib/filePreview";
  import type { DiffScope } from "@shared/types";

  interface Props {
    onAttachFile: (tabId?: string) => void | Promise<void>;
  }
  let { onAttachFile }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const panes = session.panes;

  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const changedFiles = $derived(sess?.changedFiles ?? []);
  let sidePanelSourceTabId = $state(session.activeTabId);
  const sidePanelTab = $derived(session.tabs[sidePanelSourceTabId]);
  const sidePanelSession = $derived(session.sessionFor(sidePanelSourceTabId));
  const isWorktree = $derived(!!sidePanelSession?.gitContext?.worktreePath);
  const canShowDiffPanel = $derived(!!sidePanelSession?.workingDirectory);
  const activePlan = $derived.by(() => {
    const planId = session.panes.activePlanId;
    if (planId) return planStore.get(planId) ?? null;
    return planStore.previewPlan;
  });
  const activeWork = $derived.by(() => {
    const workId = session.panes.activeWorkId;
    return workId ? session.worksStore.get(workId) ?? null : null;
  });

  const isMobile = $derived(runtime.isMobileViewport);

  let connectionTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionToastId: number | null = null;
  let connectionToastKind: "blocked" | "lost" | null = null;

  function showConnectionLostToast() {
    connectionTimer = null;
    connectionToastKind = "lost";
    connectionToastId = toasts.error("Connection lost — reconnecting…", {
      duration: Infinity,
      actions: [{ label: "Retry now", onAction: () => window.location.reload() }],
    });
  }

  function showBlockedToast() {
    connectionToastKind = "blocked";
    connectionToastId = toasts.error("Re-pair this server to continue", {
      duration: Infinity,
      actions: [{
        label: "Switch server",
        onAction: () => document.dispatchEvent(new CustomEvent("solus:logout")),
      }],
    });
  }

  $effect(() => {
    const status = webState.connectionStatus;
    if (connectionTimer) clearTimeout(connectionTimer);
    connectionTimer = null;

    if (status === "blocked") {
      showBlockedToast();
      return;
    }

    if (status === "disconnected" || status === "connecting" || status === "reconnecting") {
      const ownsActiveToast = connectionToastId !== null &&
        untrack(() => toasts.active?.id === connectionToastId);
      if (ownsActiveToast) {
        if (connectionToastKind === "blocked") showConnectionLostToast();
        return;
      }

      connectionTimer = setTimeout(showConnectionLostToast, 5000);
      return () => {
        if (connectionTimer) clearTimeout(connectionTimer);
        connectionTimer = null;
      };
    }

    const recoveredToastId = connectionToastId;
    connectionToastId = null;
    connectionToastKind = null;
    if (recoveredToastId !== null && untrack(() => toasts.dismiss(recoveredToastId))) {
      toasts.info("Reconnected", { duration: 3000 });
    }
  });

  // ── Mobile-only diff state ──
  // The desktop layout reads the shared `panes` (panes) for its diff /
  // plan / work panes. Mobile keeps its own lightweight state because it renders
  // a single full-screen diff via the snippets below, not the split-pane system.
  let diffPanelOpen = $state(false);
  let diffPanelMaximized = $state(false);
  let diffScope = $state<DiffScope>({ kind: "session" });
  let editorFile = $state<FilePreviewRequest | null>(null);
  const canShowSidePanel = $derived(canShowDiffPanel || !!editorFile);
  // Mobile always shows the diff full-screen.
  const effectiveDiffMaximized = $derived(true);

  // Browser/OS back closes the topmost full-screen overlay on mobile, instead of
  // leaving the app. The mobile sheets/drawers register themselves in WebMobileLayout.
  function closeDiffPanel() {
    diffPanelOpen = false;
    diffPanelMaximized = false;
    editorFile = null;
  }
  registerBackOverlay("settings", () => isMobile && session.settingsOpen, () => session.closeSettings());
  registerBackOverlay("plans-gallery", () => isMobile && session.plansGalleryOpen, () => (session.plansGalleryOpen = false));
  registerBackOverlay("folio-gallery", () => isMobile && session.folioGalleryOpen, () => (session.folioGalleryOpen = false));
  registerBackOverlay("work-modal", () => isMobile && !!activeWork, () => session.closeWorkModal());
  registerBackOverlay("diff-panel", () => isMobile && diffPanelOpen, closeDiffPanel);

  let hasMountedMobile = $state(runtime.isMobileViewport);
  let hasMountedDesktop = $state(!runtime.isMobileViewport);
  $effect(() => {
    if (isMobile) hasMountedMobile = true;
    else hasMountedDesktop = true;
  });

  // Galleries retain filters and scroll state between opens. Keep each tree
  // alive after first use without loading either module on a chat-only launch.
  const mountedGalleries = new SvelteSet<"plans" | "folio">();
  $effect(() => {
    if (session.plansGalleryOpen) mountedGalleries.add("plans");
    if (session.folioGalleryOpen) mountedGalleries.add("folio");
  });

  let prevActiveTabId: string | undefined;
  $effect(() => {
    const current = session.activeTabId;
    if (prevActiveTabId !== undefined && prevActiveTabId !== current) {
      sidePanelSourceTabId = current;
      if (isMobile) {
        diffPanelOpen = false;
        diffPanelMaximized = false;
        editorFile = null;
      } else if (panes.secondaryOverlay?.kind === "diff") {
        panes.closeOverlay();
      }
      router.syncTabId(current);
    }
    prevActiveTabId = current;
  });

  $effect(() => {
    const handler = () => {
      session.sessionPickerOpen = !session.sessionPickerOpen;
    };
    window.addEventListener("solus:toggle-session-picker", handler);
    return () => window.removeEventListener("solus:toggle-session-picker", handler);
  });

  $effect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId?: string; scope?: DiffScope }>).detail;
      const sourceTabId =
        detail?.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      const canShowSourceDiff = !!session.sessionFor(sourceTabId)?.workingDirectory;
      const scope = detail?.scope ?? { kind: "session" };
      if (!isMobile) {
        panes.toggleDiff(canShowSourceDiff, sourceTabId, scope);
        return;
      }
      sidePanelSourceTabId = sourceTabId;
      // Mobile bespoke toggle.
      if (editorFile) {
        editorFile = null;
        if (scope.kind === "session") {
          diffPanelOpen = false;
          diffPanelMaximized = false;
          return;
        }
        if (canShowSourceDiff) {
          diffScope = scope;
          diffPanelOpen = true;
        }
        return;
      }
      if (canShowSourceDiff) {
        editorFile = null;
        if (diffPanelOpen && diffScope.kind === scope.kind) {
          diffPanelOpen = false;
        } else {
          diffScope = scope;
          diffPanelOpen = true;
        }
        if (!diffPanelOpen) diffPanelMaximized = false;
      }
    };
    window.addEventListener("solus:toggle-diff-panel", handler);
    return () => window.removeEventListener("solus:toggle-diff-panel", handler);
  });

  $effect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<FilePreviewRequest>).detail;
      if (!detail?.path) return;
      const sourceTabId =
        detail.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      session.settingsOpen = false;
      session.plansGalleryOpen = false;
      if (!isMobile) {
        panes.openFilePreview(detail, sourceTabId);
        return;
      }
      sidePanelSourceTabId = sourceTabId;
      editorFile = detail;
      diffScope = { kind: "session" };
      diffPanelOpen = false;
    };
    window.addEventListener(FILE_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(FILE_PREVIEW_EVENT, handler);
  });

  // `session.showSettings` opens the settings pane, which internally reads
  // pane state (to decide primary vs. secondary slot) — reading that inside
  // this effect would make it depend on the pane, not just the route, so
  // closing settings (which changes the pane) would re-trigger this effect
  // and immediately reopen it before the effect below navigates away. Untrack
  // the call so this effect only reacts to the route.
  $effect(() => {
    if (router.current.name === "settings") {
      const tab = router.current.tab as "general" | "connections" | "tools" | undefined;
      untrack(() => session.showSettings(tab ?? "general"));
    }
  });

  $effect(() => {
    if (session.settingsOpen && router.current.name !== "settings") {
      router.navigateToSettings(session.settingsTab);
    } else if (!session.settingsOpen && router.current.name === "settings") {
      router.navigateToChat();
    }
  });

  function togglePlans() {
    session.togglePlansGallery();
  }

  function toggleDiff() {
    if (editorFile) {
      editorFile = null;
      diffPanelOpen = false;
      diffPanelMaximized = false;
      return;
    }
    const sourceTabId = session.activeTabId;
    sidePanelSourceTabId = sourceTabId;
    if (session.sessionFor(sourceTabId)?.workingDirectory) {
      editorFile = null;
      diffScope = { kind: "session" };
      diffPanelOpen = !diffPanelOpen;
      if (!diffPanelOpen) diffPanelMaximized = false;
    }
  }
</script>

{#snippet loadingSurface(label: string)}
  <div
    class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
    role="status"
  >
    {label}
  </div>
{/snippet}

{#snippet chatContent()}
  {#if session.settingsOpen}
    {#await import("@renderer/components/settings/SettingsPage.svelte")}
      {@render loadingSurface("Loading settings…")}
    {:then settingsModule}
      {@const SettingsPage = settingsModule.default}
      <SettingsPage />
    {/await}
  {:else}
    {#if mountedGalleries.has("plans")}
      {#await import("@renderer/components/plan/PlanGallery.svelte")}
        {@render loadingSurface("Loading plans…")}
      {:then planGalleryModule}
        {@const PlanGallery = planGalleryModule.default}
        <PlanGallery />
      {/await}
    {/if}
    {#if mountedGalleries.has("folio")}
      {#await import("@renderer/components/artifact/FolioGallery.svelte")}
        {@render loadingSurface("Loading works…")}
      {:then folioGalleryModule}
        {@const FolioGallery = folioGalleryModule.default}
        <FolioGallery />
      {/await}
    {/if}
    {#if !session.plansGalleryOpen && !session.folioGalleryOpen}
      {#if activeWork}
        {#await import("@renderer/components/document-modal/DocumentModal.svelte")}
          {@render loadingSurface("Loading document…")}
        {:then documentModule}
          {@const DocumentModal = documentModule.default}
          <DocumentModal
            document={{ title: activeWork.title, content: activeWork.content }}
            onSave={async (content) => {
              await session.worksStore.save(activeWork.id, { content });
            }}
            onClose={() => session.closeWorkModal()}
            inline
          />
        {/await}
      {:else if activePlan}
        {#await import("@renderer/components/plan/PlanModal.svelte")}
          {@render loadingSurface("Loading plan…")}
        {:then planModalModule}
          {@const PlanModal = planModalModule.default}
          <PlanModal plan={activePlan} inline />
        {/await}
      {:else}
        <div class="flex min-h-0 flex-1 flex-col">
          {#if session.tabOrder.length === 0 && !session.plansGalleryOpen}
            <NewTabHome />
          {/if}
          {#each session.tabOrder as tId (tId)}
            <div
              class="tab-slot flex h-full min-h-0 flex-col [contain-intrinsic-size:auto_62.5rem] [content-visibility:auto]"
              class:tab-hidden={tId !== session.activeTabId}
            >
              <ConversationView
                tabId={tId}
                onDiffToggle={() => {
                  sidePanelSourceTabId = tId;
                  if (!session.sessionFor(tId)?.workingDirectory) return;
                  editorFile = null;
                  diffScope = { kind: "session" };
                  diffPanelOpen = !diffPanelOpen;
                  if (!diffPanelOpen) diffPanelMaximized = false;
                }}
              />
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
{/snippet}

{#snippet diffContent()}
  {#if editorFile && sidePanelTab && sidePanelSession}
    {#await import("@renderer/components/files/FileEditorPane.svelte")}
      {@render loadingSurface("Loading file…")}
    {:then fileEditorModule}
      {@const FileEditorPane = fileEditorModule.default}
      <FileEditorPane
        ctx={session.ctxFor(sidePanelTab.id)}
        cwd={sidePanelSession.gitContext?.worktreePath ?? sidePanelSession.workingDirectory}
        isDark={session.settings.isDark}
        file={editorFile}
        onClose={() => {
          editorFile = null;
        }}
      />
    {/await}
  {:else if diffPanelOpen && sidePanelTab && sidePanelSession && canShowDiffPanel}
    {#await import("@renderer/components/diff/DiffPanel.svelte")}
      {@render loadingSurface("Loading changes…")}
    {:then diffModule}
      {@const DiffPanel = diffModule.default}
      <DiffPanel
        tabId={sidePanelTab.id}
        projectPath={sidePanelSession.workingDirectory}
        worktreePath={sidePanelSession.gitContext?.worktreePath}
        worktreeBranch={sidePanelSession.gitContext?.branch ?? ""}
        targetBranch={sidePanelSession.gitContext?.targetBranch ?? "HEAD"}
        {isWorktree}
        onClose={() => {
          diffPanelOpen = false;
          diffPanelMaximized = false;
        }}
        maximized={effectiveDiffMaximized}
        onToggleMaximize={() => {
          diffPanelMaximized = !diffPanelMaximized;
        }}
        initialScope={diffScope}
      />
    {/await}
  {/if}
{/snippet}

{#if hasMountedMobile}
  <div class="w-full h-full" class:mode-hidden={!isMobile}>
    <WebMobileLayout
      {chatContent}
      {diffContent}
      {onAttachFile}
      overlayOpen={!!activePlan || !!activeWork}
      {diffPanelOpen}
      canShowDiffPanel={canShowSidePanel}
      changedFilesCount={changedFiles.length}
      onTogglePlans={() => {
        if (session.settingsOpen) session.closeSettings();
        togglePlans();
      }}
      onToggleDiff={() => {
        if (session.settingsOpen) session.closeSettings();
        toggleDiff();
      }}
    />
  </div>
{/if}

{#if hasMountedDesktop}
  <div class="w-full h-full" class:mode-hidden={isMobile}>
    <WebDesktopLayout {onAttachFile} />
  </div>
{/if}

<SessionPicker
  open={isMobile && session.sessionPickerOpen}
  onClose={() => { session.sessionPickerOpen = false; }}
/>

<style>
  .tab-hidden { display: none !important; }
  .mode-hidden { display: none !important; }
</style>
