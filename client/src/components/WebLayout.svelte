<script lang="ts">
  import ConversationView from "@renderer/components/conversation/ConversationView.svelte";
  import SessionBreadcrumb from "@renderer/components/conversation/SessionBreadcrumb.svelte";
  import SessionPicker from "@renderer/components/session/SessionPicker.svelte";
  import TaskPicker from "@renderer/components/session/TaskPicker.svelte";
  // Eager, unlike the lazy surfaces below: it is what covers an async boundary,
  // so it cannot sit behind one itself.
  import DocumentModalSkeleton from "@renderer/components/document-modal/DocumentModalSkeleton.svelte";
  import { getPlanStore, getWorkspaceContext, runtime } from "@renderer/contexts";
  import WebMobileLayout from "./WebMobileLayout.svelte";
  import WebDesktopLayout from "./WebDesktopLayout.svelte";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
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
  const router = session.router;

  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const changedFiles = $derived(sess?.changedFiles ?? []);
  let sidePanelSourceTabId = $state(session.activeTabId);
  const sidePanelTab = $derived(session.tabs[sidePanelSourceTabId]);
  const sidePanelSession = $derived(session.sessionFor(sidePanelSourceTabId));
  const isWorktree = $derived(!!sidePanelSession?.run.gitContext?.worktreePath);
  const canShowDiffPanel = $derived(!!sidePanelSession?.run.workingDirectory);
  const activePlan = $derived.by(() => {
    const planId = router.params("plan")?.planId;
    if (planId) return planStore.get(planId) ?? null;
    return router.at("plan") ? planStore.previewPlan : null;
  });
  const activeWork = $derived.by(() => {
    const workId = router.params("work")?.workId;
    return workId ? session.worksStore.get(workId) ?? null : null;
  });

  const isMobile = $derived(runtime.isMobileViewport);

  // The global connection banner is retired (dispatch-client step 3): the
  // client is host-agnostic, so an outage belongs to one host's row and the
  // per-host status chip, never to a client-global toast — and "Retry now"
  // dials that host's supervisor instead of reloading the whole window.

  // ── Mobile-only diff state ──
  // The desktop layout reads the shared location for its diff / plan / work
  // panes. Mobile keeps its own lightweight state because it renders a single
  // full-screen diff via the snippets below, not the split-pane system.
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
  // Settings, Folio and the work shell are routes now: each navigation pushes a
  // real history entry, so browser/OS back walks them without a sentinel. Only
  // the mobile-bespoke diff, which is local state rather than a location, still
  // needs the back-stack.
  registerBackOverlay("diff-panel", () => isMobile && diffPanelOpen, closeDiffPanel);

  let hasMountedMobile = $state(runtime.isMobileViewport);
  let hasMountedDesktop = $state(!runtime.isMobileViewport);
  $effect(() => {
    if (isMobile) hasMountedMobile = true;
    else hasMountedDesktop = true;
  });

  // The workspace page retains filters and scroll state between opens. Keep the
  // tree alive after first use without loading the module on a chat-only launch.
  let hasMountedWorkspace = $state(false);
  $effect(() => {
    if (router.at("folio")) hasMountedWorkspace = true;
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
      } else if (router.overlay?.name === "diff") {
        router.closeOverlay();
      }
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
      const detail = e instanceof CustomEvent ? e.detail : undefined;
      const sourceTabId =
        detail?.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      const canShowSourceDiff = !!session.sessionFor(sourceTabId)?.run.workingDirectory;
      const scope = detail?.scope ?? { kind: "session" };
      if (!isMobile) {
        session.toggleDiff(sourceTabId, scope);
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
      const detail = e instanceof CustomEvent ? e.detail : undefined;
      if (!detail?.path) return;
      const sourceTabId =
        detail.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      if (!isMobile) {
        session.openFilePreview(detail, sourceTabId);
        return;
      }
      router.closeGroup("page");
      sidePanelSourceTabId = sourceTabId;
      editorFile = detail;
      diffScope = { kind: "session" };
      diffPanelOpen = false;
    };
    window.addEventListener(FILE_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(FILE_PREVIEW_EVENT, handler);
  });

  // The address bar is written inside `navigate`, never derived — which is what
  // retired the pair of bidirectional sync effects that used to live here (and
  // the `effect_update_depth_exceeded` they produced).
  function toggleWorkspace() {
    session.toggleFolio();
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
    if (session.sessionFor(sourceTabId)?.run.workingDirectory) {
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
  {#if router.at("settings")}
    {#await import("@renderer/components/settings/SettingsPage.svelte")}
      {@render loadingSurface("Loading settings…")}
    {:then settingsModule}
      {@const SettingsPage = settingsModule.default}
      <div class="mobile-surface flex min-h-0 flex-1 flex-col">
        <SettingsPage />
      </div>
    {/await}
  {:else}
    {#if hasMountedWorkspace}
      {#await import("@renderer/components/workspace/WorkspacePage.svelte")}
        {@render loadingSurface("Loading workspace…")}
      {:then workspaceModule}
        {@const WorkspacePage = workspaceModule.default}
        <!-- The page stays mounted and gates itself on open; the wrapper
             collapses to display:none so it never splits the flex column, and
             re-adding the class replays the entrance on every open. -->
        <div class="min-h-0 flex-col {router.at("folio") ? 'mobile-surface flex flex-1' : 'hidden'}">
          <WorkspacePage />
        </div>
      {/await}
    {/if}
    {#if !router.at("folio")}
      {#if activeWork}
        {#await import("@renderer/components/document-modal/DocumentModal.svelte")}
          <!-- No workId on mobile, so no comment margin to reserve. -->
          <div class="mobile-surface flex min-h-0 flex-1 flex-col">
            <DocumentModalSkeleton inline title={activeWork.title} railWidth="0px" />
          </div>
        {:then documentModule}
          {@const DocumentModal = documentModule.default}
          <div class="mobile-surface flex min-h-0 flex-1 flex-col">
            <DocumentModal
              document={{ title: activeWork.title, content: activeWork.content }}
              onSave={async (content) => {
                await session.worksStore.save(activeWork.id, { content });
              }}
              onClose={() => session.closeWorkModal()}
              inline
            />
          </div>
        {/await}
      {:else if activePlan}
        {#await import("@renderer/components/plan/PlanModal.svelte")}
          {@render loadingSurface("Loading plan…")}
        {:then planModalModule}
          {@const PlanModal = planModalModule.default}
          <div class="mobile-surface flex min-h-0 flex-1 flex-col">
            <PlanModal plan={activePlan} inline />
          </div>
        {/await}
      {:else}
        <!-- The band belongs to the pane, not to the transcript: the desktop
             body draws it over its leading column, and this is that column. -->
        <div class="relative flex min-h-0 flex-1 flex-col">
          {#if session.activeTabId}
            <SessionBreadcrumb tabId={session.activeTabId} />
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
                  if (!session.sessionFor(tId)?.run.workingDirectory) return;
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
        cwd={sidePanelSession.run.gitContext?.worktreePath ?? sidePanelSession.run.workingDirectory}
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
        projectPath={sidePanelSession.run.workingDirectory}
        worktreePath={sidePanelSession.run.gitContext?.worktreePath}
        worktreeBranch={sidePanelSession.run.gitContext?.branch ?? ""}
        targetBranch={sidePanelSession.run.gitContext?.targetBranch ?? "HEAD"}
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
      onToggleWorkspace={() => {
        if (router.at("settings")) session.closeSettings();
        toggleWorkspace();
      }}
      onToggleDiff={() => {
        if (router.at("settings")) session.closeSettings();
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
<TaskPicker
  open={isMobile && session.taskPickerOpen}
  onClose={() => { session.taskPickerOpen = false; }}
/>

<style>
  .tab-hidden { display: none !important; }
  .mode-hidden { display: none !important; }

  /* chatContent is rendered only by the mobile shell, so this entrance is a
     phone-only affordance: surfaces slide up like an iOS sheet, not a cut. */
  .mobile-surface {
    animation: mobile-surface-in 0.28s cubic-bezier(0.32, 0.72, 0, 1);
  }

  @keyframes mobile-surface-in {
    from {
      opacity: 0;
      transform: translateY(1.5rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .mobile-surface {
      animation: none;
    }
  }
</style>
