<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    GitPullRequest as GitPullRequestIcon,
    LoaderCircle as CircleNotchIcon,
  } from "@lucide/svelte";
  import { projectScopeOf, type IpcContext } from "@solus/contracts/types";
  import type {
    DraftReview,
    PrCommit,
    PullRequest,
    PrReviewTarget,
  } from "@solus/contracts/providers";
  import type { GuideDiffCommentSave } from "./guide/lib/guide-data";
  import {
    getPullRequestsContext,
    getWorkspaceContext,
    getSettingsContext,
    getAgentContext,
  } from "../../contexts";
  import { copyText, toasts } from "../../lib/toasts";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { HostApi } from "@solus/client-core/host-api";
  import type { PaneId } from "../../contexts/workspace/routing/location";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import { localApi } from "@solus/client-core/local-api";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import GuideSurface from "../review/GuideSurface.svelte";
  import { GuideLoader } from "../review/lib/guide-loader.svelte";
  import DiffPanel from "../diff/DiffPanel.svelte";
  import DiffHeatMap from "../diff/DiffHeatMap.svelte";
  import { parsePatchFiles } from "@pierre/diffs";
  import ActivityFeed from "./ActivityFeed.svelte";
  import type { PrActivityTarget } from "./lib/activity-data";
  import SubmitReviewModal from "./SubmitReviewModal.svelte";
  import SinceReviewBar from "./SinceReviewBar.svelte";
  import { prReviewState } from "./lib/pr-review.store.svelte";
  import PrDetailChrome from "./PrDetailChrome.svelte";
  import GithubConnectionRequired from "../prs/GithubConnectionRequired.svelte";
  import { prSurfaceError, type PrSurfaceError } from "../prs/lib/pr-surface-error";
  import PrDetailMasthead from "./PrDetailMasthead.svelte";
  import PrPanelHeader from "./PrPanelHeader.svelte";
  import PrPanelOverflowMenu from "./PrPanelOverflowMenu.svelte";
  import PrViewTabs from "./PrViewTabs.svelte";
  import { Button } from "../ui/button";
  import FrameExpandButton from "../layout/FrameExpandButton.svelte";
  import StackDiffBanner from "./StackDiffBanner.svelte";
  import {
    buildPrCheckFixPrompt,
    buildPrCommentsFixPrompt,
    buildPrQuestionDraft,
    type PrFixFeedback,
  } from "./lib/pr-input-drafts";

  // The review surface (M3–M5): Activity · Guide · Diff content tabs over a PR's
  // change, living maximized in the secondary pane. PR handoffs prepare the
  // worktree here, then open a session composer rooted in that checkout.
  //
  // The surface mounts the moment a PR is clicked, before its worktree has been
  // fetched and checked out: `pr` is null until then, and everything that reads
  // the checkout — the stack, the guide, the diff, the interdiff, PR handoffs — waits
  // for it. Activity does not: it is provider-backed, so it renders from
  // `target` against `targetCtx` and is usually filled from PrsStore's prefetch
  // by first paint. One mounted component across both phases is what keeps the
  // open to a single page filling in rather than a placeholder swap.
  let {
    pr,
    paneId,
    api,
    serverId,
    target,
    targetCtx = null,
    chatTabId = null,
    onToggleMaximize,
    maximized = false,
    activeTab,
    onActiveTabChange,
    headless = false,
    embedded = false,
    fullScreen = false,
    onToggleFullScreen,
    onMoveAcross,
    onExit,
    onStep,
    guideEnabled = true,
    onUnresolvedCountChange,
    onRefreshTarget,
  }: {
    pr: PrReviewTarget | null;
    /** Present when the review is mounted in the workspace pane router. */
    paneId?: PaneId;
    api: HostApi;
    serverId: string;
    /** PR identity, known from the click; `pr` once the worktree exists. */
    target: PrActivityTarget;
    /** Project context for provider reads and lazy checkout preparation. */
    targetCtx?: IpcContext | null;
    chatTabId?: string | null;
    onToggleMaximize?: () => void;
    maximized?: boolean;
    activeTab?: ContentTab;
    onActiveTabChange?: (tab: ContentTab) => void;
    headless?: boolean;
    /** Mounted as the detail panel of the pull requests page rather than as a
     *  route of its own. The list is still on screen beside it, so the way back
     *  and the way sideways are the page's, and the diff stays inside the panel
     *  instead of claiming the pane the list is sitting in. */
    embedded?: boolean;
    /** Embedded only: the panel is covering the list rather than sitting beside it. */
    fullScreen?: boolean;
    onToggleFullScreen?: () => void;
    /** Move the review between the leading pane and the companion beside it.
     *  Passed only by the route adapter: mounted as the pull requests page's
     *  own detail panel there is no pane of its own to move. `embedded` states
     *  which way the move goes. */
    onMoveAcross?: () => void;
    /** How Esc and the close control get out. Defaults to leaving the review route. */
    onExit?: () => void;
    /** How J / K walk the queue. Defaults to stepping the review route. */
    onStep?: (delta: number) => void;
    guideEnabled?: boolean;
    onUnresolvedCountChange?: (count: number) => void;
    onRefreshTarget?: () => Promise<void>;
  } = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const stacks = pullRequests.stacks;

  let activeChatTabId = $state<string | null>(null);
  let preparingComposer = $state(false);
  $effect(() => {
    activeChatTabId = chatTabId;
  });
  // Sibling pull requests live in the *project*, not in this PR's worktree, so
  // stepping to one must resolve against the project scope the review was
  // opened from — `targetCtx` — rather than the checkout it is showing.
  const projectCtx = () => targetCtx ?? session.ctx;
  // DiffPanel still needs a tab id for its reusable session-oriented plumbing,
  // but this embedded PR diff is owned by the review worktree. Keep the id
  // stable for the lifetime of the review so starting related work cannot reset the
  // diff state, refresh turn snapshots, or subscribe it to a new transcript.
  const reviewTabId = untrack(() => activeChatTabId ?? session.activeTabId);
  const getApi = () => api;
  let surfaceError = $state<PrSurfaceError | null>(null);
  // Read from the store rather than mirrored here: the Activity tab writes every
  // lifecycle change through `applyDetail`, so the chrome around it follows
  // without a callback threading the value back up.
  const reviewDetail = $derived(
    pullRequests.projects.at(serverId, projectScopeOf(projectCtx().session))?.prFor(target.number) ?? null,
  );

  // The worktree open and the provider detail read fail through separate RPCs.
  // Probe the detail through the shared cache so every landing tab, including
  // Diff, can show the host-specific connection action when checkout cannot
  // start because this host has no GitHub credential.
  $effect(() => {
    const number = target.number;
    const context = projectCtx();
    surfaceError = null;
    // The read lands in the store's index, which `reviewDetail` above reads —
    // this only has to notice the failure.
    void pullRequests.projects
      .get(api, serverId, context)
      .get(number)
      .loadDetail()
      .catch((error) => {
        if (target.number === number) surfaceError = prSurfaceError(error);
      });
  });

  // Everything about *this pull request's review* — threads, drafts, interdiff,
  // diff base — belongs to the PR, not to this component: the popped-out diff is
  // a second pane over the same review, and two `ReviewDrafts` over one
  // review-state file would silently diverge. See pr-review.store.
  const review = $derived(
    prReviewState(
      serverId,
      projectScopeOf((targetCtx ?? session.ctx).session),
      target.number,
      {
        getApi,
        fallbackCtx: () => targetCtx ?? session.ctx,
        ctxForDirectory: (path) => session.ctxForDirectory(path),
        stackedPrsEnabled: () => settings.stackedPrsEnabled,
        resolveDiffBase: (number, baseRef) =>
          stacks.resolveDiffBase(number, baseRef, serverId, projectCtx().session.projectPath),
        loadStacks: (ctx) => stacks.load(api, serverId, ctx),
        loadThreads: (ctx, number, force) =>
          pullRequests.projects.get(api, serverId, ctx).get(number).loadThreads({ force }),
        loadDiff: (ctx, request) => api.prGetDiff(ctx, request),
        prepareCheckout: (ctx, target) => api.prPrepareCheckout(ctx, target),
        loadInterdiff: (ctx, target, force) =>
          pullRequests.projects.get(api, serverId, ctx).get(target.number).loadInterdiff(target, { force }),
        diffStats: (ctx, scope) =>
          api.diffStats(ctx, { scope }).then((f) => f.length),
        replyThread: (ctx, number, threadId, body) =>
          pullRequests.projects.get(api, serverId, ctx).get(number).replyToThread(threadId, body),
        resolveThread: (ctx, number, threadId, resolved) =>
          pullRequests.projects.get(api, serverId, ctx).get(number).setThreadResolved(threadId, resolved),
      },
    ),
  );

  // Provider reads stay on the project context. Source-dependent reads switch
  // to the checkout only after the action that needs it prepares one.
  const prCtx = () => review.ctx;
  const checkout = $derived(review.checkout);

  // The resolved worktree arrives after the surface mounts; hand it to the state
  // so everything gated on the checkout unblocks at once.
  $effect(() => {
    review.setTarget(pr);
    if (pr) untrack(() => review.loadDiff());
  });

  $effect(() => {
    void review.pr?.number;
    untrack(() => review.loadStack());
  });

  const effectiveGuideKey = $derived(review.effectiveGuideKey);
  const ownDeltaBase = $derived(review.ownDeltaBase);
  const showingFullDiff = $derived(review.showingFullDiff);

  $effect(() => {
    if (review.liveDiffBase.kind === "target") review.showingFullDiff = false;
  });

  // The guide tab's data layer. This host renders its own chrome (header +
  // regenerate), so it drives the loader directly rather than through a child.
  const guideLoader = new GuideLoader({
    getApi,
    getServerId: () => serverId,
    getCtx: prCtx,
    getKey: () => effectiveGuideKey,
    getScope: () => "branch",
    getOwnDeltaBase: () => ownDeltaBase,
    getAgent: () => resolveReviewAgent(settings),
  });
  const guideStatus = $derived(
    pullRequests.guides.statusFor(serverId, prCtx(), target.number),
  );
  // A first-time generation may need to prepare the PR checkout before the
  // durable queue can report `queued`. Cover that gap so the click changes the
  // Guide surface immediately, then let the shared status take over.
  let preparingGuide = $state(false);
  const visibleGuideStatus = $derived(
    preparingGuide ? "queued" : guideStatus,
  );
  // Follow generation progress for the whole time this review is open, not just
  // around the loader's own call — the Generate button queues the work in the
  // background, and its progress is what fills the stepped screen.
  $effect(() => guideLoader.trackProgress());
  $effect(() => {
    void effectiveGuideKey;
    if (!guideEnabled || !review.stackReady || showingFullDiff) return;
    const backgroundStatus = untrack(() =>
      pullRequests.guides.statusFor(serverId, prCtx(), target.number),
    );
    if (backgroundStatus === "queued" || backgroundStatus === "generating")
      return;
    const generateIfMissing = settings.generatePrGuidesOnOpen && !!review.checkout;
    void untrack(() => guideLoader.load(false, generateIfMissing));
  });

  // A background "Generate guide" (Activity header / PRs page) finishing while
  // this pane sits on the empty or stale Guide state: pick up the cached guide.
  // Remember the ready transition we consumed so an old ready status plus a
  // stale cached guide cannot create a reload loop after the PR head moves.
  let handledReadyKey: string | null = null;
  $effect(() => {
    const readyKey =
      guideStatus === "ready" && pr
        ? `${pr.number}:${pr.headSha}:${effectiveGuideKey}`
        : null;
    if (!readyKey) {
      handledReadyKey = null;
      return;
    }
    if (
      handledReadyKey === readyKey ||
      !review.stackReady ||
      showingFullDiff ||
      guideLoader.loading ||
      (guideLoader.guide && !guideLoader.stale)
    ) {
      return;
    }
    handledReadyKey = readyKey;
    void untrack(() => guideLoader.load(false, false));
  });

  // Size of the change, for the Guide empty state's "what will this cost me"
  // line. `loadChangedFiles` is the same cached call the Activity tab makes, so
  // opening on Guide doesn't add a request.
  let changedFileCount = $state<number | null>(null);
  $effect(() => {
    const number = target.number;
    changedFileCount = null;
    const ctx = untrack(prCtx);
    void pullRequests.projects
      .get(api, serverId, ctx)
      .get(number)
      .loadChangedFiles()
      .then((files) => {
        if (target.number === number) changedFileCount = files.length;
      })
      .catch(() => {});
  });
  const guideEmptyHint = $derived.by(() => {
    const count = changedFileCount;
    if (count === null) return undefined;
    const files = `${count} ${count === 1 ? "file" : "files"} changed`;
    return count > 20
      ? `${files} · a minute or two for a change this size`
      : `${files} · usually under a minute`;
  });
  async function generateGuide() {
    if (preparingGuide) return;
    preparingGuide = true;
    toasts.info(`Started generating the review guide for PR #${target.number}`);
    try {
      await review.ensureCheckout();
      await pullRequests.guides.request(api, serverId, prCtx(), [target.number], {
        onSettled: ({ failed }) => {
          if (failed > 0) {
            toasts.error(`Review guide generation failed for PR #${target.number}`, {
              description: "Try again from Activity or Guide.",
            });
          } else {
            toasts.success(`Review guide ready for PR #${target.number}`, {
              description: "Open the Guide tab to review it.",
            });
          }
        },
      });
    } catch (error) {
      toasts.error("Couldn't prepare the review guide", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      preparingGuide = false;
    }
    requestInputFocus();
  }

  // Whether the cached guide still describes HEAD is state about this pull
  // request, so it rides in the header with the rest of it rather than as a
  // chip inside the narrative it qualifies.
  const guideHeaderActions = $derived({
    present: !!guideLoader.guide,
    stale: guideLoader.stale,
    regenerating: guideLoader.loading,
    onRegenerate: (mode: "full" | "new-commits") => void regenerateGuide(mode),
  });

  async function regenerateGuide(mode: "full" | "new-commits") {
    toasts.info(`Started generating the review guide for PR #${target.number}`);
    try {
      await review.ensureCheckout();
      await guideLoader.refresh(mode);
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : String(error));
    }
    requestInputFocus();
  }

  // The active content tab lives in the PR store so chrome outside this
  // component can react to it (see PrReviewSession.tab).
  type ContentTab = "activity" | "map" | "guide" | "diff";
  // The host target enables Activity and Diff together. A cached guide can also
  // load then; only generation and other source actions need checkout.
  const sub = $derived(
    pr ? (activeTab ?? pullRequests.view.tab) : "activity",
  );

  const diffScope = $derived(review.diffScope);

  // The Map tab reads the same effective patch as the Diff tab, so a
  // since-review checkpoint narrows both views together.
  const mapPatch = $derived(
    isSinceReviewMode ? (interdiff?.patch ?? "") : (review.diffPatch ?? ""),
  );
  const mapFiles = $derived(
    mapPatch ? parsePatchFiles(mapPatch).flatMap((part) => part.files) : [],
  );

  async function loadRepoFilesForMap(repoRoot: string): Promise<readonly string[] | null> {
    const result = await getApi().listProjectFiles(prCtx(), { cwd: repoRoot });
    return result.ok ? result.files : null;
  }

  $effect(() => {
    void review.ownDeltaBase?.headSha;
    untrack(() => review.loadOwnDeltaFileCount());
  });

  // Threads, the interdiff and the draft comments all live on the shared review
  // state — the popped-out diff is another pane over this same review.
  const reviewThreads = $derived(review.threads);
  const threadsLoadFailed = $derived(review.threadsLoadFailed);
  function loadThreads(force = false) {
    review.loadThreads(force);
  }
  // Provider-backed, so this runs during the pending phase too — the threads are
  // part of the Activity timeline, not of the worktree.
  $effect(() => {
    void target.number;
    untrack(() => loadThreads());
  });
  $effect(() => {
    onUnresolvedCountChange?.(review.unresolvedCount);
  });

  function loadInterdiff(force = false) {
    review.loadInterdiff(force);
  }

  $effect(() => {
    void review.pr?.number;
    void review.pr?.baseSha;
    void review.pr?.headSha;
    untrack(() => loadInterdiff());
  });

  const interdiff = $derived(review.interdiff);
  const hasReviewCheckpointNotice = $derived(review.hasReviewCheckpointNotice);
  const isSinceReviewMode = $derived(review.isSinceReviewMode);
  const sinceReviewThreads = $derived(review.sinceReviewThreads);

  // ── Commit scope ──
  // While set, the Diff tab shows one commit's changes instead of the PR diff.
  const commitScope = $derived(review.commitScope);
  const diffViewLoading = $derived(
    commitScope
      ? review.commitDiffLoading && review.commitDiffPatch === null
      : review.diffLoading && review.diffPatch === null,
  );
  const diffViewError = $derived(
    commitScope ? review.commitDiffError : review.diffError,
  );

  $effect(() => {
    const currentNumber = target.number;
    const prCwd = review.checkout?.worktreePath;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribeAllHosts(
      "prs.invalidated",
      (emittingServerId, { projectRoot: changedCwd }) => {
        if (emittingServerId !== serverId) return;
        const paneCtx = prCtx();
        const ctxCwd = projectScopeOf(paneCtx.session);
        if (changedCwd !== ctxCwd && changedCwd !== prCwd) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (target.number !== currentNumber) return;
          loadThreads(true);
          activityFeedRef?.refresh();
        }, 500);
      },
    );
    return () => {
      unsub();
      clearTimeout(timer);
    };
  });

  // Reply / resolve for the threads rendered inline in the Diff tab. Mirrors the
  // Activity tab's affordances; mutation of the thread object lives in
  // DiffThreadComment so the inline card and the popover update in place.
  const replyToThread = (threadId: string, body: string) =>
    review.replyToThread(threadId, body);
  const resolveThread = (threadId: string, resolved: boolean) =>
    review.resolveThread(threadId, resolved);

  // GitHub-bound draft comments, persisted per guide key (shared store with the
  // local review guide surface, where drafts become agent feedback instead).
  $effect(() => {
    void effectiveGuideKey;
    void review.stackReady;
    untrack(() => review.loadDrafts());
  });

  const drafts = $derived(review.drafts.drafts);
  const diffComments = $derived(review.drafts.diffComments);
  const saveDiffComment = (c: GuideDiffCommentSave) => review.drafts.save(c);
  const removeDraft = (id: string) => review.drafts.remove(id);

  let showSubmit = $state(false);
  let activityFeedRef: ActivityFeed | null = $state(null);
  let refreshingPr = $state(false);
  // Owned here so a typed summary survives closing/reopening the submit modal.
  let submitEvent = $state<DraftReview["event"]>("COMMENT");
  let submitBody = $state("");

  async function refreshPr() {
    if (refreshingPr) return;
    refreshingPr = true;
    try {
      // The host shares its answers between clients, so clearing this client's
      // caches is not enough — tell it to forget before anything below re-reads.
      await pullRequests.projects.get(api, serverId, projectCtx()).forgetHostCache();
      if (activityFeedRef) {
        await activityFeedRef.refresh();
      } else {
        loadThreads(true);
        const detailRefresh = pullRequests.projects
          .get(api, serverId, projectCtx())
          .get(target.number)
          .loadDetail({ force: true })
          .then(() => {});
        await Promise.all([detailRefresh, onRefreshTarget?.()]);
      }
      loadInterdiff(true);
      review.loadDiff(true);
    } catch (error) {
      toasts.error(`Couldn't refresh PR #${target.number}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshingPr = false;
      requestInputFocus();
    }
  }

  // A submitted review creates threads and flips the viewer's review state —
  // reload so the result is visible without a manual refresh. The feed's
  // refresh() covers detail/reviewers and re-triggers loadThreads; when the
  // Activity tab was never mounted, reload the shared threads directly.
  function onReviewSubmitted() {
    review.drafts.clear();
    loadInterdiff(true);
    if (activityFeedRef) activityFeedRef.refresh();
    else loadThreads(true);
  }

  useScope("pr-review", { active: () => !headless });
  useKeybinding(
    "pr-review.approve",
    () => {
      submitEvent = "APPROVE";
      showSubmit = true;
    },
    {
      enabled: () =>
        !headless &&
        !showSubmit &&
        !!pr &&
        !!reviewDetail?.viewerPermissions.reviewVerdicts.includes("approve"),
    },
  );

  // Keep each visited tab mounted (DiffState / scroll / derived chains survive
  // toggles) and hide the inactive ones via display:none, per the Svelte perf rule.
  // Mount whichever tab we open on (Activity by default) so it renders without a
  // blank frame; the others mount lazily on first visit.
  let mountedGuide = $state(untrack(() => sub === "guide"));
  // Popped-out mode redirects the Diff tab to Activity + pane (effect below);
  // mounting the inline panel there would keep a full hidden duplicate of the
  // popped-out diff (a second CodeView and parsed patch) alive for the tab's life.
  let mountedDiff = $state(untrack(() => sub === "diff" && (headless || embedded)));
  let mountedActivity = $state(untrack(() => sub === "activity"));
  let mountedMap = $state(untrack(() => sub === "map"));
  $effect(() => {
    if (sub === "guide") mountedGuide = true;
    else if (sub === "diff") { if (inlineDiff) mountedDiff = true; }
    else if (sub === "activity") mountedActivity = true;
    else if (sub === "map") mountedMap = true;
  });

  // The diff is a pane, not a tab. Reading a change is a two-handed job — the
  // conversation on one side, the code on the other — so Diff pops out beside
  // the review rather than replacing what you were reading. Review Mode
  // (headless) has no pane to pop into, and the embedded panel is already the
  // companion of the list; both keep the diff inline.
  const inlineDiff = $derived(headless || embedded);
  const diffPoppedOut = $derived(
    !inlineDiff && session.router.params("prDiff")?.number === target.number,
  );

  /** Put the left column on Activity — the conversation that belongs beside an
   *  open diff. */
  function showActivityColumn() {
    if (activeTab === undefined) pullRequests.view.tab = "activity";
    onActiveTabChange?.("activity");
    mountedActivity = true;
  }

  // A row whose verb was "Review" lands on the diff: honour that by popping it
  // out, with Activity behind it.
  $effect(() => {
    if (inlineDiff || pullRequests.view.tab !== "diff" || !pr) return;
    untrack(() => {
      showActivityColumn();
      session.openPrDiff(target.number, prCtx());
    });
  });

  function select(next: ContentTab) {
    if (next === "guide" && showingFullDiff) return;
    if (next === "diff" && !inlineDiff) {
      if (diffPoppedOut) {
        session.closePrDiff();
      } else {
        // Reading a diff is a two-handed job: the change on the right, the
        // conversation about it on the left. Landing on the guide's empty state
        // beside a diff is the one pairing that says nothing, so opening the
        // change brings Activity with it.
        showActivityColumn();
        session.openPrDiff(target.number, prCtx());
      }
      requestInputFocus();
      return;
    }
    if (activeTab === undefined) pullRequests.view.tab = next;
    onActiveTabChange?.(next);
    requestInputFocus();
  }

  function toggleFullDiff() {
    review.showingFullDiff = !review.showingFullDiff;
    if (inlineDiff) {
      if (activeTab === undefined) pullRequests.view.tab = "diff";
      onActiveTabChange?.("diff");
      mountedDiff = true;
    } else {
      showActivityColumn();
      session.openPrDiff(target.number, prCtx());
    }
    requestInputFocus();
  }

  // File chips in the Guide / threads in Activity open the change beside the
  // review and scroll it to the file, so the explanation stays on screen.
  let diffPanelRef: DiffPanel | null = $state(null);

  function jumpToDiff(
    path?: string,
    line?: number | null,
    side: "old" | "new" = "new",
  ) {
    if (!inlineDiff) {
      // A jump from the guide keeps the guide: you asked to see one file while
      // reading the narrative, not to leave it.
      session.openPrDiff(target.number, prCtx());
      // Usually asked for in the same tick the pane is opened, so the request is
      // parked on the shared state and consumed once the pane mounts.
      if (path) review.requestJump(path, line, side);
      requestInputFocus();
      return;
    }
    if (activeTab === undefined) pullRequests.view.tab = "diff";
    onActiveTabChange?.("diff");
    mountedDiff = true;
    if (path) {
      // First visit mounts the panel on this tick; navigate once it exists.
      void tick().then(() =>
        diffPanelRef?.navigateTo(path, line ?? undefined, side),
      );
    }
    requestInputFocus();
  }

  // A commit chip in Activity opens the change scoped to that commit — the
  // same surface as a file jump, narrowed to one commit's patch.
  function openCommitDiff(commit: PrCommit) {
    review.viewCommit(commit);
    if (!inlineDiff) {
      showActivityColumn();
      session.openPrDiff(target.number, prCtx());
    } else {
      if (activeTab === undefined) pullRequests.view.tab = "diff";
      onActiveTabChange?.("diff");
      mountedDiff = true;
    }
    requestInputFocus();
  }

  function clearCommitScope() {
    review.clearCommitScope();
    requestInputFocus();
  }

  type PrComposerIntent = "checkout" | "question" | "fix";

  // Checkout progress belongs to the PR surface that started it. One live toast
  // names each observable phase, then becomes the terminal ready/error result.
  // Only a prepared worktree is routed into the composer, so a failure leaves
  // the PR and its initiating action in place for a retry.
  async function openPreparedComposer(
    prompt: string | undefined,
    task: "new" | "none",
    intent: PrComposerIntent,
  ) {
    if (!pr) return;
    const targetPane = paneId ?? session.router.focusedPaneId;
    const hadCheckout = review.sourceContext !== null;
    const progress = toasts.progress(
      hadCheckout
        ? "Opening session composer…"
        : `Preparing PR #${target.number} worktree…`,
    );
    try {
      const sourceContext = await review.ensureCheckout();
      if (!hadCheckout) progress.update("Opening session composer…");
      session.openPrReviewDraft(sourceContext, {
        prompt,
        serverId,
        target: targetPane,
        task,
      });
      progress.success(
        intent === "fix"
          ? "Fix composer ready"
          : intent === "question"
            ? "Question composer ready"
            : "PR composer ready",
        {
          description: `PR #${target.number} · ${sourceContext.branch}`,
        },
      );
    } catch (error) {
      progress.error(
        intent === "fix"
          ? "Couldn't prepare the fix checkout"
          : "Couldn't prepare the PR checkout",
        {
          description: error instanceof Error ? error.message : String(error),
        },
      );
    }
    requestInputFocus();
  }

  async function openPrComposer(prompt?: string) {
    if (preparingComposer) return;
    preparingComposer = true;
    try {
      await openPreparedComposer(
        prompt,
        "none",
        prompt ? "question" : "checkout",
      );
    } finally {
      preparingComposer = false;
    }
  }

  async function openFixDraft(prompt: string) {
    await openPreparedComposer(prompt, "new", "fix");
  }

  async function openFixComments(feedback?: PrFixFeedback) {
    await openFixDraft(buildPrCommentsFixPrompt(target, feedback));
  }

  async function openFixCheck(check: Parameters<typeof buildPrCheckFixPrompt>[1]) {
    await openFixDraft(buildPrCheckFixPrompt(target, check));
  }

  function exit() {
    if (onExit) onExit();
    else session.exitPrReview();
    requestInputFocus();
  }

  function step(delta: number) {
    if (onStep) onStep(delta);
    else session.stepPrReview(delta, projectCtx());
  }

  const summary = $derived(
    pullRequests.projects.at(serverId, projectScopeOf(projectCtx().session))?.prFor(target.number) ?? null,
  );
  const targetRepo = $derived(
    target.host && target.repo && (target.remoteOwner ?? target.owner)
      ? {
          host: target.host,
          owner: target.remoteOwner ?? target.owner ?? "",
          repo: target.repo,
        }
      : null,
  );

  // The pull request names its own host page. It arrives with the detail read
  // above, which does not wait on checkout — so this is null only for the frame
  // before that lands, never for the length of a worktree fetch.
  const prUrl = $derived(reviewDetail?.url ?? null);

  function openPr() {
    if (prUrl) void localApi.openExternal(prUrl);
  }

  useKeybinding(
    "pr-review.copy-link",
    async () => {
      if (!prUrl) return;
      await copyText(prUrl);
      requestInputFocus();
    },
    { enabled: () => !headless && !!prUrl },
  );

  // Esc is the only way out, and J / K walk the queue. All three skip while a
  // comment/text field is focused (it owns its own keys) or the submit modal is
  // up (it owns Esc).
  function onWindowKeydown(e: KeyboardEvent) {
    if (headless || e.defaultPrevented || showSubmit) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el && (el.isContentEditable || el.closest("input, textarea"))) return;
    if (e.key === "Escape") {
      e.preventDefault();
      // Full screen is a state you back out of before you leave the review —
      // unless it is the only state this surface has room for.
      if (embedded && fullScreen && onToggleFullScreen) onToggleFullScreen();
      else exit();
    } else if (e.key === "j" || e.key === "J") {
      e.preventDefault();
      step(1);
    } else if (e.key === "k" || e.key === "K") {
      e.preventDefault();
      step(-1);
    } else if (embedded && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      onToggleFullScreen?.();
    }
  }

  // The chip agrees with the list's own grouping rather than inventing a second
  // vocabulary — a row filed under "Awaiting your review" says so here too.
  const statusKey = $derived.by(() => {
    const item = summary;
    if (!item) return "open";
    if (item.state === "merged") return "merged";
    if (item.state === "closed") return "closed";
    if (item.draft) return "draft";
    if (item.needsMyReview) return "review";
    return "open";
  });
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet detailMasthead()}
  <PrDetailMasthead
    repo={targetRepo ? `${targetRepo.owner}/${targetRepo.repo}` : null}
    number={target.number}
    onOpenPage={prUrl ? openPr : undefined}
    tab={sub === "guide" || sub === "map" ? sub : "activity"}
    diffOpen={diffPoppedOut}
    guideDisabled={showingFullDiff}
    guideDisabledReason="Guides cover the stacked view"
    tabsDisabled={!pr}
    onSelect={select}
  />
{/snippet}

