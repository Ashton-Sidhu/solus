<script lang="ts">
  import { untrack } from "svelte";
  import type { FileDiffMetadata } from "@pierre/diffs";
  import type { PrGuideStatus } from "@solus/contracts/review";
  import type { DiffComment, DiffScope } from "@solus/contracts/types";
  import {
    getAgentContext,
    getSessionEnvironmentStore,
    getSettingsContext,
    getWorkspaceContext,
  } from "../../contexts";
  import type { ReviewView } from "../../contexts/workspace/routing/route-registry";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { toasts } from "../../lib/toasts";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import DiffPanel from "../diff/DiffPanel.svelte";
  import DiffHeatMap from "../diff/DiffHeatMap.svelte";
  import GuideSurface from "./GuideSurface.svelte";
  import ReviewViewTabs from "./ReviewViewTabs.svelte";
  import { GuideLoader } from "./lib/guide-loader.svelte";
  import {
    branchGuideIdentity,
    reviewGuideStore,
    sessionGuideIdentity,
  } from "./review-guide.store.svelte";
  import { guideEmptyHint, saveGuideComment } from "./lib/review-comments";
  import ReviewLoadingSurface from "./ReviewLoadingSurface.svelte";

  /**
   * The review pane: one surface for reading a local change, with the map, the
   * guide, and the diff as three views of the *same* change. It replaced a diff
   * panel and a separate guide destination that were two windows onto one
   * thing, and it is deliberately the shape of the pull-request review pane.
   *
   * `DiffPanel` stays the engine — it owns the patch, the file tree, the
   * stream, and the one footer every view sends from. This surface owns which
   * view is showing, the map drawn from the panel's own files, and the guide.
   *
   * Props rather than route params, because the surface has two homes: the
   * `review` route on desktop and web, and the mobile client's full-screen
   * sheet, which toggles a panel instead of navigating a pane.
   */
  let {
    sourceTabId,
    view,
    onSelectView,
    scope,
    filePath,
    navigationRequestId,
    onClose,
    onToggleMaximize = null,
    maximized = false,
    initialSkeletonVisible = false,
    bordered = false,
  }: {
    sourceTabId: string;
    view: ReviewView;
    onSelectView: (view: ReviewView) => void;
    /** Which change to read. Absent is the branch review, whose base this
     *  surface resolves live. */
    scope?: DiffScope;
    filePath?: string;
    /** Bumped by the host to replay a file jump the surface may not have been
     *  mounted for yet. */
    navigationRequestId?: number;
    onClose: () => void;
    /** Pane maximize, drawn as the band's full-screen control. Absent where the
     *  surface has no pane of its own (the web client's full-height sheet). */
    onToggleMaximize?: (() => void) | null;
    maximized?: boolean;
    /** True when the route boundary already painted the same skeleton. */
    initialSkeletonVisible?: boolean;
    /** Whether this surface needs a seam against content in another pane. The
     *  band replaced that rule with space, so it is off by default. */
    bordered?: boolean;
  } = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();

  const sourceSession = $derived(session.sessionFor(sourceTabId));
  const environment = $derived(environmentStore.environmentFor(sourceSession?.run));
  const getCtx = () =>
    session.ctxForEnvironment(environment.cwd, environment.checkout, sourceTabId);
  const getApi = () => session.apiFor(sourceTabId);

  function selectView(next: ReviewView) {
    if (next !== view) onSelectView(next);
  }

  // An absent scope is the branch review: the whole branch against its target.
  // Its base is live Git state rather than something a link may pin, so it is
  // resolved here instead of being carried in the route.
  let branchScope = $state<DiffScope | null>(null);
  let branchScopeError = $state<string | null>(null);
  $effect(() => {
    if (scope || !environment.repoRoot) return;
    const api = getApi();
    const ctx = getCtx();
    let current = true;
    void api
      .getReviewContext(ctx)
      .then((reviewCtx) => {
        if (!current) return;
        branchScope = reviewCtx?.baseSha
          ? { kind: "pr", baseSha: reviewCtx.baseSha }
          : { kind: "working-tree" };
      })
      .catch((error) => {
        if (!current) return;
        branchScopeError = error instanceof Error ? error.message : String(error);
      });
    return () => {
      current = false;
    };
  });

  const diffScope = $derived<DiffScope | null>(scope ?? branchScope);
  /** A session review reads the session's own changes; every other scope — the
   *  branch, a turn, the working tree — reads the branch guide. */
  const guideScope = $derived<"branch" | "session">(
    scope?.kind === "session" ? "session" : "branch",
  );

  // ── The guide ─────────────────────────────────────────────────────────────
  const guideIdentity = $derived(
    guideScope === "session"
      ? sessionGuideIdentity(sourceSession)
      : branchGuideIdentity(environment),
  );
  const guideKey = $derived(guideIdentity?.key ?? "");

  const loader = new GuideLoader({
    getApi,
    getCtx,
    getKey: () => guideKey,
    getScope: () => guideScope,
    getAgent: () => resolveReviewAgent(settings, agentContext),
  });

  // Generation is durable and shared: it outlives this pane, so the tab's state
  // and the progress screen both come off the store rather than the loader's
  // own in-flight call.
  const guideStatus = $derived(reviewGuideStore.statusFor(getApi(), guideIdentity));
  const generating = $derived(
    guideStatus?.status === "queued" || guideStatus?.status === "generating",
  );
  // The guide surface speaks the pull-request vocabulary, which has no
  // `cancelled`: a cancelled generation is simply one that is no longer running.
  const generationStatus = $derived<PrGuideStatus | undefined>(
    guideStatus?.status === "cancelled" ? undefined : guideStatus?.status,
  );
  $effect(() => {
    if (!guideIdentity) return;
    void reviewGuideStore.load(getApi(), getCtx(), guideIdentity, guideScope);
  });
  $effect(() => loader.trackProgress());

  // Read the cached guide, but never generate on open: guides are opt-in, and
  // the empty state is a real offer rather than an error.
  $effect(() => {
    void guideKey;
    if (!guideKey) return;
    void untrack(() => loader.load(false, false));
  });

  // A generation that finished — here or in the Git panel — while this pane sat
  // on the empty state. Remembering the transition keeps a stale ready status
  // from reloading forever.
  let handledReadyAt = 0;
  $effect(() => {
    const status = guideStatus;
    if (status?.status !== "ready" || status.updatedAt === handledReadyAt) return;
    if (loader.loading) return;
    handledReadyAt = status.updatedAt;
    void loader.load(false, false);
  });

  async function generateGuide() {
    const identity = guideIdentity;
    if (!identity || generating) return;
    try {
      await reviewGuideStore.generate(getApi(), getCtx(), identity, {
        ...resolveReviewAgent(settings, agentContext),
        scope: guideScope,
      });
    } catch (error) {
      toasts.error("Couldn't generate the review guide", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Opening the Guide view clears its Ready cue. The cue means "you have not
  // read this one", not merely "one exists".
  $effect(() => {
    if (view !== "guide" || !guideIdentity) return;
    reviewGuideStore.markOpened(getApi(), guideIdentity);
  });

  const guideUnread = $derived(
    reviewGuideStore.indicatorStatusFor(getApi(), guideIdentity)?.status === "ready",
  );
  // Whether the cached guide still describes HEAD is state about this change,
  // so it rides in the panel's header with the rest of it rather than as a chip
  // inside the narrative it qualifies.
  const guideHeaderActions = $derived({
    present: !!loader.guide,
    stale: loader.stale,
    regenerating: loader.loading || generating,
    onRegenerate: () => loader.refresh(),
  });

  const guideState = $derived<"absent" | "generating" | "unread" | "ready">(
    generating
      ? "generating"
      : guideUnread
        ? "unread"
        : loader.guide
          ? "ready"
          : "absent",
  );

  // ── Comments ──────────────────────────────────────────────────────────────
  // The guide writes into the same list the diff stream writes to, so one
  // comment set feeds the file tree's counts, the comments popover, and the one
  // send at the bottom of the pane.
  const commentStore = {
    get comments(): DiffComment[] {
      return sourceSession?.diffComments ?? [];
    },
    add: (comment: DiffComment) => session.addDiffComment(comment, sourceTabId),
    update: (id: string, text: string) =>
      session.updateDiffComment(id, text, sourceTabId),
    remove: (id: string) => session.removeDiffComment(id, sourceTabId),
  };

  // ── The panel ─────────────────────────────────────────────────────────────
  let diffPanelRef: DiffPanel | null = $state(null);

  async function loadRepoFilesForMap(repoRoot: string): Promise<readonly string[] | null> {
    const result = await getApi().listProjectFiles(getCtx(), { cwd: repoRoot });
    return result.ok ? result.files : null;
  }

  // Switching views is this surface's, not the panel's — the panel pushes the
  // `diff-panel` scope these ride in, and it stays mounted behind Map and Guide
  // (they are snippets it renders), so the scope is live on every view.
  useKeybinding("review-pane.next-view", () => cycleView(1));
  useKeybinding("review-pane.prev-view", () => cycleView(-1));

  const VIEW_ORDER: ReviewView[] = ["map", "guide", "diff"];
  function cycleView(direction: 1 | -1) {
    const index = VIEW_ORDER.indexOf(view);
    const next = (index + direction + VIEW_ORDER.length) % VIEW_ORDER.length;
    selectView(VIEW_ORDER[next]);
  }
</script>

{#snippet viewTabs()}
  <ReviewViewTabs {view} {guideState} onSelect={selectView} />
{/snippet}

{#snippet mapView(files: FileDiffMetadata[])}
  <DiffHeatMap
    {files}
    onOpenFile={(path) => diffPanelRef?.openFileFromMap(path)}
    repoRoot={environment.worktreePath ?? environment.repoRoot ?? environment.cwd}
    loadRepoFiles={loadRepoFilesForMap}
  />
{/snippet}

{#snippet guideView(files: FileDiffMetadata[])}
  <GuideSurface
    {loader}
    comments={commentStore.comments}
    onCommentSave={(comment) => saveGuideComment(commentStore, comment)}
    onCommentDelete={(id) => commentStore.remove(id)}
    onFileJump={(path) => {
      selectView("diff");
      diffPanelRef?.navigateTo(path);
    }}
    emptyHint={guideEmptyHint(files.length)}
    generationStatus={generationStatus}
    onGenerate={generateGuide}
  />
{/snippet}

{#if branchScopeError}
  <div class="flex h-full min-h-0 flex-col">
    <div class="workspace-titlebar h-(--solus-chrome-row-h,2.5rem) shrink-0" aria-hidden="true"></div>
    <div
      class="grid min-h-0 flex-1 place-items-center px-6 text-center text-xs text-destructive"
      role="alert"
    >
      {branchScopeError}
    </div>
  </div>
{:else if diffScope}
  <DiffPanel
    bind:this={diffPanelRef}
    tabId={sourceTabId}
    {getCtx}
    {getApi}
    projectPath={sourceSession?.run.workingDirectory ?? environment.cwd}
    worktreePath={sourceSession?.run.gitContext?.worktreePath ??
      environment.worktreePath ??
      environment.cwd}
    worktreeBranch={sourceSession?.run.gitContext?.branch ??
      session.globalDefaults.gitContext?.branch ??
      ""}
    targetBranch={sourceSession?.run.gitContext?.targetBranch ??
      session.globalDefaults.gitContext?.targetBranch ??
      "HEAD"}
    isWorktree={environment.isolated || !!session.globalDefaults.gitContext?.worktreePath}
    {onClose}
    initialScope={diffScope}
    initialFilePath={filePath}
    {navigationRequestId}
    bind:view={() => view, selectView}
    {viewTabs}
    {mapView}
    {guideView}
    {bordered}
    {onToggleMaximize}
    {maximized}
    guide={guideHeaderActions}
    {initialSkeletonVisible}
  />
{:else}
  <!-- Resolving the branch's base, before the panel that owns the patch exists.
       The chrome row still draws, so the seam between this pane and the one
       beside it doesn't break in half while the base is on its way, and the body
       wears the shape of the view being opened — which is the same skeleton the
       panel then shows for its own load, so the wait reads as one. -->
  <!-- Only Map and Diff draw a body skeleton. ReviewLoadingSurface still keeps
       the toolbar and background stable for a restored Guide location. -->
  <ReviewLoadingSurface {view} />
{/if}
