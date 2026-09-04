<script lang="ts">
  import ConversationView from "@solus/workspace-ui/components/conversation/ConversationView.svelte";
  import SessionBreadcrumb from "@solus/workspace-ui/components/conversation/SessionBreadcrumb.svelte";
  import SessionDraftPane from "@solus/workspace-ui/components/session-draft/SessionDraftPane.svelte";
  import UnifiedPicker from "@solus/workspace-ui/components/session/unified-picker/UnifiedPicker.svelte";
  import DiffLoadingSkeleton from "@solus/workspace-ui/components/diff/DiffLoadingSkeleton.svelte";
  import { getPlanStore, getWorkspaceContext, runtime } from "@solus/workspace-ui/contexts";
import { visibleRef } from "@solus/workspace-ui/contexts/workspace/routing/location";
import {
  ROUTES,
  isPageRoute,
} from "@solus/workspace-ui/contexts/workspace/routing/route-registry";
  import MobileComposerActions from "./MobileComposerActions.svelte";
  import WebMobileLayout from "./WebMobileLayout.svelte";
  import WebDesktopLayout from "./WebDesktopLayout.svelte";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
  import { webState } from "../lib/web-state.svelte";
  import {
    FILE_PREVIEW_EVENT,
    type FilePreviewRequest,
  } from "@solus/workspace-ui/lib/filePreview";
  import type { DiffScope } from "@solus/contracts/types";
  import type { ReviewView } from "@solus/workspace-ui/contexts/workspace/routing/route-registry";

  interface Props {
    onAttachFile: (tabId?: string) => void | Promise<void>;
    onAttachFiles: (files: File[], sourceId?: string) => void | Promise<void>;
  }
  let { onAttachFile, onAttachFiles }: Props = $props();

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
  // Mobile renders one pane at a time, but the work still belongs to a real
  // route pane. Keep its id with the params so the shared WorkPane gets the
  // same close and navigation semantics it has on desktop.
  const activeWorkRoute = $derived.by(() => {
    for (const pane of router.panes) {
      const ref = visibleRef(pane);
      if (ref?.name === "work") return { paneId: pane.id, params: ref.params };
    }
    return null;
  });
  const activeWork = $derived(
    activeWorkRoute
      ? session.worksStore.get(activeWorkRoute.params.workId) ?? null
      : null,
  );
  let mobileWorkLoadAttempt = $state(0);
  const leadingDraftParams = $derived(
    router.leadingPane.base?.name === "draft"
      ? router.leadingPane.base.params
      : null,
  );

  // ── Page routes on a phone ──
  // The shell renders one pane, so whichever page route the leading pane holds
  // takes the content area. Read from the registry rather than a list of route
  // names here: the drawer's section row navigates to Tasks, Pull requests and
  // Workspace, and a shell that enumerated its own subset would answer a
  // navigation with a blank screen for anything it had not been told about.
  //
  // Folio is excluded because it is mounted once and hidden below, so its
  // filters and scroll position survive being closed.
  const leadingRef = $derived(visibleRef(router.leadingPane));
  const activePageRef = $derived(
    isPageRoute(leadingRef) && leadingRef && leadingRef.name !== "folio"
      ? leadingRef
      : null,
  );
  const activePageComponent = $derived(
    activePageRef ? ROUTES[activePageRef.name].component : undefined,
  );

  const isMobile = $derived(runtime.isMobileViewport);
  /** Which pane the browser route landed in. The pane still exists in the
   *  location on mobile — only nothing renders it there — and the surface needs
   *  its id for the pane controls it inherits. */
  const browserPaneId = $derived(
    router.panes.find((pane) => pane.base?.name === "browser")?.id ?? null,
  );

  // The global connection banner is retired (dispatch-client step 3): the
  // client is host-agnostic, so an outage belongs to one host's row and the
  // per-host status chip, never to a client-global toast — and "Retry now"
  // dials that host's supervisor instead of reloading the whole window.

  // ── Mobile-only review state ──
  // The desktop layout reads the shared location for its review / plan / work
  // panes. Mobile keeps its own lightweight state because it renders a single
  // full-screen review via the snippets below, not the split-pane system.
  let diffPanelOpen = $state(false);
  let diffPanelMaximized = $state(false);
  let diffScope = $state<DiffScope>({ kind: "session" });
  // Which of Map · Guide · Diff the mobile review is on. The desktop route
  // carries this; mobile has no location to put it in.
  let reviewView = $state<ReviewView>("map");
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
      } else if (router.overlay?.name === "review") {
        router.closeOverlay();
      }
    }
    prevActiveTabId = current;
  });

  $effect(() => {
    const handler = () => {
      session.unifiedPickerOpen = !session.unifiedPickerOpen;
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

{#snippet draftComposerActions()}
  <!-- A draft on a phone gets the phone's controls, not the desktop editor
       toolbar: the same `+` and model pair the started-session dock renders,
       addressed by the draft so the sheet edits the run about to start. -->
  <MobileComposerActions sourceId={leadingDraftParams?.draftId} />
{/snippet}

{#snippet chatContent()}
  <!-- Browser is an `aside` route, and the mobile shell renders no companion
       pane — so on a phone the pane takes the content area instead, the way the
       diff and the workspace do. Without this branch the command opens a pane
       nothing renders, which is why it used to be hidden here. The surface
       inside is the streamed canvas: a phone cannot host a `<webview>`, and the
       page is rendered on the host either way. -->
  {#if router.at("browser") && browserPaneId}
    {#await import("@solus/workspace-ui/components/browser/BrowserPane.svelte")}
      {@render loadingSurface("Loading browser…")}
    {:then browserModule}
      {@const BrowserPane = browserModule.default}
      <div class="mobile-surface flex min-h-0 flex-1 flex-col">
        <BrowserPane
          params={router.params("browser") ?? {}}
          paneId={browserPaneId}
        />
      </div>
    {/await}
  {:else if activePageRef && activePageComponent}
    <!-- Tasks, the task detail, Pull requests, the PR review, Automations,
         Insights and Settings all arrive here. The surfaces are the desktop
         ones; what makes them a phone page is the `pane` container declared on
         the wrapper, which is how each learns it has 393px to spend. -->
    {#await activePageComponent()}
      {@render loadingSurface("Loading page…")}
    {:then pageModule}
      {@const PageSurface = pageModule.default}
      <div class="mobile-surface mobile-page-pane flex min-h-0 flex-1 flex-col">
        <PageSurface params={activePageRef.params} paneId={router.leadingPane.id} />
      </div>
    {/await}
  {:else}
    {#if hasMountedWorkspace}
      {#await import("@solus/workspace-ui/components/workspace/WorkspacePage.svelte")}
        {@render loadingSurface("Loading workspace…")}
      {:then workspaceModule}
        {@const WorkspacePage = workspaceModule.default}
        <!-- The page stays mounted and gates itself on open; the wrapper
             collapses to display:none so it never splits the flex column, and
             re-adding the class replays the entrance on every open. -->
        <div class="mobile-page-pane min-h-0 flex-col {router.at("folio") ? 'mobile-surface flex flex-1' : 'hidden'}">
          <WorkspacePage />
        </div>
      {/await}
    {/if}
    {#if !router.at("folio")}
      {#if activeWorkRoute}
        <!-- The route surface owns work-type dispatch. Mobile must not send a
             diagram or artifact through the document editor merely because it
             has one visible pane. This also keeps live refresh, history,
             export, and delete behavior identical across clients. -->
        {#key `${activeWorkRoute.params.workId}-${mobileWorkLoadAttempt}`}
        {#await import("@solus/workspace-ui/components/work/WorkPane.svelte")}
          <div class="mobile-surface flex min-h-0 flex-1 flex-col">
            {@render loadingSurface(`Loading ${activeWork?.type ?? "work"}…`)}
          </div>
        {:then workModule}
          {@const WorkPane = workModule.default}
          <div class="mobile-surface mobile-page-pane mobile-work-surface flex min-h-0 flex-1 flex-col">
            <WorkPane
              params={activeWorkRoute.params}
              paneId={activeWorkRoute.paneId}
            />
          </div>
        {:catch error}
          <div class="mobile-surface mobile-page-pane mobile-work-surface flex min-h-0 flex-1 flex-col">
            <div class="grid min-h-0 flex-1 place-items-center gap-3 p-6 text-center">
              <div>
                <p class="text-sm font-medium text-(--solus-text-primary)">Couldn’t load this work.</p>
                <p class="mt-1 text-xs text-(--solus-text-tertiary)">
                  {error instanceof Error ? error.message : String(error)}
                </p>
              </div>
              <button
                type="button"
                class="min-h-10 rounded-lg border border-(--solus-container-border) px-3.5 text-sm font-medium text-(--solus-text-secondary)"
                onclick={() => (mobileWorkLoadAttempt += 1)}
              >
                Try again
              </button>
            </div>
          </div>
        {/await}
        {/key}
      {:else if activePlan}
        {#await import("@solus/workspace-ui/components/plan/PlanModal.svelte")}
          {@render loadingSurface("Loading plan…")}
        {:then planModalModule}
          {@const PlanModal = planModalModule.default}
          <div class="mobile-surface flex min-h-0 flex-1 flex-col">
            <PlanModal plan={activePlan} inline />
          </div>
        {/await}
      {:else}
        {#if leadingDraftParams}
          <!-- Static: `ui/Pane` already imports the draft pane into the main
               chunk, so a lazy load here only bought a needless loading flash. -->
          <SessionDraftPane
            params={leadingDraftParams}
            paneId={router.leadingPane.id}
            composerActions={isMobile ? draftComposerActions : undefined}
          />
        {:else}
          <!-- The band belongs to the pane, not to the transcript: the desktop
               body draws it over its leading column, and this is that column.
               A phone has no room for it: the mobile navbar already states
               project / task / state in one opaque 56px band, and a second
               copy under it truncates all three. -->
          <div class="relative flex min-h-0 flex-1 flex-col">
            {#if session.activeTabId && !isMobile}
              <SessionBreadcrumb tabId={session.activeTabId} />
            {/if}
            {#each session.tabOrder as tId (tId)}
              <div
                class="tab-slot flex h-full min-h-0 flex-col [contain-intrinsic-size:auto_62.5rem] [content-visibility:auto]"
                class:tab-hidden={tId !== session.activeTabId}
              >
                <ConversationView
                  tabId={tId}
                  bandAbove={!isMobile}
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
  {/if}
{/snippet}

{#snippet diffContent()}
  {#if editorFile && sidePanelTab && sidePanelSession}
    {#await import("@solus/workspace-ui/components/files/FileEditorPane.svelte")}
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
    {#await import("@solus/workspace-ui/components/review/ReviewSurface.svelte")}
      <!-- The review surface opens onto the same skeleton it then shows while it
           resolves the change, so fetching the chunk and loading the diff read as
           one wait rather than a label that swaps into a different placeholder. -->
      <div class="flex h-full min-h-0 flex-col" role="status" aria-label="Loading changes">
        <div class="workspace-titlebar h-(--solus-chrome-row-h,2.5rem) shrink-0" aria-hidden="true"></div>
        <!-- Matched to the view being opened, and skipped for the guide, which
             reads none of what this chunk is fetching the panel for. -->
        {#if reviewView !== "guide"}
          <DiffLoadingSkeleton variant={reviewView === "map" ? "map" : "diff"} />
        {/if}
      </div>
    {:then reviewModule}
      {@const ReviewSurface = reviewModule.default}
      <ReviewSurface
        sourceTabId={sidePanelTab.id}
        view={reviewView}
        onSelectView={(next) => (reviewView = next)}
        scope={diffScope}
        onClose={() => {
          diffPanelOpen = false;
          diffPanelMaximized = false;
        }}
      />
    {/await}
  {/if}
{/snippet}

{#if hasMountedMobile}
  <div class="w-full h-full" class:mode-hidden={!isMobile}>
    <WebMobileLayout
      {chatContent}
      {diffContent}
      {onAttachFiles}
      overlayOpen={!!activePlan || !!activeWorkRoute}
      {diffPanelOpen}
      canShowDiffPanel={canShowSidePanel}
      changedFilesCount={changedFiles.length}
      onToggleWorkspace={() => {
        router.close("settings");
        toggleWorkspace();
      }}
      onToggleDiff={() => {
        router.close("settings");
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

<UnifiedPicker
  open={isMobile && session.unifiedPickerOpen}
  onClose={() => { session.unifiedPickerOpen = false; }}
/>

<style>
  .tab-hidden { display: none !important; }
  .mode-hidden { display: none !important; }

  /* The `pane` container, on the one pane a phone has. Every page surface below
     reads its width from here — the same named container `WorkspaceBody`
     declares on `.primary-column` — so a list learns it has 393px to spend from
     the box it is actually in rather than from the window. That is what makes
     the record rung on `ListRow` fire on a phone and in a desktop pane dragged
     to its floor, from one rule rather than two.

     `container-type` makes this the containing block for `position: fixed`
     descendants, which is safe here: the sheets and drawers that go fixed are
     rendered by the shell as siblings of this box, or portalled to the body. */
  .mobile-page-pane {
    container: pane / inline-size;
  }

  /* Work routes replace the phone navbar, so this surface owns the device
     cut-outs while it is open. The shared pane then lays out normally inside
     the safe rectangle on both portrait and landscape phones. */
  .mobile-work-surface {
    /* The shared PaneChrome keeps only Close on mobile. Reserve its 44px touch
       target plus the right inset so work-header actions cannot sit under it. */
    --solus-pane-chrome-inset: 4rem;
    padding-top: env(safe-area-inset-top, 0);
    padding-right: env(safe-area-inset-right, 0);
    padding-bottom: env(safe-area-inset-bottom, 0);
    padding-left: env(safe-area-inset-left, 0);
  }

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
