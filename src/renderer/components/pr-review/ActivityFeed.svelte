<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    ArrowsClockwiseIcon,
    GitBranchIcon,
    GitPullRequestIcon,
    ArrowUpIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import type { ChangedFileStat, IpcContext } from "../../../shared/types";
  import type {
    ReviewThread,
    ReviewComment,
    PullRequestDetail,
    PrCommit,
    PrConversationItem,
    PrReviewer,
  } from "../../../shared/providers";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { toasts } from "../../contexts/toast.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
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
    threads,
    threadsFailed = false,
    stackChain = [],
    showRemoteLink = false,
    addressCommentsReady = true,
    onAddressComments,
    onChat,
    onJump,
    onRefreshThreads,
    getCtx,
  }: {
    pr: PrActivityTarget;
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
    onChat?: () => void;
    /** Jump to a thread's / file's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    /** Refetch the shared threads (e.g. from this tab's Refresh button). */
    onRefreshThreads?: () => void;
    /** Context override for hosts reviewing a PR outside the active tab's
     *  project (the PRs page's project switcher, embedded review panes).
     *  Defaults to the active tab's context. */
    getCtx?: () => IpcContext;
  } = $props();

  const session = getWorkspaceContext();
  const feedCtx = (): IpcContext => getCtx?.() ?? session.ctx;

  let detail = $state<PullRequestDetail | null>(null);
  let commits = $state<PrCommit[]>([]);
  let comments = $state<PrConversationItem[]>([]);
  let reviewers = $state<PrReviewer[]>([]);
  let changedFiles = $state<ChangedFileStat[]>([]);
  // Per-section loading so each region fills in as its own request resolves,
  // rather than the whole tab waiting on the slowest call. Threads come from the
  // parent (no flag here); the opened event + composer render immediately.
  let detailLoading = $state(true);
  let commitsLoading = $state(true);
  let commentsLoading = $state(true);
  let reviewersLoading = $state(true);
  let filesLoading = $state(true);
  // Any provider load rejecting (expired token, network) flips this so the
  // tab shows an explicit error + retry instead of masquerading as an empty PR.
  let loadFailed = $state(false);
  const anyLoadFailed = $derived(loadFailed || threadsFailed);

  let composer = $state("");
  let posting = $state(false);
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
    "flex-1 min-w-0 [&_.solus-md-editor_.ProseMirror]:![padding:0.25rem_0] [&_.solus-md-editor_.ProseMirror]:![min-height:1.25rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![top:0.25rem] [&_.solus-md-placeholder]:![left:0]";

  const openedAt = $derived(detail ? new Date(detail.createdAt).getTime() : null);
  const openedTime = $derived(
    openedAt ? formatTimeAgoFromTimestamp(openedAt) : null,
  );
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
  const checks = $derived(session.prsStore.checksFor(pr.number));
  const guideStatus = $derived(session.prsStore.guideStatusFor(pr.number));
  const unresolvedCount = $derived(
    threads.reduce((count, thread) => count + (thread.isResolved ? 0 : 1), 0),
  );
  const feedbackCount = $derived(
    unresolvedCount + comments.reduce((count, item) => count + (item.body.trim() ? 1 : 0), 0),
  );

  function markLoadFailed(n: number) {
    if (pr.number === n) loadFailed = true;
  }

  // Fire each request independently and let its section fill in on resolve — no
  // shared gate, so a slow call (threads, the change set) never holds back the
  // fast ones. `n` guards against a PR switch mid-flight clobbering newer data.
  function load(force = false) {
    const n = pr.number;
    markPrReviewProfile("activity-load-start", { force });
    detail = null;
    commits = [];
    comments = [];
    reviewers = [];
    changedFiles = [];
    loadFailed = false;
    filter = "all";
    unresolvedOnly = false;
    detailLoading =
      commitsLoading =
      commentsLoading =
      reviewersLoading =
      filesLoading =
        true;

    // Not PR-scoped (and cached per project) — best-effort, never an error.
    session.prsStore
      .loadViewer(feedCtx())
      .then((login) => (viewerLogin = login))
      .catch(() => {});
    session.prsStore
      .loadDetail(feedCtx(), n, { force })
      .then((d) => {
        if (pr.number !== n) return;
        detail = d;
        markPrReviewProfile("detail-ready", { bodyCharacters: d.body.length });
      })
      .catch(() => {
        markLoadFailed(n);
      })
      .finally(() => {
        if (pr.number === n) detailLoading = false;
      });
    session.prsStore
      .loadCommits(feedCtx(), n, { force })
      .then((c) => {
        if (pr.number === n) {
          commits = c;
          markPrReviewProfile("commits-ready", { count: c.length });
        }
      })
      .catch(() => markLoadFailed(n))
      .finally(() => {
        if (pr.number === n) commitsLoading = false;
      });
    session.prsStore
      .loadComments(feedCtx(), n, { force })
      .then((c) => {
        if (pr.number === n) {
          comments = c;
          markPrReviewProfile("comments-ready", { count: c.length });
        }
      })
      .catch(() => markLoadFailed(n))
      .finally(() => {
        if (pr.number === n) commentsLoading = false;
      });
    session.prsStore
      .loadReviewers(feedCtx(), n, { force })
      .then((r) => {
        if (pr.number === n) {
          reviewers = r;
          markPrReviewProfile("reviewers-ready", { count: r.length });
        }
      })
      .catch(() => markLoadFailed(n))
      .finally(() => {
        if (pr.number === n) reviewersLoading = false;
      });
    loadChangedFiles(n, force);
  }

  function loadChangedFiles(n: number, force = false) {
    session.prsStore
      .loadChangedFiles(feedCtx(), n, { force })
      .then((f) => {
        if (pr.number === n) {
          changedFiles = f;
          markPrReviewProfile("changed-files-ready", { count: f.length });
        }
      })
      .catch(() => {
        if (pr.number === n) loadFailed = true;
      })
      .finally(() => {
        if (pr.number === n) filesLoading = false;
      });
  }

  // The Refresh button reloads this tab's data and the parent-owned threads.
  // Exported so the host can force a reload after submitting a review.
  export function refresh() {
    load(true);
    onRefreshThreads?.();
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
    return window.solus.prReplyThread(feedCtx(), pr.number, threadId, body);
  }

  async function resolveThread(threadId: string, resolved: boolean): Promise<void> {
    if (resolved) {
      await window.solus.prResolveThread(feedCtx(), pr.number, threadId);
    } else {
      await window.solus.prUnresolveThread(feedCtx(), pr.number, threadId);
    }
  }

  async function postComment() {
    const body = composer.trim();
    if (!body || posting) return;
    posting = true;
    let commentCreated = false;
    try {
      const n = pr.number;
      await window.solus.prAddIssueComment(feedCtx(), n, body);
      commentCreated = true;
      composer = "";
      // Refetch rather than inventing an optimistic author/id; the server copy
      // is the source of truth and survives a reload.
      const serverComments = await session.prsStore.loadComments(feedCtx(), n, {
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

  /** Queue this PR's review guide in the background (guides are opt-in now);
   *  progress lands back in the shared store's guide-status map. */
  function generateGuide() {
    void session.prsStore.requestGuides(feedCtx(), [pr.number]).catch((err) => {
      toasts.error(
        `Couldn't queue the review guide: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    requestInputFocus();
  }

  async function addressComments() {
    if (!onAddressComments || !addressCommentsReady || addressingComments) return;
    addressingComments = true;
    try {
      await onAddressComments();
    } catch (err) {
      toasts.error(`Couldn't open the fix agent: ${err instanceof Error ? err.message : String(err)}`);
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
    void window.solus.openExternal(prUrl);
    requestInputFocus();
  }
</script>

<div class="h-full min-h-0 overflow-y-auto bg-(--solus-container-bg)">
    {#if anyLoadFailed}
      <div class="mx-auto w-full max-w-[90rem] px-8 pt-4">
        <div
          class="flex items-center gap-2.5 rounded-lg border border-[color:color-mix(in_srgb,var(--solus-art-negative)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--solus-art-negative)_8%,transparent)] px-3 py-2 text-[0.8125rem] text-(--solus-text-secondary)"
          role="alert"
        >
          <span class="min-w-0 flex-1 truncate">
            Couldn't load some of this pull request's data. Check your connection or provider sign-in.
          </span>
          <Button
            type="button"
            variant="ghost"
            class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md py-1 pr-2 pl-1.5 text-xs font-medium text-(--solus-text-primary) transition-colors hover:bg-(--solus-surface-hover)"
            onclick={refresh}
          >
            <ArrowsClockwiseIcon size={12} weight="bold" class="shrink-0" />
            Retry
          </Button>
        </div>
      </div>
    {/if}
    <!-- Capped measure: on wide windows the column centers instead of the
         title and a sparse timeline stretching toward a distant rail. -->
    <div class="mx-auto flex w-full max-w-[90rem] gap-8 px-6 py-7 xl:gap-10 xl:px-8 xl:py-9">
      <!-- ── Main column: title, meta, description, activity, composer ── -->
      <main class="flex min-w-0 flex-1 flex-col">
        <!-- Masthead, Linear-style: no chrome in the header at all — a quiet
             mono eyebrow, the title at full measure, one line of plain-text
             facts. Actions live with the merge-readiness status in the right
             rail (prActions below); a compact copy appears under the meta only
             when the rail is hidden. -->
        <header>
          <p
            class="flex items-center gap-1.5 font-mono text-[0.6875rem] text-(--solus-text-tertiary)"
          >
            <GitPullRequestIcon size={12} weight="bold" class="shrink-0" />
            {pr.repo ? `${pr.repo} ` : ""}#{pr.number}
          </p>

          <h1
            class="mt-2 text-[1.4375rem] leading-8 font-semibold tracking-[-0.02em] text-balance text-(--solus-text-primary)"
          >
            {pr.title}
          </h1>

          <!-- One visual grammar for every fact — plain text separated by
               whitespace, no dots or outlined chips competing for attention. -->
          <div
            class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.8125rem] text-(--solus-text-tertiary)"
          >
            <span class="flex min-w-0 items-center gap-2">
              <PrAvatar
                name={authorName}
                url={authorAvatarUrl}
                size="size-5 text-[0.5625rem]"
              />
              <span class="truncate font-medium text-(--solus-text-secondary)"
                >{authorName}</span
              >
              {#if openedTime}
                <span class="shrink-0">opened {openedTime}</span>
              {/if}
            </span>
            {#if baseRef}
              <!-- head → base, reading in merge direction ("move-func into main"). -->
              <span class="flex min-w-0 items-center gap-1.5 font-mono text-[0.75rem]">
                <GitBranchIcon size={12} class="shrink-0" />
                {#if headBranch}
                  <span class="truncate text-(--solus-text-secondary)">{headBranch}</span>
                  <span class="shrink-0" aria-hidden="true">→</span>
                {/if}
                <span class="truncate text-(--solus-text-secondary)">{baseRef}</span>
              </span>
            {/if}
            {#if stackChain.length > 1}
              <span
                class="flex items-center gap-1.5 tabular-nums"
                aria-label={`Stack containing PR #${pr.number}`}
              >
                <span class="font-medium">Stack</span>
                {#each stackChain as number, i (number)}
                  {#if i > 0}<span aria-hidden="true">→</span>{/if}
                  <span
                    class={number === pr.number
                      ? "font-semibold text-(--solus-accent)"
                      : "text-(--solus-text-secondary)"}
                  >#{number}</span>
                {/each}
              </span>
            {/if}
          </div>

          <!-- The rail owns the actions on wide windows; when it's hidden the
               same cluster docks here at rail width so nothing is lost. -->
          <div class="mt-6 w-full max-w-[19rem] lg:hidden">
            {@render prActions()}
          </div>
        </header>

        <!-- PR description belongs to the PR header, not the activity stream. -->
        {#if detailLoading}
          <div class="mt-6 flex flex-col gap-2.5">
            <Skeleton class="h-3 w-full rounded bg-(--solus-art-border)" />
            <Skeleton class="h-3 w-11/12 rounded bg-(--solus-art-border)" />
            <Skeleton class="h-3 w-3/4 rounded bg-(--solus-art-border)" />
          </div>
        {:else if detail?.body?.trim()}
          <!-- Masthead rule: closes the title/meta block before the body copy. -->
          <div
            class="mt-5 h-px w-full bg-[linear-gradient(to_right,var(--solus-art-border),transparent)]"
            aria-hidden="true"
          ></div>
          <section
            class="github-markdown prose-cloud mt-5 text-base leading-relaxed text-pretty text-(--solus-text-secondary) [--solus-font-weight-body:400]"
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
        <div class="mt-9 mb-6 flex items-center gap-3">
          <h2
            class="text-[0.6875rem] font-semibold tracking-[0.14em] text-(--solus-text-tertiary) uppercase"
          >
            Activity
          </h2>
          <span
            class="h-px flex-1 bg-[linear-gradient(to_right,var(--solus-art-border),transparent)]"
            aria-hidden="true"
          ></span>
          <!-- Quiet focus chips: filter the timeline without leaving the tab.
               A couple of events don't need filtering, so the chips only appear
               once the timeline is long enough for them to earn their spot; the
               unresolved toggle is a real signal and always shows. The active
               chip gets a hairline ring so it reads pressed, not hovered. -->
          <div
            class="flex items-center gap-1"
            role="group"
            aria-label="Filter activity"
          >
            {#if timeline.length > 3}
              {#each filterChips as chip (chip.value)}
                <Button
                  type="button"
                  variant="ghost"
                  aria-pressed={!unresolvedOnly && filter === chip.value}
                  class="cursor-pointer rounded-md px-2 py-1 text-[0.6875rem] font-medium transition-colors {!unresolvedOnly &&
                  filter === chip.value
                    ? 'bg-(--solus-accent-light) text-(--solus-text-primary) shadow-[0_0_0_1px_var(--solus-art-border)]'
                    : 'text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                  onclick={() => setFilter(chip.value)}
                >
                  {chip.label}
                </Button>
              {/each}
            {/if}
            {#if unresolvedCount > 0}
              <Button
                type="button"
                variant="ghost"
                aria-pressed={unresolvedOnly}
                class="cursor-pointer rounded-md px-2 py-1 text-[0.6875rem] font-medium tabular-nums transition-colors {unresolvedOnly
                  ? 'bg-(--solus-accent-light) text-(--solus-text-primary) shadow-[0_0_0_1px_var(--solus-art-border)]'
                  : 'text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
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
          onReply={replyToThread}
          onResolve={resolveThread}
        />

        <!-- Composer: aligned with the timeline's content column and
             hairline-ringed like the thread panels so it reads as part of the
             editorial system. -->
        <div
          class="mt-6 ml-11 flex items-center gap-2.5 rounded-xl bg-white/60 p-2.5 pr-3 shadow-[0_0_0_1px_var(--solus-art-border)] transition-[box-shadow] duration-150 ease-out focus-within:shadow-[0_0_0_1px_var(--solus-accent)] dark:bg-white/2"
        >
          <PrAvatar
            name={viewerLogin || "?"}
            url={viewerAvatarUrl}
            size="size-6 text-[0.625rem]"
          />
          <MarkdownEditor
            value={composer}
            onValueChange={(md) => (composer = md)}
            onKeyDown={onComposerKey}
            enterInsertsNewline
            hidePlaceholderOnFocus
            maxHeight={160}
            placeholder="Write a comment…"
            class={composerFieldClass}
          />
          <Button
            type="button"
            disabled={!composer.trim() || posting}
            class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-(--solus-accent) text-(--solus-on-accent,#fff) transition-[opacity,scale] duration-150 ease-out hover:opacity-90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Post comment"
            title="Comment · ⌘↵"
            onclick={postComment}
          >
            <ArrowUpIcon size={15} weight="bold" />
          </Button>
        </div>
      </main>

      <!-- ── Right rail: status + actions, reviewers, changed files ── -->
      <PrActivityRail
        {detail}
        {reviewers}
        {reviewersLoading}
        {changedFiles}
        {filesLoading}
        {openedTime}
        {checks}
        {unresolvedCount}
        onFileJump={(path) => jumpToFile(path)}
        actions={prActions}
      />
    </div>
</div>

{#snippet prActions()}
  <PrActions
    pr={{ number: pr.number, title: pr.title, host: pr.host }}
    {detail}
    {showRemoteLink}
    {prUrl}
    {feedbackCount}
    {guideStatus}
    onGenerateGuide={generateGuide}
    {addressCommentsReady}
    {addressingComments}
    onAddressComments={onAddressComments ? addressComments : undefined}
    {onChat}
    getCtx={feedCtx}
    onOpenRemote={openPr}
    onRefresh={refresh}
  />
{/snippet}
