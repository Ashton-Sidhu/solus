<script lang="ts">
  import { tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import {
    ArrowUp as ArrowUpIcon,
    Pen as PencilSimpleIcon,
  } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
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
    PrLabel,
    PrReviewer,
    PrReviewerCandidate,
    ProviderViewer,
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
  import type {
    ActivityFilter,
    PrActivityDataSource,
    PrActivityTarget,
  } from "./lib/activity-data";
  import {
    buildActivityTimeline,
    filterActivityTimeline,
    hasVisibleBody,
  } from "./lib/activity-data";
  import PrActivityRail from "./PrActivityRail.svelte";
  import type { PrActionsLayout } from "./lib/pr-actions-layout";
  import { observeContainerWidth } from "../../lib/pane-width";
  import { isRailFolded } from "./lib/rail-rows";
  import ActivityTimeline from "./ActivityTimeline.svelte";
  import PrActions from "./PrActions.svelte";
  import PrOverflowMenu from "./PrOverflowMenu.svelte";
  import PrStatusChip from "./PrStatusChip.svelte";
  import PrChangeFacts from "./PrChangeFacts.svelte";
  import PrIdentityLink from "./PrIdentityLink.svelte";
  import PrReviewerFacts from "./PrReviewerFacts.svelte";
  import PrLabelFacts from "./PrLabelFacts.svelte";
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
    chatBusy = false,
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
    /** The shared PR chat is being created or attached to its checkout. */
    chatBusy?: boolean;
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
  let labelCandidates = $state<PrLabel[]>([]);
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
  let labelCandidatesLoading = $state(false);
  let labelsMutation = $state(false);
  let filesLoading = $state(true);
  // Any provider load rejecting (expired token, network) lands here, and the
  // section that asked says so in place — a description that could not be
  // read, a spine with no events, a reviewer list with no rows — instead of
  // masquerading as an empty PR. Only a missing GitHub connection is said once
  // for the whole tab, because it is the one failure with a single fix.
  const failedLoads = new SvelteSet<PrActivityDataSource>();
  let loadError = $state<PrSurfaceError | null>(null);
  const timelineLoadFailed = $derived(
    failedLoads.has("commits") || failedLoads.has("comments") || threadsFailed,
  );

  let composer = $state("");
  let posting = $state(false);
  let scrollViewport = $state<HTMLElement | null>(null);

  // Below the rung the rail has no column, so it is drawn inline under the
  // title instead — the status card first, then the reference sections folded.
  // The decision reads the content row's own box: the row is the `@container`
  // the rail's rung is resolved against, and a container query measures its
  // content box. The row's border box would be 104px wider, which is a whole
  // band of pane widths with the rail in the wrong home.
  let contentRowEl = $state<HTMLElement | null>(null);
  let contentRowWidth = $state(0);
  $effect(() => {
    if (!contentRowEl) return;
    return observeContainerWidth(contentRowEl, (width) => (contentRowWidth = width));
  });
  const railFolded = $derived(isRailFolded(contentRowWidth));
  let deletingCommentIds = $state(new SvelteSet<string>());
  let editing = $state(false);
  let titleDraft = $state("");
  let bodyDraft = $state("");
  let descriptionEditor = $state<DocumentEditor | null>(null);
  let saving = $state(false);
  let titleInput = $state<HTMLInputElement | null>(null);
  let addressingComments = $state(false);
  let fixingCheckId = $state<string | null>(null);
  // The provider token's account — who a posted comment will belong to. Null
  // until the (cached) lookup resolves or when it fails; the avatar then shows
  // a neutral "?" rather than guessing an identity.
  let viewer = $state<ProviderViewer | null>(null);
  const viewerLogin = $derived(viewer?.login ?? "");

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
  // The line beside the author says when the pull request last moved, the
  // way its host does; the rail's readiness note still says when it opened.
  const updatedTime = $derived(
    detail ? formatTimeAgoFromTimestamp(new Date(detail.updatedAt).getTime()) : null,
  );
  // Identity the way the host writes it — `owner/repo` — from the base
  // repository the target names. `owner` on the target is the author login,
  // so it never stands in for the repository's owner.
  const repoLabel = $derived(
    pr.repo ? (pr.remoteOwner ? `${pr.remoteOwner}/${pr.repo}` : pr.repo) : null,
  );
  const canRequestReviewers = $derived(
    !!detail?.capabilities.reviewerRequests && detail.viewerPermissions.requestReviewers,
  );
  const canManageLabels = $derived(
    !!detail?.capabilities.labelManagement && detail.viewerPermissions.manageLabels,
  );
  // A PR opened by number alone (deep link, `#123` in a message) carries no
  // title until detail lands — hold the masthead's space instead of letting the
  // heading collapse and shove everything below it up a line.
  const prTitle = $derived(detail?.title || pr.title || "");
  const authorName = $derived(detail?.author ?? pr.owner ?? "");
  const authorAvatarUrl = $derived(
    detail?.authorAvatarUrl ?? pr.authorAvatarUrl ?? "",
  );
  // The host's own image for the account, so the composer shows the same face
  // the posted comment will. Falls back to the author's image when the viewer
  // opened this PR and the host reported no avatar; otherwise the initials disc.
  const viewerAvatarUrl = $derived(
    viewer?.avatarUrl ??
      (viewerLogin && viewerLogin === authorName ? authorAvatarUrl : ""),
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
    unresolvedCount + comments.reduce((count, item) => count + (hasVisibleBody(item.body) ? 1 : 0), 0),
  );

  function markLoadFailed(
    n: number,
    source: PrActivityDataSource,
    error: Parameters<typeof prSurfaceError>[0],
  ) {
    if (pr.number !== n) return;
    failedLoads.add(source);
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
    reviewerCandidates = cached.reviewerCandidates ?? [];
    labelCandidates = [];
    changedFiles = cached.changedFiles ?? [];
    failedLoads.clear();
    loadError = null;
    filter = "all";
    unresolvedOnly = false;
    // A forced reload re-reads even when the index already holds a detail, so
    // the section says it is working rather than showing the previous head.
    detailLoading = force || !pullRequests.projects.at(serverId, projectScopeOf(feedCtx().session))?.prFor(n);
    commitsLoading = !cached.commits;
    commentsLoading = !cached.comments;
    reviewersLoading = !cached.reviewers;
    reviewerCandidatesLoading = false;
    labelCandidatesLoading = false;
    filesLoading = !cached.changedFiles;

    // Not PR-scoped (and cached per project) — best-effort, never an error.
    pullRequests.projects
      .get(getApi(), serverId, feedCtx())
      .loadViewer()
      .then((profile) => (viewer = profile))
      .catch(() => {});
    // The host only volunteers checks for the repository the active tab is
    // in, and only to a client that has already asked for that project once.
    // A review opened from a deep link, a chip, or another project had never
    // asked, so its rail sat with no checks until a list happened to load
    // them. Naming this PR also brings in one the poller had not seen yet.
    void pullRequests.checks
      .load(getApi(), serverId, feedCtx(), [n])
      .catch(() => {});
    pullRequest(n)
      .loadDetail({ force })
      .then((d) => {
        if (
          pr.number === n &&
          (!d.capabilities.reviewerCandidates ||
            !d.viewerPermissions.requestReviewers)
        ) reviewerCandidates = [];
      })
      .catch((error) => {
        markLoadFailed(n, "details", error);
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
      .catch((error) => markLoadFailed(n, "commits", error))
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
      .catch((error) => markLoadFailed(n, "comments", error))
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
      .catch((error) => markLoadFailed(n, "reviewers", error))
      .finally(() => {
        if (pr.number === n) reviewersLoading = false;
      });
    loadChangedFiles(n, force);
  }

  function loadReviewerCandidates(n: number, force = false) {
    if (reviewerCandidatesLoading) return;
    reviewerCandidatesLoading = true;
    pullRequest(n)
      .loadReviewerCandidates({ force })
      .then((candidates) => {
        if (pr.number === n) reviewerCandidates = candidates;
      })
      .catch((error) => markLoadFailed(n, "reviewer-candidates", error))
      .finally(() => {
        if (pr.number === n) reviewerCandidatesLoading = false;
      });
  }

  function openReviewerMenu(): void {
    loadReviewerCandidates(pr.number);
  }

  function openLabelMenu(): void {
    if (labelCandidatesLoading || labelCandidates.length > 0) return;
    const number = pr.number;
    labelCandidatesLoading = true;
    pullRequest(number)
      .loadLabelCandidates()
      .then((candidates) => {
        if (pr.number === number) {
          labelCandidates = candidates;
          failedLoads.delete("label-candidates");
        }
      })
      .catch((error) => markLoadFailed(number, "label-candidates", error))
      .finally(() => {
        if (pr.number === number) labelCandidatesLoading = false;
      });
  }

  async function setLabels(names: string[]): Promise<void> {
    if (labelsMutation) return;
    const number = pr.number;
    labelsMutation = true;
    try {
      const entity = pullRequest(number);
      await entity.setLabels(names);
      // The provider records a labeled/unlabeled timeline item with the exact
      // name. Refresh that one feed after the write so the audit row appears
      // now rather than after the ordinary activity cache expires.
      try {
        const updatedComments = await entity.loadComments({ force: true });
        if (pr.number === number) comments = updatedComments;
      } catch {
        // The label write succeeded. Keep the current activity instead of
        // reporting the completed mutation as a failure.
      }
    } catch (error) {
      toasts.error("Couldn’t update labels", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      labelsMutation = false;
    }
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
        markLoadFailed(n, "changed-files", error);
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
      await targetRefresh.catch((error) => markLoadFailed(pr.number, "details", error));
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
    {#if loadError?.kind === "github-auth"}
      <!-- The one failure said once for the whole tab: nothing below can
           load until the host has a credential, and the fix is one action. -->
      <div
        class="mx-auto w-full max-w-[1216px] px-[52px] pt-6 [.is-laptop-display_&]:px-8"
      >
        <GithubConnectionRequired {serverId} />
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
      <!-- The column declares the review's type once, at the chrome rung
           (ADR-0013); the title, the captions and the timestamps step off it. -->
      <main
        class="flex min-w-0 max-w-[768px] flex-[1_1_520px] flex-col text-workspace-chrome"
      >
        <!-- Masthead, Linear-style: no chrome in the header at all — a quiet
             mono eyebrow, the title at full measure, one line of plain-text
             facts. Actions live with the merge-readiness status in the right
             rail (prActions below), which folds into this column rather than
             hiding, so they are reachable at every width. -->
        <header>
          <!-- Identity the way the host writes it, when no masthead above
               already carries it: the repository in quiet type, the number as
               the link to the host page. -->
          {#if showIdentity && !masthead}
            <PrIdentityLink
              repo={repoLabel}
              number={pr.number}
              onOpenPage={prUrl ? openPr : undefined}
            />
          {/if}

          {#if editing}
            <Input
              bind:this={titleInput}
              bind:value={titleDraft}
              class="{showIdentity && !masthead
                ? 'mt-2'
                : ''} h-auto w-full rounded-none border-0 bg-transparent! p-0 text-2xl leading-[1.25] font-semibold tracking-[-0.02em] outline-none shadow-none focus-visible:ring-0 dark:bg-transparent!"
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
            <!-- The page-title rung (ADR-0013): with the facts under it at
                 the chrome rung, 24px is a clear step up without the title
                 outweighing the whole column. -->
            <h1
              class="{showIdentity && !masthead
                ? 'mt-2'
                : ''} text-2xl leading-[1.25] font-semibold tracking-[-0.02em] text-pretty"
            >
              {prTitle}
            </h1>
          {:else}
            <Skeleton
              class="{showIdentity && !masthead
                ? 'mt-2'
                : ''} h-[30px] w-2/3 max-w-[560px] rounded-lg bg-muted"
            />
          {/if}

          <!-- Who, what state, and when it last moved, under the title the
               way the host writes it. The refs and the counts sit on the line
               below, so this row stays one line at every width. -->
          <div
            class="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-muted-foreground"
          >
            <PrStatusChip {status} />
            <span class="flex min-w-0 items-center gap-2">
              <PrAvatar
                name={authorName}
                url={authorAvatarUrl}
                size="size-5 text-xs"
              />
              <span class="truncate font-medium text-foreground">{authorName}</span>
              {#if updatedTime}
                <span class="opacity-40" aria-hidden="true">·</span>
                <span class="shrink-0">updated {updatedTime}</span>
              {:else if openedTime}
                <span class="opacity-40" aria-hidden="true">·</span>
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
                class="h-7 cursor-pointer gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground hover:text-foreground"
                title="Edit pull request title and description"
                onclick={beginEditing}
              >
                <PencilSimpleIcon size={12} />
                Edit
              </Button>
            {/if}
          </div>

          <!-- The facts about the change — branch, files, churn — as captioned
               rows under the author. Reviewers, checks, and the file list are
               the rail's while it has a column; once it folds, the reviewers
               lead this list instead of sitting in a folded section below. -->
          <div class="mt-4">
            <PrChangeFacts
              leading={detail ? leadingFacts : undefined}
              {headBranch}
              {baseRef}
              fileCount={changedFiles.length}
              {filesLoading}
              additions={diffStat.additions}
              deletions={diffStat.deletions}
            />
          </div>

          <!-- The rail's inline home. With no column beside the conversation,
               the status card and the reference sections sit here, under the
               facts and above the description, so the state of the pull
               request and the move that changes it are still in the first
               screen rather than past every comment on it. -->
          {#if railFolded}
            <div class="mt-5">
              {@render railPanel("inline")}
            </div>
          {/if}
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
        {:else if failedLoads.has("details") && !detail}
          <!-- Said where the description would be, not in a banner over the
               page: the rest of the tab may well have loaded. -->
          <p class="mt-8 flex items-center gap-2 text-muted-foreground" role="alert">
            <span>Couldn’t load the description.</span>
            <button
              type="button"
              class="cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              onclick={refresh}
            >
              Retry
            </button>
          </p>
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
          loadFailed={timelineLoadFailed}
          onRetry={refresh}
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

      <!-- ── Right rail: status + actions, reviewers, checks, changed files ──
           Only while there is a column to hold it. Below the rung the same
           rail is drawn inline in the header above, so nothing it carries is
           ever past the comment composer. -->
      {#if !railFolded}
        {@render railPanel("column")}
      {/if}
    </div>
</div>
</div>

<!-- The reviewers' home once the rail has folded: a row of the facts list,
     not a section of the inline rail. -->
{#snippet leadingFacts()}
  {#if railFolded}
    <PrReviewerFacts
      {reviewers}
      loading={reviewersLoading}
      loadFailed={failedLoads.has("reviewers")}
      candidates={reviewerCandidates}
      candidatesLoading={reviewerCandidatesLoading}
      candidatesLoadFailed={failedLoads.has("reviewer-candidates")}
      mutation={reviewerMutation}
      onOpenMenu={openReviewerMenu}
      onRequest={canRequestReviewers ? requestReviewer : undefined}
      onRemove={canRequestReviewers ? removeReviewer : undefined}
      onRetry={refresh}
    />
  {/if}
  <PrLabelFacts
    labels={detail?.labels ?? []}
    candidates={labelCandidates}
    loading={labelCandidatesLoading}
    loadFailed={failedLoads.has("label-candidates")}
    mutation={labelsMutation}
    onOpen={canManageLabels ? openLabelMenu : undefined}
    onSet={canManageLabels ? setLabels : undefined}
  />
{/snippet}

<!-- One definition, two homes: a column beside the conversation where there is
     room for one, and a block under the title where there is not. Rendering it
     twice would be twenty props kept in step by hand. -->
{#snippet railPanel(variant: "column" | "inline")}
  <PrActivityRail
    {variant}
    {detail}
    {reviewers}
    {reviewersLoading}
    reviewersLoadFailed={failedLoads.has("reviewers")}
    {reviewerCandidates}
    {reviewerCandidatesLoading}
    reviewerCandidatesLoadFailed={failedLoads.has("reviewer-candidates")}
    {reviewerMutation}
    onOpenReviewerMenu={openReviewerMenu}
    onRequestReviewer={canRequestReviewers ? requestReviewer : undefined}
    onRemoveReviewer={canRequestReviewers ? removeReviewer : undefined}
    {changedFiles}
    {filesLoading}
    filesLoadFailed={failedLoads.has("changed-files")}
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
    onRetry={refresh}
    actions={prActions}
    menu={prOverflowMenu}
  />
{/snippet}

{#snippet prActions(layout: PrActionsLayout)}
  <PrActions
    {layout}
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
    onFixComments={feedbackCount > 0 && onAddressComments ? addressComments : undefined}
    {chatBusy}
    fixCommentsBusy={addressingComments}
    onOpenRemote={openPr}
    onRefresh={refresh}
    onLifecycleAction={updateLifecycle}
  />
{/snippet}