<!-- The panel keeps all three views inside itself, so Diff is a peer of the
     other two here rather than a toggle that opens a pane beside them. -->
{#snippet panelTabs()}
  <PrViewTabs
    tab={sub === "diff" ? null : sub}
    diffOpen={sub === "diff"}
    guideDisabled={showingFullDiff}
    guideDisabledReason="Guides cover the stacked view"
    tabsDisabled={!pr}
    diffHint="Read the change"
    onSelect={select}
  />
{/snippet}

<!-- The one filled surface in either header shape: it gives the pull request a
     worktree of its own and opens a session composer on it. It is the shared Button in
     its compact size, so it carries the same accent fill, rounded-rectangle
     radius and press response as the document and work headers' own primary
     action — a full pill read as a different family of button from every other
     control the user presses.

     It sits in the band's trailing cluster, beside the #number and the tabs,
     and wears the same glyph the number does, so the row names one object once.
     Its geometry follows the chrome rung it is typed on: 26px on a desktop
     display, 24px on a laptop, and a thumb-sized target on touch.

     Under 40rem of band it gives up its label and keeps the glyph: the band
     beside a companion pane is legally that narrow, and with the traffic-light
     inset in front of the tabs the full label was what pushed the overflow and
     the ✕ past the pane's edge, under the pane beside it. The rung is named
     against the band, so in the page shape — where no band is declared — it
     never fires and the label stays. -->
{#snippet checkoutButton()}
  <Button
    type="button"
    size="xs"
    class="ml-[5px] h-[26px] shrink-0 gap-1.5 px-2.5 text-workspace-chrome pointer-coarse:h-10 pointer-coarse:px-3.5 pointer-fine:[.is-laptop-display_&]:h-6 pointer-fine:[.is-laptop-display_&]:px-2 @max-[40rem]/band:px-2"
    onclick={() => void openPrComposer()}
    disabled={preparingComposer || !pr}
    aria-label="Check out this pull request"
    title={preparingComposer
      ? "Preparing checkout…"
      : "Check out this pull request in its own worktree and open a session composer on it"}
  >
    {#if preparingComposer}
      <CircleNotchIcon
        class="size-3 animate-spin [animation-duration:0.9s]"
        aria-hidden="true"
      />
    {:else}
      <GitPullRequestIcon class="size-3" aria-hidden="true" />
    {/if}
    <span class="@max-[40rem]/band:hidden">
      {preparingComposer ? "Preparing…" : "Check out"}
    </span>
  </Button>
{/snippet}

<!-- The overflow both header shapes hand their occasional commands to: the
     branch name leads it, the tab's own commands sit under the rule. -->
{#snippet overflowMenu()}
  <PrPanelOverflowMenu
    tab={sub}
    onRefresh={() => void refreshPr()}
    refreshing={refreshingPr}
    onOpenPage={prUrl ? openPr : undefined}
    guide={guideHeaderActions}
    headRef={pr?.headRef ?? summary?.headRef}
  />
{/snippet}

<section class="flex h-full min-h-0 flex-col bg-background">
  {#if embedded}
    <PrPanelHeader
      number={target.number}
      headRef={pr?.headRef ?? summary?.headRef}
      tab={sub}
      {fullScreen}
      {onToggleFullScreen}
      onOpenPage={prUrl ? openPr : undefined}
      {onMoveAcross}
      isLeading={false}
      onClose={exit}
      onRefresh={() => void refreshPr()}
      refreshing={refreshingPr}
      guide={guideHeaderActions}
        tabs={panelTabs}
    >
      <!-- The band keeps only the one action you take in the moment — Check
           out, which gives the pull request a worktree and a session composer.
           Refresh and the external host page live in the overflow, and the
           check state is read on Activity. -->
      {#snippet actions()}
        {@render checkoutButton()}
      {/snippet}
    </PrPanelHeader>
  {:else if !headless}
    <!-- The sub page band every record shares: the way back, this review's
         switcher, its verbs, the queue stepper, and the pane controls. The
         tabs live down in the masthead where they belong to the content. -->
    <PrDetailChrome
      number={target.number}
      {serverId}
      {projectCtx}
      onExit={exit}
      {onMoveAcross}
      {onToggleMaximize}
      {maximized}
    >
      {#snippet actions()}
        {@render checkoutButton()}
        <!-- The same overflow the panel band carries, so refresh, external
             host navigation, and guide rewrite (with its stale dot) are one
             object in one place whichever shape the review takes. -->
        {@render overflowMenu()}
        <FrameExpandButton variant="projectPanel" size="header" />
      {/snippet}
    </PrDetailChrome>
  {/if}

  <div class="relative min-h-0 flex-1">
    {#if !pr && surfaceError?.kind === "github-auth"}
      <div class="absolute inset-0 z-10 grid place-items-center bg-background px-6">
        <GithubConnectionRequired {serverId} />
      </div>
    {/if}
    <!-- A cached guide can load without checkout. Generation prepares one. -->
    {#if mountedGuide && pr}
      <div
        class="absolute inset-0 flex flex-col"
        class:hidden={sub !== "guide"}
      >
        {#if !guideEnabled}
          <div class="grid h-full place-items-center px-8 text-center">
            <div class="max-w-sm">
              <p class="text-sm font-medium">
                Guide skipped for this quick review
              </p>
              <p
                class="mt-1.5 text-pretty text-sm leading-[1.6] text-muted-foreground"
              >
                The complete diff is ready in view 3. Activity and Diff remain
                fully available.
              </p>
            </div>
          </div>
        {:else}
          <!-- The guide reads full width: it is a narrative about the whole
               change, not a column beside a rail. The masthead rides above it
               so the same row appears whichever tab is showing. -->
          {#if !headless && !embedded}
            <!-- Match GuideView's measure and asymmetric reading gutters so
                 the status/refs begin on the title's left edge and the tabs
                 end on the guide content's right edge. -->
            <div
              class="mx-auto w-full max-w-[92rem] pt-[clamp(20px,1.8cqi,32px)] pr-8 pl-14 2xl:max-w-[104rem]"
            >
              {@render detailMasthead()}
            </div>
          {/if}
          {#if ownDeltaBase}
            <StackDiffBanner
              parent={ownDeltaBase.parent}
              fileCount={review.ownDeltaFileCount}
              showingFull={false}
              onToggle={toggleFullDiff}
            />
          {/if}
          <GuideSurface
            loader={guideLoader}
            onFileJump={jumpToDiff}
            comments={diffComments}
            onCommentSave={saveDiffComment}
            onCommentDelete={removeDraft}
            meta={{
              repo: pr.repo,
              number: pr.number,
              baseRef: pr.baseRef,
              branch: pr.headRef,
            }}
            emptyHint={guideEmptyHint}
            generationStatus={visibleGuideStatus}
            onGenerate={generateGuide}
            onAlwaysGenerate={settings.generatePrGuidesOnOpen
              ? undefined
              : () => {
                  settings.update({ generatePrGuidesOnOpen: true });
                  generateGuide();
                }}
          />
        {/if}
      </div>
    {/if}
    {#if mountedMap && pr}
      <div class="absolute inset-0 flex flex-col" class:hidden={sub !== "map"}>
        {#if !headless && !embedded}
          <!-- Same measure and gutters as the Guide masthead so the chrome row
               doesn't shift when switching tabs. -->
          <div
            class="mx-auto w-full max-w-[92rem] pt-[clamp(20px,1.8cqi,32px)] pr-8 pl-14 2xl:max-w-[104rem]"
          >
            {@render detailMasthead()}
          </div>
        {/if}
        <div class="min-h-0 flex-1">
          {#if review.diffLoading && review.diffPatch === null}
            <div class="grid h-full place-items-center text-xs text-muted-foreground" role="status">
              Loading pull request diff…
            </div>
          {:else if review.diffError}
            <div class="grid h-full place-items-center px-6 text-center text-xs text-destructive" role="alert">
              {review.diffError}
            </div>
          {:else}
            <!-- Same root fallback as the Diff tab's projectPath: the PR
                 checkout when one exists, else the open project's checkout —
                 an approximation of the PR head's tree, but the repo shape is
                 what the overview needs. -->
            <DiffHeatMap
              files={mapFiles}
              onOpenFile={(path) => jumpToDiff(path)}
              repoRoot={checkout?.worktreePath ??
                projectCtx().session.projectPath ??
                projectCtx().session.workingDirectory ??
                null}
              loadRepoFiles={loadRepoFilesForMap}
            />
          {/if}
        </div>
      </div>
    {/if}
    {#if mountedDiff && pr}
      <div class="absolute inset-0 flex flex-col" class:hidden={sub !== "diff"}>
        {#if !commitScope && ownDeltaBase}
          <StackDiffBanner
            parent={ownDeltaBase.parent}
            fileCount={review.ownDeltaFileCount}
            showingFull={showingFullDiff}
            onToggle={toggleFullDiff}
          />
        {:else if hasReviewCheckpointNotice && interdiff}
          <SinceReviewBar
            result={interdiff}
            showingSince={isSinceReviewMode}
            onModeChange={(sinceReview) => {
              review.showingSinceReview = sinceReview;
              requestInputFocus();
            }}
          />
        {/if}
        <div class="min-h-0 flex-1">
          {#if diffViewLoading}
            <div class="grid h-full place-items-center text-xs text-muted-foreground" role="status">
              Loading {commitScope ? "commit" : "pull request"} diff…
            </div>
          {:else if diffViewError}
            <div class="grid h-full place-items-center px-6 text-center text-xs text-destructive" role="alert">
              {diffViewError}
            </div>
          {:else}
          <DiffPanel
            bind:this={diffPanelRef}
            tabId={reviewTabId}
            {paneId}
            getCtx={prCtx}
            {getApi}
            projectPath={checkout?.worktreePath ?? projectScopeOf(projectCtx().session)}
            worktreePath={checkout?.worktreePath}
            worktreeBranch={pr.headRef}
            targetBranch={pr.baseRef}
            isWorktree={!!checkout}
            onClose={() => select(showingFullDiff ? "activity" : "guide")}
            embedded
            hasHostHeaderRow={!headless}
            initialScope={diffScope}
            commentingDisabled={!!commitScope}
            commitSha={commitScope?.sha ?? null}
            onClearCommitScope={clearCommitScope}
            patchOverride={commitScope
              ? (review.commitDiffPatch ?? "")
              : isSinceReviewMode
                ? (interdiff?.patch ?? "")
                : (review.diffPatch ?? "")}
            patchOverrideFileLoader={commitScope
              ? review.loadCommitDiffFiles
              : isSinceReviewMode
                ? undefined
                : review.loadDiffFiles}
            emptyState={commitScope
              ? {
                  title: "No file changes in this commit",
                  description:
                    "This commit did not change any reviewable files.",
                }
              : isSinceReviewMode
                ? {
                    title: "No patch changes since your review",
                    description:
                      "The PR head moved, but its effective patch stayed the same.",
                  }
                : undefined}
            externalComments={commitScope ? [] : diffComments}
            onExternalCommentSave={saveDiffComment}
            onExternalCommentDelete={removeDraft}
            reviewThreads={commitScope
              ? []
              : isSinceReviewMode
                ? sinceReviewThreads
                : reviewThreads}
            onThreadReply={replyToThread}
            onThreadResolve={resolveThread}
          />
          {/if}
        </div>
      </div>
    {/if}
    {#if mountedActivity}
      <div class="absolute inset-0" class:hidden={sub !== "activity"}>
        <ActivityFeed
          bind:this={activityFeedRef}
          pr={target}
          status={statusKey}
          threads={reviewThreads}
          threadsFailed={threadsLoadFailed}
          diffPatch={review.diffPatch}
          getCtx={prCtx}
          {getApi}
          {serverId}
          showIdentity={!embedded}
          addressCommentsReady={!!pr && review.checkoutStatus !== "preparing"}
          onAddressComments={() => openFixComments()}
          onFixCheck={openFixCheck}
          generationStatus={visibleGuideStatus}
          onGenerateGuide={generateGuide}
          onRefreshThreads={() => loadThreads(true)}
          {onRefreshTarget}
          showRemoteLink
          onAskQuestion={() => void openPrComposer(buildPrQuestionDraft(target))}
          askQuestionBusy={preparingComposer}
          onJump={jumpToDiff}
          onOpenCommit={openCommitDiff}
          masthead={headless || embedded ? undefined : detailMasthead}
        />
      </div>
    {/if}
  </div>

</section>

{#if showSubmit && pr}
  <SubmitReviewModal
    {pr}
    {drafts}
    submitReview={(review) =>
      pullRequests.projects.get(getApi(), serverId, prCtx()).get(pr.number).submitReview(review)}
    allowedVerdicts={reviewDetail?.viewerPermissions.reviewVerdicts ?? ["comment"]}
    bind:event={submitEvent}
    bind:body={submitBody}
    onClose={() => (showSubmit = false)}
    onSubmitted={onReviewSubmitted}
    onDraftFixes={openFixComments}
  />
{/if}
