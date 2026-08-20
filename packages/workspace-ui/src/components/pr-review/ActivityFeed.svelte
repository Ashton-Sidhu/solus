<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    RefreshCw as ArrowsClockwiseIcon,
    GitPullRequest as GitPullRequestIcon,
    ArrowRight as ArrowRightIcon,
    ArrowUp as ArrowUpIcon,
    Pen as PencilSimpleIcon,
  } from "@lucide/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { CommentEditor } from "../ui/comment-editor";
  import DocumentEditor from "../editor/DocumentEditor.svelte";
  import { projectScopeOf, type ChangedFileStat, type IpcContext } from "@solus/contracts/types";
  import type {
    ReviewThread,
    ReviewComment,
    PullRequestDetail,
    PrCommit,
    PrConversationItem,
    PrLifecycleAction,
    PrReviewer,
    PrReviewerCandidate,
  } from "@solus/contracts/providers";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { localApi } from "@solus/client-core/local-api";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import type { HostApi } from "@solus/client-core/host-api";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { changedFileTotals } from "../../lib/diff-stats";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { githubMarkdownExtensions } from "../../lib/githubMarkdown";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import { Button } from "../ui/button";
  import { Skeleton } from "../ui/skeleton";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import type { ActivityFilter, PrActivityTarget } from "./lib/activity-data";
  import {
    buildActivityTimeline,
    filterActivityTimeline,
  } from "./lib/activity-data";
  import PrActivityRail from "./PrActivityRail.svelte";
  import ActivityTimeline from "./ActivityTimeline.svelte";
  import PrActions from "./PrActions.svelte";
  import PrOverflowMenu from "./PrOverflowMenu.svelte";
  import PrStatusChip from "./PrStatusChip.svelte";
  import GithubConnectionRequired from "../prs/GithubConnectionRequired.svelte";
  import { prSurfaceError, type PrSurfaceError } from "../prs/lib/pr-surface-error";
  import {
    markPrReviewProfile,
    profilePrReviewWork,
    settlePrReviewProfile,
  } from "./lib/pr-review-profiler";

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
    onGenerateGuide,
    onChat,
    onJump,
    onOpenCommit,
    onRefreshThreads,
    onRefreshTarget,
    onDetailChanged,
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
    onGenerateGuide?: () => void;
    onChat?: () => void;
    /** Jump to a thread's / file's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    /** Open the diff scoped to one commit's changes. */
    onOpenCommit?: (commit: PrCommit) => void;
    /** Refetch the shared threads (e.g. from this tab's Refresh button). */
    onRefreshThreads?: () => void;
    /** Refresh the exact host revision owned by the route. */
    onRefreshTarget?: () => Promise<void>;
    /** Publish a canonical mutation result to review chrome outside Activity. */
    onDetailChanged?: (detail: PullRequestDetail) => void;
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
  const feedCtx = (): IpcContext => getCtx?.() ?? session.ctx;

  let detail = $state<PullRequestDetail | null>(null);

  $effect(() => {
    const number = pr.number;
    return subscribeAllHosts("pr.lifecycleChanged", (eventServerId, event) => {
      if (eventServerId !== serverId || event.detail.number !== number) return;
      const ctx = feedCtx().session;
      if (event.projectRoot !== projectScopeOf(ctx)) return;
      detail = event.detail;
      onDetailChanged?.(event.detail);
    });
  });
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
  let editing = $state(false);
  let titleDraft = $state("");
  let bodyDraft = $state("");
  let descriptionEditor = $state<DocumentEditor | null>(null);
  let saving = $state(false);
  let titleInput = $state<HTMLInputElement | null>(null);
  let addressingComments = $state(false);
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

  // Composer styled like the message composer: bare field inside its own pill,
  // forced 400 weight so typed text never reads bold.
  const composerFieldClass =
    "flex-1 min-w-0 [&_.cm-content]:![padding:0.25rem_0] [&_.cm-content]:![min-height:1.25rem] [&_.cm-content]:![font-weight:400]";

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
  // Size of the change, stated once under the title. The rail lists the files;
  // this line only says how big a read this is before you commit to one.
  const filesLabel = $derived(
    changedFiles.length === 1 ? "1 file" : `${changedFiles.length} files`,
  );
  const diffStat = $derived(changedFileTotals(changedFiles));

  const baseRef = $derived(pr.baseRef ?? detail?.baseRef ?? "");
  const headBranch = $derived(pr.headRef ?? detail?.headRef ?? "");
  const prUrl = $derived(
    pr.host && (pr.remoteOwner ?? pr.owner) && pr.repo
      ? `https://${pr.host}/${pr.remoteOwner ?? pr.owner}/${pr.repo}/pull/${pr.number}`
      : null,
  );
  // Commits, review threads, and the durable PR conversation, merged into one
  // chronological timeline (see buildActivityTimeline). The opened event is
  // rendered separately as the fixed first row and always leads.
  const timeline = $derived(
    profilePrReviewWork(
      "activity-timeline-build",
      () => buildActivityTimeline(commits, threads, comments),
      { commits: commits.length, threads: threads.length, comments: comments.length },
    ),
  );
  const visibleTimeline = $derived(
    filterActivityTimeline(timeline, filter, unresolvedOnly),
  );
  const timelineFiltered = $derived(filter !== "all" || unresolvedOnly);
  // Ghost rows until both interleaved sources are in — threads pop in from the
  // parent whenever its fetch lands (no flag), matching the previous behavior.
  const timelineLoading = $derived(commitsLoading || commentsLoading);
  const checks = $derived(session.prsStore.checksFor(serverId, feedCtx(), pr.number));
  const guideStatus = $derived(
    session.prsStore.guideStatusFor(serverId, feedCtx(), pr.number),
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
    markPrReviewProfile("activity-load-start", { force });
    const cached = force ? {} : session.prsStore.cachedActivity(serverId, feedCtx(), n);
    detail = cached.detail ?? null;
    commits = cached.commits ?? [];
    comments = cached.comments ?? [];
    reviewers = cached.reviewers ?? [];
    changedFiles = cached.changedFiles ?? [];
    loadFailed = false;
    loadError = null;
    filter = "all";
    unresolvedOnly = false;
    detailLoading = !cached.detail;
    commitsLoading = !cached.commits;
    commentsLoading = !cached.comments;
    reviewersLoading = !cached.reviewers;
    filesLoading = !cached.changedFiles;

    // Not PR-scoped (and cached per project) — best-effort, never an error.
    session.prsStore
      .loadViewer(getApi(), serverId, feedCtx())
      .then((login) => (viewerLogin = login))
      .catch(() => {});
    session.prsStore
      .loadDetail(getApi(), serverId, feedCtx(), n, { force })
      .then((d) => {
        if (pr.number !== n) return;
        detail = d;
        if (
          d.capabilities.reviewerCandidates &&
          d.viewerPermissions.requestReviewers
        ) {
          loadReviewerCandidates(n, force);
        } else {
          reviewerCandidates = [];
        }
        markPrReviewProfile("detail-ready", { bodyCharacters: d.body.length });
      })
      .catch((error) => {
        markLoadFailed(n, error);
      })
      .finally(() => {
        if (pr.number === n) detailLoading = false;
      });
    session.prsStore
      .loadCommits(getApi(), serverId, feedCtx(), n, { force })
      .then((c) => {
        if (pr.number === n) {
          commits = c;
          markPrReviewProfile("commits-ready", { count: c.length });
        }
      })
      .catch((error) => markLoadFailed(n, error))
      .finally(() => {
        if (pr.number === n) commitsLoading = false;
      });
    session.prsStore
      .loadComments(getApi(), serverId, feedCtx(), n, { force })
      .then((c) => {
        if (pr.number === n) {
          comments = c;
          markPrReviewProfile("comments-ready", { count: c.length });
        }
      })
      .catch((error) => markLoadFailed(n, error))
      .finally(() => {
        if (pr.number === n) commentsLoading = false;
      });
    session.prsStore
      .loadReviewers(getApi(), serverId, feedCtx(), n, { force })
      .then((r) => {
        if (pr.number === n) {
          reviewers = r;
          markPrReviewProfile("reviewers-ready", { count: r.length });
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
    session.prsStore
      .loadReviewerCandidates(getApi(), serverId, feedCtx(), n, { force })
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
      reviewers = await session.prsStore.requestReviewers(
        getApi(), serverId, feedCtx(), pr.number, [login],
      );
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
      reviewers = await session.prsStore.removeRequestedReviewer(
        getApi(), serverId, feedCtx(), pr.number, login,
      );
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
    session.prsStore
      .loadChangedFiles(getApi(), serverId, feedCtx(), n, { force })
      .then((f) => {
        if (pr.number === n) {
          changedFiles = f;
          markPrReviewProfile("changed-files-ready", { count: f.length });
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
    const optimistic: PullRequestDetail = { ...previous };
    if (action === "close") optimistic.state = "closed";
    if (action === "reopen") optimistic.state = "open";
    if (action === "ready") optimistic.draft = false;
    if (action === "draft") optimistic.draft = true;
    detail = optimistic;
    session.prsStore.applyDetail(serverId, feedCtx(), pr.number, optimistic);
    onDetailChanged?.(optimistic);
    try {
      const updated = await session.prsStore.updateLifecycle(
        getApi(),
        serverId,
        feedCtx(),
        pr.number,
        action,
        previous.headSha,
      );
      detail = updated;
      onDetailChanged?.(updated);
    } catch (error) {
      // A newer provider event wins over this rollback. Reference equality is
      // the mutation token for this one in-flight action.
      if (detail === optimistic) {
        detail = previous;
        session.prsStore.applyDetail(serverId, feedCtx(), pr.number, previous);
        onDetailChanged?.(previous);
      }
      throw error;
    }
  }

  function applyMergedDetail(updated: PullRequestDetail): void {
    detail = updated;
    session.prsStore.applyDetail(serverId, feedCtx(), pr.number, updated);
    onDetailChanged?.(updated);
  }

  $effect(() => {
    void pr.number;
    untrack(() => load());
  });

  $effect(() => {
    if (detailLoading || commitsLoading || commentsLoading || reviewersLoading || filesLoading) return;
    const n = pr.number;
    void tick().then(() => {
      requestAnimationFrame(() => {
        if (pr.number !== n) return;
        markPrReviewProfile("activity-settled-paint", {
          commits: commits.length,
          comments: comments.length,
          threads: threads.length,
          changedFiles: changedFiles.length,
        });
        settlePrReviewProfile();
      });
    });
  });

  // Reply / resolve state lives in each PrThreadCard; the feed only supplies
  // the RPCs bound to this PR.
  function replyToThread(threadId: string, body: string): Promise<ReviewComment> {
    return getApi().prReplyThread(feedCtx(), pr.number, threadId, body);
  }

  async function resolveThread(threadId: string, resolved: boolean): Promise<void> {
    if (resolved) {
      await getApi().prResolveThread(feedCtx(), pr.number, threadId);
    } else {
      await getApi().prUnresolveThread(feedCtx(), pr.number, threadId);
    }
  }

  async function postComment() {
    const body = composer.trim();
    if (!body || posting) return;
    posting = true;
    let commentCreated = false;
    try {
      const n = pr.number;
      await getApi().prAddIssueComment(feedCtx(), n, body);
      commentCreated = true;
      composer = "";
      // Refetch rather than inventing an optimistic author/id; the server copy
      // is the source of truth and survives a reload.
      const serverComments = await session.prsStore.loadComments(getApi(), serverId, feedCtx(), n, {
        force: true,
      });
      if (pr.number === n) comments = serverComments;
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
      detail = await session.prsStore.updatePullRequest(getApi(), serverId, feedCtx(), pr.number, {
        title,
        body,
      });
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

  function jumpToFile(path: string, line: number | null = null) {
    onJump?.(path, line);
    requestInputFocus();
  }

  function onComposerKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void postComment();
    }
  }

  function openPr() {
    if (!prUrl) return;
    void localApi.openExternal(prUrl);
    requestInputFocus();
  }
</script>

<div class="h-full min-h-0 overflow-y-auto bg-background">
    {#if anyLoadFailed}
      <div
        class="mx-auto w-full max-w-[min(1384px,100%)] px-[clamp(20px,2.6vw,56px)] pt-4"
      >
        <div
          class="flex items-center gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-3 text-sm"
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
              class="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
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
        class="mx-auto w-full max-w-[min(1384px,100%)] px-[clamp(20px,2.6vw,56px)] pt-[clamp(20px,1.8vw,32px)]"
      >
        {@render masthead()}
      </div>
    {/if}
    <!-- Capped measure: on wide windows the column centers instead of the
         title and a sparse timeline stretching toward a distant rail. The row
         is the size container the rail queries, so the rail folds under the
         main column on narrow panes instead of disappearing. -->
    <div
      class="@container mx-auto flex w-full max-w-[min(1384px,100%)] flex-wrap gap-[clamp(24px,3vw,64px)] px-[clamp(20px,2.6vw,56px)] {masthead ? 'pt-3.5' : 'pt-[clamp(20px,1.8vw,32px)]'} pb-[clamp(32px,3vw,56px)]"
    >
      <!-- ── Main column: title, meta, description, activity, composer ── -->
      <main class="flex min-w-0 max-w-[1000px] flex-[1_1_520px] flex-col">
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
              <!-- Identity, not state — the subtitle chip below carries the
                   state, and a tinted mark up here read as a second one. -->
              <GitPullRequestIcon size={10} class="shrink-0" />
              <span class="min-w-0 truncate"
                >{pr.repo ? `${pr.repo} ` : ""}#{pr.number}</span
              >
            </p>
          {/if}

          {#if editing}
            <input
              bind:this={titleInput}
              bind:value={titleDraft}
              class="{masthead || !showIdentity ? '' : 'mt-3.5'} w-full rounded-lg border border-border bg-card px-3 py-2 text-2xl leading-[1.28] font-medium outline-none transition-colors focus:border-ring"
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
            <h1
              class="{masthead || !showIdentity ? '' : 'mt-3.5'} text-2xl leading-[1.28] font-medium text-pretty"
            >
              {prTitle}
            </h1>
          {:else}
            <Skeleton
              class="{masthead || !showIdentity ? '' : 'mt-3.5'} h-[31px] w-2/3 max-w-[560px] rounded-lg bg-muted"
            />
          {/if}

          <div
            class="mt-[11px] flex flex-wrap items-center gap-x-[9px] gap-y-2 text-xs text-muted-foreground"
          >
            <!-- State leads the subtitle, the way a code host states it: the one
                 fact that changes how every other fact on this row reads. -->
            <PrStatusChip {status} />
            <span class="flex min-w-0 items-center gap-2">
              <PrAvatar
                name={authorName}
                url={authorAvatarUrl}
                size="size-5 text-xs"
              />
              <span class="truncate font-medium text-foreground">{authorName}</span>
              {#if openedTime}
                <span class="shrink-0">opened {openedTime}</span>
              {/if}
            </span>
            {#if baseRef && !masthead}
              <span class="opacity-40" aria-hidden="true">·</span>
              <!-- head → base, reading in merge direction ("move-func into main").
                   A filled mono pill: the refs are literals you might type, so
                   they get a surface of their own rather than sitting in prose.
                   Only when the masthead is absent — it states the refs itself,
                   and one line above the title is enough. -->
              <span
                class="flex min-w-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
              >
                {#if headBranch}
                  <span class="truncate">{headBranch}</span>
                  <ArrowRightIcon size={10} class="shrink-0" aria-hidden="true" />
                {/if}
                <span class="truncate text-foreground">{baseRef}</span>
              </span>
            {/if}
            {#if !filesLoading && changedFiles.length > 0}
              <span class="opacity-40" aria-hidden="true">·</span>
              <span class="shrink-0">{filesLabel}</span>
              <span class="opacity-40" aria-hidden="true">·</span>
              <span class="shrink-0 tabular-nums">
                <span class="text-[color:color-mix(in_oklch,var(--success)_62%,var(--foreground))]"
                  >+{diffStat.additions}</span
                >
                <span class="text-[color:color-mix(in_oklch,var(--failure)_70%,var(--foreground))]"
                  >−{diffStat.deletions}</span
                >
              </span>
            {/if}
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
        </header>

        <!-- PR description belongs to the PR header, not the activity stream. -->
        {#if editing}
          <div
            class="mt-6 rounded-2xl border border-border bg-card p-3 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
          >
            <DocumentEditor
              bind:this={descriptionEditor}
              value={bodyDraft}
              onValueChange={(markdown) => (bodyDraft = markdown)}
              placeholder="Describe this pull request…"
              dragHandle={false}
              class="pr-description-editor prose-pr prose-pr-description"
              style="max-height:26.25rem;overflow-y:auto"
            />
            <div class="mt-3 flex items-center justify-end gap-2 border-t border-border pt-3">
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
          onJump={jumpToFile}
          {onOpenCommit}
          onReply={replyToThread}
          onResolve={resolveThread}
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
        <div
          class="sticky bottom-0 z-10 mt-8 pt-2.5 pb-[22px] [background:linear-gradient(to_bottom,transparent,var(--background)_22px)]"
        >
        <div
          class="flex items-center gap-3 rounded-2xl bg-card px-3.5 py-2.5 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent),0_1px_2px_rgba(24,20,16,.05)] transition-shadow focus-within:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent),0_0_0_3px_color-mix(in_oklab,var(--ring)_14%,transparent)]"
        >
          <PrAvatar
            name={viewerLogin || "?"}
            url={viewerAvatarUrl}
            size="size-[25px] text-xs"
          />
          <CommentEditor
            value={composer}
            onValueChange={(md) => (composer = md)}
            onKeyDown={onComposerKey}
            maxHeight={160}
            placeholder="Write a comment…"
            class={composerFieldClass}
          />
          <Button
            type="button"
            disabled={!composer.trim() || posting}
            class="flex size-[28px] shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-[color:color-mix(in_oklab,var(--primary)_14%,transparent)] text-primary transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Post comment"
            title="Comment · ⌘↵"
            onclick={postComment}
          >
            <ArrowUpIcon size={13} weight="bold" />
          </Button>
        </div>
        </div>
      </main>

      <!-- ── Right rail: status + actions, reviewers, changed files ── -->
      <PrActivityRail
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
        {unresolvedCount}
        onFileJump={(path) => jumpToFile(path)}
        actions={prActions}
        menu={prOverflowMenu}
      />
    </div>
</div>

{#snippet prActions()}
  <PrActions
    pr={{ number: pr.number, title: prTitle }}
    {detail}
    {feedbackCount}
    {guideStatus}
    {onGenerateGuide}
    {addressCommentsReady}
    {addressingComments}
    onAddressComments={onAddressComments ? addressComments : undefined}
    getCtx={feedCtx}
    {getApi}
    onDetailChanged={applyMergedDetail}
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
