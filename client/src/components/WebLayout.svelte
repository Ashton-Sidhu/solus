<script lang="ts">
  import ConversationView from "@renderer/components/conversation/ConversationView.svelte";
  import NewTabHome from "@renderer/components/layout/NewTabHome.svelte";
  import SessionPicker from "@renderer/components/session/SessionPicker.svelte";
  import PlanModal from "@renderer/components/plan/PlanModal.svelte";
  import DocumentModal from "@renderer/components/document-modal/DocumentModal.svelte";
  import PlanGallery from "@renderer/components/plan/PlanGallery.svelte";
  import FolioGallery from "@renderer/components/artifact/FolioGallery.svelte";
  import DiffPanel from "@renderer/components/diff/DiffPanel.svelte";
  import FileEditorPane from "@renderer/components/files/FileEditorPane.svelte";
  import SettingsPage from "@renderer/components/settings/SettingsPage.svelte";
  import { getPlanStore } from "@renderer/contexts/plan.store.svelte";
  import { getWorkspaceContext } from "@renderer/contexts/workspace.context.svelte";
  import { runtime } from "@renderer/contexts/runtime.svelte";
  import WebConnectionOverlay from "./WebConnectionOverlay.svelte";
  import WebMobileLayout from "./WebMobileLayout.svelte";
  import WebDesktopLayout from "./WebDesktopLayout.svelte";
  import { router } from "../lib/router.svelte";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
  import {
    FILE_PREVIEW_EVENT,
    type FilePreviewRequest,
  } from "@renderer/lib/filePreview";
  import type { DiffScope } from "@shared/types";

  interface Props {
    onAttachFile: () => void;
  }
  let { onAttachFile }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const av = session.artifactViewer;

  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const changedFiles = $derived(sess?.changedFiles ?? []);
  const isWorktree = $derived(!!sess?.gitContext?.worktreePath);
  const canShowDiffPanel = $derived(!!sess?.workingDirectory);
  const activePlan = $derived.by(() => {
    const planId = session.artifactViewer.activePlanId;
    if (planId) return planStore.get(planId) ?? null;
    return planStore.previewPlan;
  });
  const activeWork = $derived.by(() => {
    const workId = session.artifactViewer.activeWorkId;
    return workId ? session.worksStore.get(workId) ?? null : null;
  });

  const isMobile = $derived(runtime.isMobileViewport);

  // ── Mobile-only diff state ──
  // The desktop layout reads the shared `artifactViewer` (av) for its diff /
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

  let prevActiveTabId: string | undefined;
  $effect(() => {
    const current = session.activeTabId;
    if (prevActiveTabId !== undefined && prevActiveTabId !== current) {
      if (isMobile) {
        diffPanelOpen = false;
        diffPanelMaximized = false;
        editorFile = null;
      } else if (av.secondary.kind === "diff") {
        av.closeSecondary();
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
      const scope = (e as CustomEvent<{ scope?: DiffScope }>).detail?.scope ?? { kind: "session" };
      if (!isMobile) {
        av.toggleDiff(canShowDiffPanel, scope);
        return;
      }
      // Mobile bespoke toggle.
      if (editorFile) {
        editorFile = null;
        if (scope.kind === "session") {
          diffPanelOpen = false;
          diffPanelMaximized = false;
          return;
        }
        if (canShowDiffPanel) {
          diffScope = scope;
          diffPanelOpen = true;
        }
        return;
      }
      if (canShowDiffPanel) {
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
      if (detail.tabId && detail.tabId !== session.activeTabId) return;
      session.settingsOpen = false;
      session.plansGalleryOpen = false;
      if (!isMobile) {
        av.openFilePreview(detail);
        return;
      }
      editorFile = detail;
      diffScope = { kind: "session" };
      diffPanelOpen = false;
    };
    window.addEventListener(FILE_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(FILE_PREVIEW_EVENT, handler);
  });

  $effect(() => {
    if (router.current.name === "settings") {
      const tab = router.current.tab as "general" | "connections" | "tools" | undefined;
      session.showSettings(tab ?? "general");
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
    if (canShowDiffPanel) {
      editorFile = null;
      diffScope = { kind: "session" };
      diffPanelOpen = !diffPanelOpen;
      if (!diffPanelOpen) diffPanelMaximized = false;
    }
  }
</script>

{#snippet chatContent()}
  {#if session.settingsOpen}
    <SettingsPage />
  {:else}
    <PlanGallery />
    <FolioGallery />
    {#if !session.plansGalleryOpen && !session.folioGalleryOpen}
      {#if activeWork}
        <DocumentModal
          document={{ title: activeWork.title, content: activeWork.content }}
          onSave={async (content) => {
            await session.worksStore.save(activeWork.id, { content });
          }}
          onClose={() => session.closeWorkModal()}
          inline
        />
      {:else if activePlan}
        <PlanModal plan={activePlan} inline />
      {:else}
        <div class="flex min-h-0 flex-1 flex-col">
          {#if session.tabOrder.length === 0 && !session.plansGalleryOpen}
            <NewTabHome />
          {/if}
          {#each session.tabOrder as tId (tId)}
            <div
              class="flex h-full min-h-0 flex-col [contain-intrinsic-size:auto_62.5rem] [content-visibility:auto]"
              class:tab-hidden={tId !== session.activeTabId}
            >
              <ConversationView
                tabId={tId}
                onDiffToggle={() => {
                  if (!canShowDiffPanel) return;
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
  {#if editorFile && tab && sess}
    <FileEditorPane
      ctx={session.ctxFor(tab.id)}
      cwd={sess.gitContext?.worktreePath ?? sess.workingDirectory}
      isDark={session.settings.isDark}
      file={editorFile}
      onClose={() => {
        editorFile = null;
      }}
    />
  {:else if diffPanelOpen && tab && sess && canShowDiffPanel}
    <DiffPanel
      tabId={tab.id}
      projectPath={sess.workingDirectory}
      worktreePath={sess.gitContext?.worktreePath}
      worktreeBranch={sess.gitContext?.branch ?? ""}
      targetBranch={sess.gitContext?.targetBranch ?? "HEAD"}
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

<WebConnectionOverlay />

<style>
  .tab-hidden { display: none !important; }
  .mode-hidden { display: none !important; }
</style>
