<script lang="ts">
  import { tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import {
    RefreshCw as ArrowsClockwiseIcon,
    GitPullRequest as GitPullRequestIcon,
    ArrowUp as ArrowUpIcon,
    Pen as PencilSimpleIcon,
    SlidersHorizontal as PropertiesIcon,
  } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { BottomSheet } from "../ui/bottom-sheet";
  import { CommentPostingBar } from "../ui/comment-posting-bar";
  import DocumentEditor from "../editor/DocumentEditor.svelte";
  import { projectScopeOf, type ChangedFileStat, type IpcContext } from "@solus/contracts/types";
  import type {
    ReviewThread,
    ReviewComment,
    PullRequest,
    PrCommit,
    PrConversationItem,
    PrLifecycleAction,
    PrReviewer,
    PrReviewerCandidate,
  } from "@solus/contracts/providers";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { localApi } from "@solus/client-core/local-api";
  import type { HostApi } from "@solus/client-core/host-api";
  import type { CheckItem } from "@solus/contracts/checks-types";
  import type { PrGuideStatus } from "@solus/contracts/review";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { changedFileTotals } from "../../lib/diff-stats";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { githubMarkdownExtensions } from "../../lib/githubMarkdown";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Skeleton } from "../ui/skeleton";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import type { ActivityFilter, PrActivityTarget } from "./lib/activity-data";
  import {
    buildActivityTimeline,
    filterActivityTimeline,
  } from "./lib/activity-data";
  import PrActivityRail from "./PrActivityRail.svelte";
  import PrMergeBar from "./PrMergeBar.svelte";
  import { observeContainerWidth } from "../../lib/pane-width";
  import { isRailFolded } from "./lib/rail-rows";
  import ActivityTimeline from "./ActivityTimeline.svelte";
  import PrActions from "./PrActions.svelte";
  import PrOverflowMenu from "./PrOverflowMenu.svelte";
  import PrStatusChip from "./PrStatusChip.svelte";
  import PrMetaBand from "./PrMetaBand.svelte";
  import GithubConnectionRequired from "../prs/GithubConnectionRequired.svelte";
  import { prSurfaceError, type PrSurfaceError } from "../prs/lib/pr-surface-error";

  // The Activity tab: a Linear-style PR overview. The centered main column shows
  // the title, author/branch meta, the PR description, and an activity timeline
  // (open event + existing GitHub review threads, each still repliable /
  // resolvable — see PrThreadCard). The right rail (PrActivityRail) summarises
  // status, reviewers, and the changed files. Pending local drafts live in the
  // submit tray, not here.
  let {
    pr,
    status,
    threads,
    threadsFailed = false,
    stackChain = [],
    showRemoteLink = false,
    addressCommentsReady = true,
    onAddressComments,
    onFixCheck,
    onGenerateGuide,
    generationStatus,
    onChat,
    onJump,
    onOpenCommit,
    onRefreshThreads,
    onRefreshTarget,
    getCtx,
    getApi,
    serverId,
    masthead,
    showIdentity = true,
  }: {
    pr: PrActivityTarget;
    /** The list's own group key, so the subtitle chip agrees with the row the
     *  review was opened from. */
    status: string;
    /** Review threads, owned by the parent so the Diff tab and this timeline
     *  share one fetch (and one set of objects — reply/resolve mutate in place). */
    threads: ReviewThread[];
    /** The parent's thread fetch failed — folded into this tab's error banner. */
    threadsFailed?: boolean;
    /** Ordered PR numbers in this stack. The current PR is highlighted. */
    stackChain?: number[];
    /** Render the Activity header's remote PR shortcut for embedded previews. */
    showRemoteLink?: boolean;
    /** The host has a checked-out PR worktree ready for the fix session. */
    addressCommentsReady?: boolean;
    onAddressComments?: () => Promise<void>;
    /** Prepare the PR checkout and hand one failing check to a fix session. */
    onFixCheck?: (check: CheckItem) => Promise<void>;
    onGenerateGuide?: () => void;
    /** Immediate parent-owned state while the PR checkout is being prepared.
     *  The durable store takes over as soon as the request is queued. */
    generationStatus?: PrGuideStatus;
    onChat?: () => void;
    /** Jump to a thread's / file's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    /** Open the diff scoped to one commit's changes. */
    onOpenCommit?: (commit: PrCommit) => void;
    /** Refetch the shared threads (e.g. from this tab's Refresh button). */
    onRefreshThreads?: () => void;
    /** Refresh the exact host revision owned by the route. */
    onRefreshTarget?: () => Promise<void>;
    /** Context override for hosts reviewing a PR outside the active tab's
     *  project (the PRs page's project switcher, embedded review panes).
     *  Defaults to the active tab's context. */
    getCtx?: () => IpcContext;
    getApi: () => HostApi;
    serverId: string;
    /** The shared detail masthead — refs and the content tabs.
     *  Rendered by the host above this tab's title so the same row appears
     *  whichever tab is showing. */
    masthead?: import("svelte").Snippet;
    /** Show the PR icon and number above the title when no surface header owns them. */
    showIdentity?: boolean;
  } = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const feedCtx = (): IpcContext => getCtx?.() ?? session.ctx;
  /** The pull request this feed is showing, as something that can be asked and
   *  acted on. Built per call because the context can move under the feed. */
  const pullRequest = (number: number) =>
    pullRequests.projects.get(getApi(), serverId, feedCtx()).get(number);

  // The store's index, not a copy kept here. It already receives every detail
  // this tab produces — the optimistic value, the confirmed one, and the
  // rollback all go through `applyDetail` below — and `PrsStore` owns the
  // `pr.lifecycleChanged` subscription for the whole workspace, so a merge
  // landing anywhere reaches this feed without a second listener.
  const detail = $derived(
    pullRequests.projects.at(serverId, projectScopeOf(feedCtx().session))?.prFor(pr.number) ?? null,
  );
  let commits = $state<PrCommit[]>([]);
  let comments = $state<PrConversationItem[]>([]);
  let reviewers = $state<PrReviewer[]>([]);
  let reviewerCandidates = $state<PrReviewerCandidate[]>([]);
  let changedFiles = $state<ChangedFileStat[]>([]);
  // Per-section loading so each region fills in as its own request resolves,
  // rather than the whole tab waiting on the slowest call. Threads come from the
  // parent (no flag here); the opened event + composer render immediately.
  let detailLoading = $state(true);
  let commitsLoading = $state(true);
  let commentsLoading = $state(true);
  let reviewersLoading = $state(true);
  let reviewerCandidatesLoading = $state(false);
  let reviewerMutation = $state<string | null>(null);
  let filesLoading = $state(true);
  // Any provider load rejecting (expired token, network) flips this so the
  // tab shows an explicit error + retry instead of masquerading as an empty PR.
  let loadFailed = $state(false);
  let loadError = $state<PrSurfaceError | null>(null);
  const anyLoadFailed = $derived(loadFailed || threadsFailed);

  let composer = $state("");
  let posting = $state(false);
  let scrollViewport = $state<HTMLElement | null>(null);

  // When the rail folds under the reading column it takes merge readiness past
  // every comment on the pull request, so the bar below takes it back out. That
  // trade is only sound if the two fire together, which means reading the same
  // number off the same box: the content row is the `@container` the rail's
  // rung is resolved against, and a container query measures its content box.
  // The row's own border box would be 104px wider, which is a whole band of
  // pane widths with a folded rail and no bar.
  let contentRowEl = $state<HTMLElement | null>(null);
  let contentRowWidth = $state(0);
  $effect(() => {
    if (!contentRowEl) return;
    return observeContainerWidth(contentRowEl, (width) => (contentRowWidth = width));
  });
  const railFolded = $derived(isRailFolded(contentRowWidth));
  /** Whether the sheet holding the rail is open. It is only ever reachable
   *  while folded, and the `{#if railFolded && railOpen}` guard closes it on
   *  its own when the pane widens and the rail takes its column back. */
  let railOpen = $state(false);
  let deletingCommentIds = $state(new SvelteSet<string>());
  let editing = $state(false);
  let titleDraft = $state("");
  let bodyDraft = $state("");
  let descriptionEditor = $state<DocumentEditor | null>(null);
  let saving = $state(false);
  let titleInput = $state<HTMLInputElement | null>(null);
  let addressingComments = $state(false);
  let fixingCheckId = $state<string | null>(null);
  // The provider token's login — who a posted comment will belong to. Empty
  // until the (cached) lookup resolves or when it fails; the avatar then shows
  // a neutral "?" rather than guessing an identity.
  let viewerLogin = $state("");

  // Timeline focus: one quiet header control. `unresolvedOnly` and `filter`
  // are mutually exclusive — selecting either clears the other.
  let filter = $state<ActivityFilter>("all");
  let unresolvedOnly = $state(false);

  const filterChips: { value: ActivityFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "conversation", label: "Conversation" },
    { value: "commits", label: "Commits" },
  ];

  function setFilter(next: ActivityFilter) {
    filter = next;
    unresolvedOnly = false;
    requestInputFocus();
  }

  function toggleUnresolved() {
    unresolvedOnly = !unresolvedOnly;
    if (unresolvedOnly) filter = "all";
    requestInputFocus();
  }

  const openedAt = $derived(detail ? new Date(detail.createdAt).getTime() : null);
  const openedTime = $derived(
    openedAt ? formatTimeAgoFromTimestamp(openedAt) : null,
  );
  // A PR opened by number alone (deep link, `#123` in a message) carries no
  // title until detail lands — hold the masthead's space instead of letting the
  // heading collapse and shove everything below it up a line.
  const prTitle = $derived(detail?.title || pr.title || "");
  const authorName = $derived(detail?.author ?? pr.owner ?? "");
  const authorAvatarUrl = $derived(
    detail?.authorAvatarUrl ?? pr.authorAvatarUrl ?? "",
  );
  // Providers only hand us avatar images per PR author, so reuse that image
  // when the viewer authored this PR (the common Solus case); otherwise the
  // login's initials disc.
  const viewerAvatarUrl = $derived(
    viewerLogin && viewerLogin === authorName ? authorAvatarUrl : "",
  );
  // Size of the change, stated once under the title in the meta band. The rail
  // lists the files; the band only says how big a read this is.
  const diffStat = $derived(changedFileTotals(changedFiles));

  const baseRef = $derived(pr.baseRef ?? detail?.baseRef ?? "");
  const headBranch = $derived(pr.headRef ?? detail?.headRef ?? "");
  // The pull request names its own host page, so prefer it. The checkout
  // identity is only a fallback for the moment before the store has answered.
  // The pull request names its own host page. Null until the store has one,
  // which hides the link for the frame before the read lands rather than
  // offering a URL Solus guessed.
  const prUrl = $derived(detail?.url ?? null);
  // Commits, review threads, and the durable PR conversation, merged into one
  // chronological timeline (see buildActivityTimeline). The opened event is
  // rendered separately as the fixed first row and always leads.
  const timeline = $derived(buildActivityTimeline(commits, threads, comments));
  const visibleTimeline = $derived(
    filterActivityTimeline(timeline, filter, unresolvedOnly),
  );
  const timelineFiltered = $derived(filter !== "all" || unresolvedOnly);
  // Ghost rows until both interleaved sources are in — threads pop in from the
  // parent whenever its fetch lands (no flag), matching the previous behavior.
  const timelineLoading = $derived(commitsLoading || commentsLoading);
  const checks = $derived(pullRequests.checks.summaryFor(serverId, feedCtx(), pr.number));
  const guideStatus = $derived(
    generationStatus ??
      pullRequests.guides.statusFor(serverId, feedCtx(), pr.number),
  );
  const unresolvedCount = $derived(
    threads.reduce((count, thread) => count + (thread.isResolved ? 0 : 1), 0),
  );
  const feedbackCount = $derived(
    unresolvedCount + comments.reduce((count, item) => count + (item.body.trim() ? 1 : 0), 0),
  );

  function markLoadFailed(n: number, error: Parameters<typeof prSurfaceError>[0]) {
    if (pr.number !== n) return;
    loadFailed = true;
    const mapped = prSurfaceError(error);
    if (mapped.kind === "github-auth" || !loadError) loadError = mapped;
  }

  // Fire each request independently and let its section fill in on resolve — no
  // shared gate, so a slow call (threads, the change set) never holds back the
  // fast ones. `n` guards against a PR switch mid-flight clobbering newer data.
  // Anything the review surface already prefetched is seeded synchronously, so
  // a warm open paints the finished page on its first frame rather than showing
  // a skeleton for the microtask it takes the cached promises to resolve.
  function load(force = false) {
    const n = pr.number;
    const cached = force ? {} : pullRequest(n).cachedActivity();
    commits = cached.commits ?? [];
    comments = cached.comments ?? [];
    reviewers = cached.reviewers ?? [];
    changedFiles = cached.changedFiles ?? [];
    loadFailed = false;
    loadError = null;
    filter = "all";
    unresolvedOnly = false;
    // A forced reload re-reads even when the index already holds a detail, so
    // the section says it is working rather than showing the previous head.
    detailLoading = force || !pullRequests.projects.at(serverId, projectScopeOf(feedCtx().session))?.prFor(n);
    commitsLoading = !cached.commits;
    commentsLoading = !cached.comments;
    reviewersLoading = !cached.reviewers;
    filesLoading = !cached.changedFiles;

    // Not PR-scoped (and cached per project) — best-effort, never an error.
    pullRequests.projects
      .get(getApi(), serverId, feedCtx())
      .loadViewer()
      .then((login) => (viewerLogin = login))
      .catch(() => {});
    pullRequest(n)
      .loadDetail({ force })
      .then((d) => {
        if (pr.number !== n) return;
        if (
          d.capabilities.reviewerCandidates &&
          d.viewerPermissions.requestReviewers
        ) {
          loadReviewerCandidates(n, force);
        } else {
          reviewerCandidates = [];
        }
      })
      .catch((error) => {
        markLoadFailed(n, error);
      })
      .finally(() => {
        if (pr.number === n) detailLoading = false;
      });
    pullRequest(n)
      .loadCommits({ force })
      .then((c) => {
        if (pr.number === n) {
          commits = c;
        }
      })
      .catch((error) => markLoadFailed(n, error))
      .finally(() => {
        if (pr.number === n) commitsLoading = false;
      });
    pullRequest(n)
      .loadComments({ force })
      .then((c) => {
        if (pr.number === n) {
          comments = c;
        }
      })
      .catch((error) => markLoadFailed(n, error))
      .finally(() => {
        if (pr.number === n) commentsLoading = false;
      });
    pullRequest(n)
      .loadReviewers({ force })
      .then((r) => {
        if (pr.number === n) {
          reviewers = r;
        }
      })
      .catch((error) => markLoadFailed(n, error))
      .finally(() => {
        if (pr.number === n) reviewersLoading = false;
      });
    loadChangedFiles(n, force);
  }

  function loadReviewerCandidates(n: number, force = false) {
    reviewerCandidatesLoading = true;
    pullRequest(n)
      .loadReviewerCandidates({ force })
      .then((candidates) => {
        if (pr.number === n) reviewerCandidates = candidates;
      })
      .catch((error) => markLoadFailed(n, error))
      .finally(() => {
        if (pr.number === n) reviewerCandidatesLoading = false;
      });
  }

  async function requestReviewer(login: string): Promise<void> {
    if (reviewerMutation) return;
    reviewerMutation = login;
    try {
      reviewers = await pullRequest(pr.number).requestReviewers([login]);
      toasts.success(`Requested a review from ${login}`);
    } catch (error) {
      toasts.error("Couldn't request the reviewer", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reviewerMutation = null;
      requestInputFocus();
    }
  }

  async function removeReviewer(login: string): Promise<void> {
    if (reviewerMutation) return;
    reviewerMutation = login;
    try {
      reviewers = await pullRequest(pr.number).removeRequestedReviewer(login);
      toasts.success(`Removed ${login} from requested reviewers`);
    } catch (error) {
      toasts.error("Couldn't remove the reviewer", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reviewerMutation = null;
      requestInputFocus();
    }
  }

  function loadChangedFiles(n: number, force = false) {
    pullRequest(n)
      .loadChangedFiles({ force })
      .then((f) => {
        if (pr.number === n) {
          changedFiles = f;
        }
      })
      .catch((error) => {
        markLoadFailed(n, error);
      })
      .finally(() => {
        if (pr.number === n) filesLoading = false;
      });
  }

  // The Refresh button reloads this tab's data and the parent-owned threads.
  // Exported so the host can force a reload after submitting a review.
  export async function refresh(): Promise<void> {
    load(true);
    onRefreshThreads?.();
    const targetRefresh = onRefreshTarget?.();
    if (targetRefresh) {
      await targetRefresh.catch((error) => markLoadFailed(pr.number, error));
    }
  }

  async function updateLifecycle(
    action: Exclude<PrLifecycleAction, "merge">,
  ): Promise<void> {
    if (!detail) return;
    const previous = detail;
    const optimistic: PullRequest = { ...previous };
    if (action === "close") optimistic.state = "closed";
    if (action === "reopen") optimistic.state = "open";
    if (action === "ready") optimistic.draft = false;
    if (action === "draft") optimistic.draft = true;
    // The optimistic value goes to the store, which every surface reads — so
    // the whole workspace shows the pending state, not just this tab.
    pullRequests.projects
      .at(serverId, projectScopeOf(feedCtx().session))
      ?.applyPullRequest(optimistic);
    try {
      // `updateLifecycle` applies the confirmed detail to the store itself.
      await pullRequest(pr.number).updateLifecycle(action, previous.headSha);
    } catch (error) {
      // A newer provider event wins over this rollback. The lifecycle this
      // action wrote is its mutation token: the store holds one pull request
      // rather than a succession of copies, so if either field has moved since,
      // something else wrote it and this rollback is not its business.
      const current = pullRequests.projects.at(serverId, projectScopeOf(feedCtx().session))?.prFor(
        pr.number,
      );
      if (current?.state === optimistic.state && current.draft === optimistic.draft) {
        pullRequests.projects
          .at(serverId, projectScopeOf(feedCtx().session))
          ?.applyPullRequest(previous);
      }
      throw error;
    }
  }

  $effect(() => {
    void pr.number;
    untrack(() => load());
  });

  // Reply / resolve state lives in each PrThreadCard; the feed only supplies
  // the RPCs bound to this PR.
  function replyToThread(threadId: string, body: string): Promise<ReviewComment> {
    return pullRequest(pr.number).replyToThread(threadId, body);
  }

  function resolveThread(threadId: string, resolved: boolean): Promise<void> {
    return pullRequest(pr.number).setThreadResolved(threadId, resolved);
  }

  async function postComment(body: string) {
    if (posting) return;
    posting = true;
    let commentCreated = false;
    try {
      const n = pr.number;
      await pullRequest(n).addComment(body);
      commentCreated = true;
      composer = "";
      // Refetch rather than inventing an optimistic author/id; the server copy
      // is the source of truth and survives a reload. Posting already dropped
      // the mirrored list, so this asks the host without forcing.
      const serverComments = await pullRequest(n).loadComments();
      if (pr.number === n) {
        comments = serverComments;
        filter = "all";
        unresolvedOnly = false;
        await tick();
        scrollViewport?.scrollTo({ top: scrollViewport.scrollHeight });
      }
    } catch (err) {
      toasts.error(
        commentCreated
          ? `Comment posted, but activity couldn't refresh: ${err instanceof Error ? err.message : String(err)}`
          : `Couldn't post comment: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      posting = false;
      requestInputFocus();
    }
  }

  async function deleteComment(commentId: string) {
    if (deletingCommentIds.has(commentId)) return;
    deletingCommentIds.add(commentId);
    try {
      const n = pr.number;
      await pullRequest(n).deleteComment(commentId);
      const serverComments = await pullRequest(n).loadComments();
      if (pr.number === n) comments = serverComments;
    } catch (err) {
      toasts.error("Couldn't delete comment", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      deletingCommentIds.delete(commentId);
    }
  }

  async function beginEditing() {
    if (!detail) return;
    titleDraft = prTitle;
    bodyDraft = detail.body;
    editing = true;
    await tick();
    titleInput?.focus();
    titleInput?.select();
  }

  function cancelEditing() {
    editing = false;
    requestInputFocus();
  }

  async function savePullRequest() {
    const title = titleDraft.trim();
    if (!detail || !title || saving) return;
    const body = descriptionEditor?.getCurrentMarkdown() ?? bodyDraft;
    saving = true;
    try {
      // `update` applies the returned detail to the store index that
      // `detail` above reads, so there is nothing to assign here.
      await pullRequest(pr.number).update({ title, body });
      editing = false;
      toasts.success("Pull request updated");
    } catch (err) {
      toasts.error("Couldn't update pull request", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      saving = false;
      requestInputFocus();
    }
  }

  async function addressComments() {
    if (!onAddressComments || !addressCommentsReady || addressingComments) return;
    addressingComments = true;
    try {
      await onAddressComments();
    } catch (err) {
      toasts.error("Couldn't open the fix agent", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      addressingComments = false;
      requestInputFocus();
    }
  }

  async function fixCheck(check: CheckItem) {
    if (!onFixCheck || fixingCheckId) return;
    fixingCheckId = check.id;
    try {
      await onFixCheck(check);
    } catch (err) {
      toasts.error("Couldn't open the fix agent", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      fixingCheckId = null;
      requestInputFocus();
    }
  }

  function jumpToFile(path: string, line: number | null = null) {
    onJump?.(path, line);
    requestInputFocus();
  }

  function openPr() {
    if (!prUrl) return;
    void localApi.openExternal(prUrl);
    requestInputFocus();
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
<div bind:this={scrollViewport} class="min-h-0 flex-1 overflow-y-auto bg-background">
    {#if anyLoadFailed}
      <div
        class="mx-auto w-full max-w-[1216px] px-[52px] pt-4 [.is-laptop-display_&]:px-8"
      >
        <div
          class="flex items-center gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-3 text-workspace-chrome"
          role="alert"
        >
          {#if loadError?.kind === "github-auth"}
            <GithubConnectionRequired {serverId} />
          {:else}
            <span class="min-w-0 flex-1 truncate">
              Couldn't load some of this pull request's data. Check your connection or provider sign-in.
            </span>
            <Button
              type="button"
              variant="ghost"
              class="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
              onclick={refresh}
            >
              <ArrowsClockwiseIcon size={12} class="shrink-0" />
              Retry
            </Button>
          {/if}
        </div>
      </div>
    {/if}
    {#if masthead}
      <!-- Same centred measure and gutters as the content row below, so the
           status pill and the tabs line up with the title and the right rail
           instead of floating out at the pane's edges on wide windows. -->
      <div
        class="mx-auto w-full max-w-[1216px] px-[52px] pt-[38px] [.is-laptop-display_&]:px-8 [.is-laptop-display_&]:pt-6"
      >
        {@render masthead()}
      </div>
    {/if}
    <!-- Capped measure: on wide windows the column centers instead of the
         title and a sparse timeline stretching toward a distant rail. The row
         is the size container the rail queries, so the rail folds under the
         main column on narrow panes instead of disappearing.
         768 + 56 + 330 is the shell's whole budget, so the reading column keeps
         a book measure at every width rather than growing until the rail is a
         long way from the text it annotates. -->
    <div
      bind:this={contentRowEl}
      class="@container mx-auto flex w-full max-w-[1216px] flex-wrap items-start gap-14 px-[52px] {masthead
        ? 'pt-3.5'
        : 'pt-[38px]'} pb-24 [.is-laptop-display_&]:gap-10 [.is-laptop-display_&]:px-8 [.is-laptop-display_&]:pb-16 {masthead
        ? ''
        : '[.is-laptop-display_&]:pt-6'}"
    >
      <!-- ── Main column: title, meta, description, activity, composer ── -->
      <main class="flex min-w-0 max-w-[768px] flex-[1_1_520px] flex-col">
        <!-- Masthead, Linear-style: no chrome in the header at all — a quiet
             mono eyebrow, the title at full measure, one line of plain-text
             facts. Actions live with the merge-readiness status in the right
             rail (prActions below), which folds under this column rather than
             hiding, so they are reachable at every width. -->
        <header>
          {#if showIdentity && !masthead}
            <p
              class="flex items-center gap-2 text-xs st text-muted-foreground uppercase"
            >
              <!-- Identity, not state — the row below carries the state, and a
                   tinted mark up here read as a second one. -->
              <GitPullRequestIcon size={10} class="shrink-0" />
              <span class="min-w-0 truncate"
                >{pr.repo ? `${pr.repo} ` : ""}#{pr.number}</span
              >
            </p>
          {/if}

          <!-- Who and what state, above the title rather than under it: they
               qualify the title, and a reader who has already read the sentence
               should not have to come back up for the one fact that changes how
               it lands. The refs and the counts have moved into the band below,
               so this row stays one line at every width. -->
          <div
            class="{showIdentity && !masthead
              ? 'mt-3'
              : ''} flex flex-wrap items-center gap-x-[9px] gap-y-2 text-review-meta text-muted-foreground"
          >
            <PrStatusChip {status} />
            <span class="flex min-w-0 items-center gap-[7px]">
              <PrAvatar
                name={authorName}
                url={authorAvatarUrl}
                size="size-[18px]"
              />
              <span class="truncate font-medium text-foreground">{authorName}</span>
              {#if openedTime}
                <span class="shrink-0">opened {openedTime}</span>
              {/if}
            </span>
            {#if stackChain.length > 1}
              <span class="opacity-40" aria-hidden="true">·</span>
              <span
                class="flex items-center gap-1.5 tabular-nums"
                aria-label={`Stack containing PR #${pr.number}`}
              >
                <span class="font-medium">Stack</span>
                {#each stackChain as number, i (number)}
                  {#if i > 0}<span class="opacity-40" aria-hidden="true">→</span
                    >{/if}
                  <span
                    class={number === pr.number
                      ? "font-medium text-primary"
                      : "text-foreground"}
                  >#{number}</span>
                {/each}
              </span>
            {/if}
            {#if detail && !editing}
              <span class="flex-1"></span>
              <Button
                type="button"
                variant="ghost"
                class="h-7 cursor-pointer gap-1.5 rounded-lg px-2.5 text-review-meta text-muted-foreground hover:text-foreground"
                title="Edit pull request title and description"
                onclick={beginEditing}
              >
                <PencilSimpleIcon size={12} />
                Edit
              </Button>
            {/if}
          </div>

          {#if editing}
            <Input
              bind:this={titleInput}
              bind:value={titleDraft}
              class="mt-3.5 h-auto w-full rounded-none border-0 bg-transparent! p-0 text-[29px] leading-[1.22] font-semibold tracking-[-0.023em] outline-none shadow-none focus-visible:ring-0 dark:bg-transparent! [.is-laptop-display_&]:text-2xl"
              aria-label="Pull request title"
              onkeydown={(event) => {
                if (event.key === "Escape") cancelEditing();
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void savePullRequest();
                }
              }}
            />
          {:else if prTitle}
            <!-- The sentence the whole page is about, so it is the one thing on
                 it set tight and heavy. Let it use the main column's reading
                 measure; an extra character-based cap makes ordinary PR titles
                 wrap while useful column width remains empty. -->
            <!-- 29px, not the stock 24px rung: the meta band and the rail
                 around it now sit at the review's 12.5px row, and at 24px the
                 title was only twice its own caption — near enough that the
                 page read as one flat block rather than a sentence with
                 supporting facts under it. -->
            <h1
              class="mt-3.5 text-[29px] leading-[1.22] font-semibold tracking-[-0.023em] text-pretty [.is-laptop-display_&]:text-2xl"
            >
              {prTitle}
            </h1>
          {:else}
            <Skeleton
              class="mt-3.5 h-[31px] w-2/3 max-w-[560px] rounded-lg bg-muted"
            />
          {/if}

          <!-- The facts about the change — refs, files, churn — labelled and
               ruled rather than run together in a subtitle. -->
          <PrMetaBand
            {headBranch}
            {baseRef}
            fileCount={changedFiles.length}
            {filesLoading}
            additions={diffStat.additions}
            deletions={diffStat.deletions}
          />
        </header>

        <!-- PR description belongs to the PR header, not the activity stream. -->
        {#if editing}
          <div class="mt-8">
            <DocumentEditor
              bind:this={descriptionEditor}
              value={bodyDraft}
              onValueChange={(markdown) => (bodyDraft = markdown)}
              placeholder="Describe this pull request…"
              dictation
              dragHandle={false}
              class="pr-description-editor prose-pr prose-pr-description"
              style="max-height:26.25rem;overflow-y:auto"
            />
            <div class="mt-3 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                class="h-8 cursor-pointer rounded-lg px-3 text-sm text-muted-foreground"
                onclick={cancelEditing}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={saving || !titleDraft.trim()}
                class="h-8 cursor-pointer rounded-lg px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                onclick={savePullRequest}
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        {:else if detailLoading}
          <div class="mt-8 flex flex-col gap-2.5">
            <Skeleton class="h-3 w-full rounded bg-muted" />
            <Skeleton class="h-3 w-11/12 rounded bg-muted" />
            <Skeleton class="h-3 w-3/4 rounded bg-muted" />
          </div>
        {:else if detail?.body?.trim()}
          <!-- No rule under the masthead: the spacing steps (4 → 8) already
               close the title block, and a hairline here would be the only one
               above the timeline's spine. -->
          <!-- Typography lives in `.prose-pr` (index.css), not in utilities
               here: the `.prose-cloud` rules are unlayered, so a utility
               override of any property they set — size, leading, colour,
               heading margins — loses the cascade regardless of order.
               `.prose-pr-description` adds only the measure. -->
          <section
            class="github-markdown prose-cloud prose-pr prose-pr-description mt-8"
            aria-label="Pull request description"
          >
            <SvelteMarkdown
              source={detail.body}
              extensions={githubMarkdownExtensions}
              renderers={githubMarkdownRenderers}
              sanitizeUrl={remoteMarkdownSanitizeUrl}
            />
          </section>
        {/if}

        <!-- Activity timeline: an editorial rail — no cards; a continuous
             hairline spine with icon nodes, content set directly on the canvas
             with airy spacing. Commits, review threads, and the durable
             conversation interleave by time (see buildActivityTimeline); the
             opened event always leads. -->
        <div class="mt-10 mb-4 flex items-center gap-2">
          <h2
            class="text-xs font-medium st text-muted-foreground uppercase"
          >
            Activity
          </h2>
          <span class="flex-1"></span>
          <!-- Quiet focus chips: filter the timeline without leaving the tab.
               A couple of events don't need filtering, so the chips only appear
               once the timeline is long enough for them to earn their spot; the
               unresolved toggle is a real signal and always shows. The
               mutually-exclusive set shares a recessed track (the page's
               segmented form) so the selected chip lifts onto the canvas; the
               unresolved toggle stands outside it as its own state. -->
          <div
            class="flex items-center gap-1.5"
            role="group"
            aria-label="Filter activity"
          >
            {#if timeline.length > 3}
              <div class="flex h-7 items-center gap-0.5 rounded-lg bg-muted p-0.5">
                {#each filterChips as chip (chip.value)}
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={!unresolvedOnly && filter === chip.value}
                    class="h-full cursor-pointer rounded-md border-0 px-2.5 text-xs transition-colors {!unresolvedOnly &&
 filter === chip.value
 ? 'bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-none dark:ring-1 dark:ring-white/10'
 : 'bg-transparent font-normal text-muted-foreground hover:text-foreground'}"
                    onclick={() => setFilter(chip.value)}
                  >
                    {chip.label}
                  </Button>
                {/each}
              </div>
            {/if}
            {#if unresolvedCount > 0}
              <Button
                type="button"
                variant="ghost"
                aria-pressed={unresolvedOnly}
                class="h-7 cursor-pointer rounded-lg border-0 px-2.5 text-xs font-medium tabular-nums transition-colors {unresolvedOnly
 ? 'bg-secondary text-secondary-foreground'
 : 'bg-muted text-muted-foreground hover:text-foreground'}"
                onclick={toggleUnresolved}
              >
                {unresolvedCount} unresolved
              </Button>
            {/if}
          </div>
        </div>

        <ActivityTimeline
          events={visibleTimeline}
          loading={timelineLoading}
          filtered={timelineFiltered}
          {authorName}
          {openedAt}
          {viewerLogin}
          {deletingCommentIds}
          onJump={jumpToFile}
          {onOpenCommit}
          onReply={replyToThread}
          onResolve={resolveThread}
          onDeleteComment={deleteComment}
        />

        <!-- Composer: full measure of the main column, flush with the title and
             description rather than indented to the timeline's content column —
             it addresses the PR, not the last event. A flat muted pill rather
             than a ringed panel; the timeline already carries the page's only
             hairlines, so a second outline here reads as chrome. The send
             button is a tinted accent square, not a solid fill: at this size a
             saturated block outweighs everything above it.
             The surface is the card fill inside a half-pixel ring rather than a
             muted fill: the composer is the one place on this page you write
             into, so it sits *on* the canvas instead of being cut out of it. -->
        <!-- Sticky over the scroll region so the field follows you through a
             long timeline instead of sitting at the far bottom, with a scrim so
             events dissolve into the canvas rather than being clipped by a
             hard edge. Matches the task page composer. -->
        <CommentPostingBar
          class="mt-8"
          value={composer}
          onValueChange={(markdown) => (composer = markdown)}
          onSubmit={postComment}
          disabled={posting}
          placeholder="Write a comment…"
          submitLabel="Comment"
          submitAriaLabel="Post comment"
        >
          {#snippet leading()}
            <PrAvatar
              name={viewerLogin || "?"}
              url={viewerAvatarUrl}
              size="size-[25px] text-xs"
            />
          {/snippet}
          {#snippet submitContent()}
            <ArrowUpIcon size={13} weight="bold" />
          {/snippet}
        </CommentPostingBar>
      </main>

      <!-- ── Right rail: status + actions, reviewers, changed files ──
           Only while there is a column to hold it. It used to stay here at full
           width below the rung, which put reviewers and changed files under the
           comment composer, past every comment on the pull request. Below the
           rung it is the sheet the bottom bar opens instead. -->
      {#if !railFolded}
        {@render railPanel("column")}
      {/if}
    </div>
</div>

<!-- The folded layout's only chrome: merge state, the move that clears it, and
     the way back to everything the rail was carrying. Outside the scrollport,
     so all of it is reachable without reading to the end. -->
{#if railFolded}
  <PrMergeBar
    {detail}
    {checks}
    {unresolvedCount}
    {openedTime}
    actions={prActions}
    details={railSheetTrigger}
  />
{/if}
</div>

<!-- The rail, in order, as a sheet. It stops short of the top so the pull
     request behind it stays identifiable — this is reference material about
     what you are reading, and covering it entirely would leave nothing to say
     what that is. -->
{#if railFolded && railOpen}
  <BottomSheet label="Pull request details" onClose={() => (railOpen = false)}>
    {#snippet header()}
      <div class="flex items-center justify-between">
        <span class="text-workspace-chrome font-medium text-foreground">Details</span>
        <button
          type="button"
          class="h-9 cursor-pointer rounded-lg border-0 bg-transparent px-2 font-medium text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))] [-webkit-tap-highlight-color:transparent] pointer-fine:[.is-laptop-display_&]:h-8"
          onclick={() => (railOpen = false)}
        >
          Done
        </button>
      </div>
    {/snippet}
    {@render railPanel("sheet")}
  </BottomSheet>
{/if}

{#snippet railSheetTrigger()}
  <button
    type="button"
    class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground [-webkit-tap-highlight-color:transparent] pointer-fine:[.is-laptop-display_&]:h-7 pointer-fine:[.is-laptop-display_&]:px-2"
    onclick={() => (railOpen = true)}
    aria-haspopup="dialog"
    aria-expanded={railOpen}
    aria-label="Pull request details"
  >
    <PropertiesIcon size={15} aria-hidden="true" />
    Details
  </button>
{/snippet}

<!-- One definition, two homes: a column beside the conversation where there is
     room for one, and a sheet where there is not. Rendering it twice would be
     twenty props kept in step by hand. -->
{#snippet railPanel(variant: "column" | "sheet")}
  <PrActivityRail
    {variant}
    {detail}
    {reviewers}
    {reviewersLoading}
    {reviewerCandidates}
    {reviewerCandidatesLoading}
    {reviewerMutation}
    onRequestReviewer={detail?.capabilities.reviewerRequests &&
    detail.viewerPermissions.requestReviewers
      ? requestReviewer
      : undefined}
    onRemoveReviewer={detail?.capabilities.reviewerRequests &&
    detail.viewerPermissions.requestReviewers
      ? removeReviewer
      : undefined}
    {changedFiles}
    {filesLoading}
    {openedTime}
    {checks}
    {fixingCheckId}
    onFixCheck={onFixCheck ? fixCheck : undefined}
    {unresolvedCount}
    onFileJump={(path) => jumpToFile(path)}
    {guideStatus}
    onGenerateGuide={onGenerateGuide &&
    detail?.state === "open" &&
    !detail.draft
      ? onGenerateGuide
      : undefined}
    actions={prActions}
    menu={prOverflowMenu}
    showReadiness={variant === "column"}
  />
{/snippet}

{#snippet prActions()}
  <PrActions
    pr={{ number: pr.number, title: prTitle }}
    {detail}
    {feedbackCount}
    {addressCommentsReady}
    {addressingComments}
    onAddressComments={onAddressComments ? addressComments : undefined}
    getCtx={feedCtx}
    pullRequest={pullRequest(pr.number)}
  />
{/snippet}

{#snippet prOverflowMenu()}
  <PrOverflowMenu
    pr={{ host: pr.host }}
    {detail}
    {showRemoteLink}
    {prUrl}
    {onChat}
    onOpenRemote={openPr}
    onRefresh={refresh}
    onLifecycleAction={updateLifecycle}
  />
{/snippet}
