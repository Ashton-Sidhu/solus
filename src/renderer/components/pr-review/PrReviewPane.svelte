<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import {
    ArrowsClockwiseIcon,
    ArrowsInIcon,
    ArrowsOutIcon,
    SparkleIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { IpcContext } from "../../../shared/types";
  import type {
    DraftReview,
    PrCommit,
    PullRequestDetail,
    PrReviewTarget,
  } from "../../../shared/providers";
  import type { GuideDiffCommentSave } from "./guide/lib/guide-data";
  import {
    getWorkspaceContext,
    getSettingsContext,
    getAgentContext,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { HostApi } from "@client-core/host-api";
  import { subscribeAllHosts } from "@client-core/host-events";
  import { localApi } from "@client-core/local-api";
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
  import CommitDiffBanner from "./CommitDiffBanner.svelte";
  import { prReviewState } from "./lib/pr-review.store.svelte";
  import PrDetailChrome from "./PrDetailChrome.svelte";
  import GithubConnectionRequired from "../prs/GithubConnectionRequired.svelte";
  import { prSurfaceError, type PrSurfaceError } from "../prs/lib/pr-surface-error";
  import PrDetailMasthead from "./PrDetailMasthead.svelte";
  import PrPanelHeader from "./PrPanelHeader.svelte";
  import PrViewTabs from "./PrViewTabs.svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { Button } from "../ui/button";
  import FrameExpandButton from "../layout/FrameExpandButton.svelte";
  import PrChecksChip from "../prs/PrChecksChip.svelte";
  import StackDiffBanner from "./StackDiffBanner.svelte";
  import {
    beginPrReviewProfile,
    markPrReviewProfile,
  } from "./lib/pr-review-profiler";

  // The review surface (M3–M5): Activity · Guide · Diff content tabs over a PR's
  // change, living maximized in the secondary pane. The "Chat" button lazily
  // creates a worktree-rooted conversation and pops it out alongside the review.
  //
  // The surface mounts the moment a PR is clicked, before its worktree has been
  // fetched and checked out: `pr` is null until then, and everything that reads
  // the checkout — the stack, the guide, the diff, the interdiff, chat — waits
  // for it. Activity does not: it is provider-backed, so it renders from
  // `target` against `targetCtx` and is usually filled from PrsStore's prefetch
  // by first paint. One mounted component across both phases is what keeps the
  // open to a single page filling in rather than a placeholder swap.
  let {
    pr,
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
    onExit,
    onStep,
    guideEnabled = true,
    onUnresolvedCountChange,
    onRefreshTarget,
  }: {
    pr: PrReviewTarget | null;
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
    /** How Esc and the close control get out. Defaults to leaving the review route. */
    onExit?: () => void;
    /** How J / K walk the queue. Defaults to stepping the review route. */
    onStep?: (delta: number) => void;
    guideEnabled?: boolean;
    onUnresolvedCountChange?: (count: number) => void;
    onRefreshTarget?: () => Promise<void>;
  } = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const stacks = session.stacksStore;

  onMount(() => {
    beginPrReviewProfile(target.number);
    markPrReviewProfile("review-pane-mounted");
    requestAnimationFrame(() => markPrReviewProfile("review-pane-first-paint"));
  });
  let activeChatTabId = $state<string | null>(null);
  let openingChat = $state(false);
  $effect(() => {
    activeChatTabId = chatTabId;
  });
  // Sibling pull requests live in the *project*, not in this PR's worktree, so
  // stepping to one must resolve against the project scope the review was
  // opened from — `targetCtx` — rather than the checkout it is showing.
  const projectCtx = () => targetCtx ?? session.ctx;
  // DiffPanel still needs a tab id for its reusable session-oriented plumbing,
  // but this embedded PR diff is owned by the review worktree. Keep the id
  // stable for the lifetime of the review so attaching Chat cannot reset the
  // diff state, refresh turn snapshots, or subscribe it to a new transcript.
  const reviewTabId = untrack(() => activeChatTabId ?? session.activeTabId);
  const getApi = () => api;
  let surfaceError = $state<PrSurfaceError | null>(null);
  let reviewDetail = $state<PullRequestDetail | null>(null);

  // The worktree open and the provider detail read fail through separate RPCs.
  // Probe the detail through the shared cache so every landing tab, including
  // Diff, can show the host-specific connection action when checkout cannot
  // start because this host has no GitHub credential.
  $effect(() => {
    const number = target.number;
    const context = projectCtx();
    surfaceError = null;
    void session.prsStore
      .loadDetail(api, serverId, context, number)
      .then((detail) => {
        if (target.number === number) reviewDetail = detail;
      })
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
      (targetCtx ?? session.ctx).session.projectPath ?? (targetCtx ?? session.ctx).session.workingDirectory,
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
          session.prsStore.loadThreads(api, serverId, ctx, number, { force }),
        loadDiff: (ctx, request) => api.prGetDiff(ctx, request),
        prepareCheckout: (ctx, target) => api.prPrepareCheckout(ctx, target),
        loadInterdiff: (ctx, target, force) =>
          session.prsStore.loadInterdiff(api, serverId, ctx, target, { force }),
        diffStats: (ctx, scope) =>
          api.diffStats(ctx, { scope }).then((f) => f.length),
        replyThread: (ctx, number, threadId, body) =>
          api.prReplyThread(ctx, number, threadId, body),
        resolveThread: async (ctx, number, threadId, resolved) => {
          if (resolved) await api.prResolveThread(ctx, number, threadId);
          else await api.prUnresolveThread(ctx, number, threadId);
        },
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
    getCtx: prCtx,
    getKey: () => effectiveGuideKey,
    getScope: () => "branch",
    getOwnDeltaBase: () => ownDeltaBase,
    getAgent: () => resolveReviewAgent(settings, agentContext),
  });
  const guideStatus = $derived(
    session.prsStore.guideStatusFor(serverId, prCtx(), target.number),
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
      session.prsStore.guideStatusFor(serverId, prCtx(), target.number),
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
    void session.prsStore
      .loadChangedFiles(api, serverId, ctx, number)
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
    try {
      await review.ensureCheckout();
      await session.prsStore.requestGuides(api, serverId, prCtx(), [target.number], {
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

  async function regenerateGuide() {
    try {
      await review.ensureCheckout();
      await guideLoader.refresh();
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : String(error));
    }
    requestInputFocus();
  }

  // The active content tab lives in the PR store so chrome outside this
  // component can react to it (see PrsStore.prReviewTab).
  type ContentTab = "activity" | "map" | "guide" | "diff";
  // The host target enables Activity and Diff together. A cached guide can also
  // load then; only generation and other source actions need checkout.
  const sub = $derived(
    pr ? (activeTab ?? session.prsStore.prReviewTab) : "activity",
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
    markPrReviewProfile("threads-ready", { count: review.threads.length });
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
        const ctxCwd =
          paneCtx.session.projectPath || paneCtx.session.workingDirectory;
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
      if (activityFeedRef) {
        await activityFeedRef.refresh();
      } else {
        loadThreads(true);
        const detailRefresh = session.prsStore
          .loadDetail(api, serverId, projectCtx(), target.number, { force: true })
          .then((detail) => (reviewDetail = detail));
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
  let mountedDiff = $state(untrack(() => sub === "diff"));
  let mountedActivity = $state(untrack(() => sub === "activity"));
  let mountedMap = $state(untrack(() => sub === "map"));
  $effect(() => {
    if (sub === "guide") mountedGuide = true;
    else if (sub === "diff") mountedDiff = true;
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
    if (activeTab === undefined) session.prsStore.prReviewTab = "activity";
    onActiveTabChange?.("activity");
    mountedActivity = true;
  }

  // A row whose verb was "Review" lands on the diff: honour that by popping it
  // out, with Activity behind it.
  $effect(() => {
    if (inlineDiff || session.prsStore.prReviewTab !== "diff" || !pr) return;
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
    if (activeTab === undefined) session.prsStore.prReviewTab = next;
    onActiveTabChange?.(next);
    requestInputFocus();
  }

  function toggleFullDiff() {
    review.showingFullDiff = !review.showingFullDiff;
    if (inlineDiff) {
      if (activeTab === undefined) session.prsStore.prReviewTab = "diff";
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
    if (activeTab === undefined) session.prsStore.prReviewTab = "diff";
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
      if (activeTab === undefined) session.prsStore.prReviewTab = "diff";
      onActiveTabChange?.("diff");
      mountedDiff = true;
    }
    requestInputFocus();
  }

  function clearCommitScope() {
    review.clearCommitScope();
    requestInputFocus();
  }

  // Chat changes only the primary pane. The review stays mounted in secondary;
  // openPrReviewChat reveals the conversation and restores the split geometry.
  async function openChat() {
    if (!pr || openingChat) return;
    openingChat = true;
    try {
      // Reveal a blocked conversation first. Checkout preparation can fetch and
      // create a worktree, so making the pane wait for it makes the click feel
      // broken even though useful progress is under way.
      activeChatTabId = await session.openPrReviewChat(pr, {
        existingTabId: activeChatTabId,
        projectCtx: projectCtx(),
        serverId,
      });
      const sourceContext = await review.ensureCheckout();
      await session.openPrReviewChat(sourceContext, {
        existingTabId: activeChatTabId,
        projectCtx: projectCtx(),
        serverId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeChatTabId) {
        session.failPrReviewChatCheckout(activeChatTabId, pr.number, message);
      }
      toasts.error("Couldn't open review chat", { description: message });
    } finally {
      openingChat = false;
    }
    requestInputFocus();
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

  // Where this review sits in the list order the PRs page publishes — the same
  // rows, in the same order, as the list it was opened from.
  const listOrder = $derived(session.prsStore.listOrder);
  const queuePosition = $derived(listOrder.indexOf(target.number) + 1);

  // Built from the review context rather than `target`, whose host/owner/repo
  // are only populated once detail lands — the Activity tab owns the link that
  // covers the pending phase.
  const prUrl = $derived(
    pr ? `https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}` : null,
  );

  function openPr() {
    if (prUrl) void localApi.openExternal(prUrl);
  }

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
  const summary = $derived(session.prsStore.get(target.number));
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
    headRef={pr?.headRef ?? summary?.headRef}
    baseRef={pr?.baseRef ?? summary?.baseRef}
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

{#snippet checksChip()}
  <PrChecksChip
    summary={session.prsStore.checksFor(serverId, prCtx(), target.number)}
    headSha={pr?.headSha ?? target.headSha ?? ""}
    loadFailed={session.prsStore.checksLoadFailedFor(serverId, prCtx())}
    pill
  />
{/snippet}

{#snippet refreshButton()}
  <Button
    type="button"
    variant="ghost"
    class="flex size-[26px] shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground"
    onclick={refreshPr}
    disabled={refreshingPr}
    aria-label={refreshingPr ? "Refreshing pull request" : "Refresh pull request"}
    aria-busy={refreshingPr}
    title={refreshingPr ? "Refreshing pull request…" : "Refresh pull request"}
  >
    <ArrowsClockwiseIcon
      size={13}
      class={refreshingPr ? "animate-spin [animation-duration:0.9s]" : ""}
    />
  </Button>
{/snippet}

<!-- The same pill the document and work headers use to reach Solus: one filled,
     rounded-full surface, so "ask Solus about the thing you are looking at" is
     the same object wherever you meet it. -->
{#snippet chatButton()}
  <Button
    type="button"
    class="ml-[5px] h-7 shrink-0 gap-[0.4375rem] rounded-full border-0 bg-(--solus-accent) px-[0.6875rem] text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-colors hover:bg-[color-mix(in_srgb,var(--solus-accent)_88%,black)] disabled:opacity-50"
    onclick={openChat}
    disabled={openingChat || !pr}
    aria-label="Ask Solus"
    title={openingChat
      ? "Preparing checkout…"
      : activeChatTabId
        ? "Focus the Solus chat about this pull request"
        : "Ask Solus about this pull request"}
  >
    <SparkleIcon size={12} weight="fill" />
    Ask Solus
  </Button>
{/snippet}

<section class="flex h-full min-h-0 flex-col bg-background">
  {#if embedded}
    <PrPanelHeader
      number={target.number}
      headRef={pr?.headRef ?? summary?.headRef}
      baseRef={pr?.baseRef ?? summary?.baseRef}
      position={queuePosition}
      total={listOrder.length}
      {fullScreen}
      {onToggleFullScreen}
      onStep={step}
      onClose={exit}
      tabs={panelTabs}
    >
      {#snippet actions()}
        {@render refreshButton()}
        {@render checksChip()}
        {@render chatButton()}
      {/snippet}
    </PrPanelHeader>
  {:else if !headless}
    <!-- One chrome band: the way back, the way sideways, and where you are.
         The tabs have moved down into the masthead where they belong to the
         content; what stays up here is navigation and the pane controls that
         PaneChrome floats for every other surface, consolidated so this review
         reads as a single header row.
         No rule beneath it, and no centred measure: the bar spans the pane's
         full width with the same leading gutter as the diff toolbar while the
         trailing controls reach the pane's right edge. -->
    <!-- Same height and seam as every other chrome row in the app (the diff
         toolbar beside it, the conversation's own strip), so the two panes'
         headers share one baseline. -->
    <div
      class="workspace-titlebar @container h-(--solus-chrome-row-h,2.5rem) shrink-0 border-b border-[var(--hairline)]"
    >
      <div
        class="flex h-full w-full items-center justify-between gap-2 pr-3.5 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))]"
      >
        <div class="flex min-w-0 flex-1 items-center">
          <PrDetailChrome number={target.number} {serverId} {projectCtx} onExit={exit} />
        </div>

        <!-- Pane controls, pill-shaped and quiet: the band's only ink is the
             breadcrumb, so these read as affordances rather than a toolbar. -->
        <div class="flex shrink-0 items-center gap-0.5">
          {@render refreshButton()}
          {@render checksChip()}
          {@render chatButton()}

          {#if sub === "guide" && !showingFullDiff}
            <Button
              type="button"
              variant="ghost"
              class="flex size-[26px] shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground"
              aria-label="Regenerate review guide"
              title="Regenerate review"
              onclick={regenerateGuide}
            >
              <ArrowsClockwiseIcon size={13} />
            </Button>
          {/if}

          <FrameExpandButton variant="projectPanel" size="header" />

          {#if onToggleMaximize}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground"
                    onclick={onToggleMaximize}
                    aria-label={maximized
                      ? "Restore panel size"
                      : "Maximize panel"}
                  >
                    {#if maximized}
                      <ArrowsInIcon size={13} />
                    {:else}
                      <ArrowsOutIcon size={13} />
                    {/if}
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content
                value={maximized ? "Restore panel (⌥M)" : "Maximize (⌥M)"}
              />
            </TooltipUI.Root>
          {/if}

          <!-- Esc lives on the control it fires rather than in a legend along
               the bottom of the pane. -->
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground"
                  onclick={exit}
                  aria-label="Back to list"
                >
                  <XIcon size={13} />
                </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value="Back to list (Esc)" />
          </TooltipUI.Root>
        </div>
      </div>
    </div>
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
              <p class="text-[0.8125rem] font-medium">
                Guide skipped for this quick review
              </p>
              <p
                class="mt-1.5 text-pretty text-[0.8125rem] leading-[1.6] text-muted-foreground"
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
              class="mx-auto w-full max-w-[92rem] pt-[clamp(20px,1.8vw,32px)] pr-8 pl-14 2xl:max-w-[104rem]"
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
            class="mx-auto w-full max-w-[92rem] pt-[clamp(20px,1.8vw,32px)] pr-8 pl-14 2xl:max-w-[104rem]"
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
        {#if commitScope}
          <CommitDiffBanner commit={commitScope} onClear={clearCommitScope} />
        {:else if ownDeltaBase}
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
            getCtx={prCtx}
            {getApi}
            projectPath={checkout?.worktreePath ?? projectCtx().session.projectPath ?? projectCtx().session.workingDirectory}
            worktreePath={checkout?.worktreePath}
            worktreeBranch={pr.headRef}
            targetBranch={pr.baseRef}
            isWorktree={!!checkout}
            onClose={() => select(showingFullDiff ? "activity" : "guide")}
            embedded
            hasHostHeaderRow={!headless}
            {onToggleMaximize}
            initialScope={diffScope}
            commentingDisabled={!!commitScope}
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
          getCtx={prCtx}
          {getApi}
          {serverId}
          showIdentity={!embedded}
          addressCommentsReady={!!pr && review.checkoutStatus !== "preparing"}
          onAddressComments={async () => {
            if (!pr) return;
            try {
              await session.startPrCommentsFixSession(await review.ensureCheckout());
            } catch (error) {
              toasts.error(error instanceof Error ? error.message : String(error));
            }
          }}
          onGenerateGuide={generateGuide}
          onRefreshThreads={() => loadThreads(true)}
          onDetailChanged={(detail) => (reviewDetail = detail)}
          {onRefreshTarget}
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
    getCtx={prCtx}
    {getApi}
    allowedVerdicts={reviewDetail?.viewerPermissions.reviewVerdicts ?? ["comment"]}
    bind:event={submitEvent}
    bind:body={submitBody}
    onClose={() => (showSubmit = false)}
    onSubmitted={onReviewSubmitted}
    onSendToFixAgent={async (feedback) => {
      await session.startPrCommentsFixSession(await review.ensureCheckout(), feedback);
    }}
  />
{/if}
