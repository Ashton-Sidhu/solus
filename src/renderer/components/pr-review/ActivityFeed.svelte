<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    ArrowsClockwiseIcon,
    GitPullRequestIcon,
    ArrowRightIcon,
    ArrowUpIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { CommentEditor } from "../ui/comment-editor";
  import type { ChangedFileStat, IpcContext } from "../../../shared/types";
  import type {
    ReviewThread,
    ReviewComment,
    PullRequestDetail,
    PrCommit,
    PrConversationItem,
    PrReviewer,
  } from "../../../shared/providers";
  import { getWorkspaceContext, toasts } from "../../contexts";
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
    "flex-1 min-w-0 [&_.cm-content]:![padding:0.25rem_0] [&_.cm-content]:![min-height:1.25rem] [&_.cm-content]:![font-weight:400]";

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
    void session.prsStore
      .requestGuides(feedCtx(), [pr.number], {
        onSettled: ({ failed }) => {
          if (failed > 0) {
            toasts.error(
              `Review guide generation failed for PR #${pr.number}. Try again from Activity or Guide.`,
            );
          } else {
            toasts.success(
              `Review guide for PR #${pr.number} is ready in the Guide tab.`,
            );
          }
        },
      })
      .catch((err) => {
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

<div class="h-full min-h-0 overflow-y-auto bg-card">
    {#if anyLoadFailed}
      <div
        class="mx-auto w-full max-w-[min(1384px,100%)] px-[clamp(20px,2.6vw,56px)] pt-4"
      >
        <div
          class="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3 text-[12.5px]"
          role="alert"
        >
          <span class="min-w-0 flex-1 truncate">
            Couldn't load some of this pull request's data. Check your connection or provider sign-in.
          </span>
          <Button
            type="button"
            variant="ghost"
            class="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onclick={refresh}
          >
            <ArrowsClockwiseIcon size={12} class="shrink-0" />
            Retry
          </Button>
        </div>
      </div>
    {/if}
    <!-- Capped measure: on wide windows the column centers instead of the
         title and a sparse timeline stretching toward a distant rail. The row
         is the size container the rail queries, so the rail folds under the
         main column on narrow panes instead of disappearing. -->
    <div
      class="@container mx-auto flex w-full max-w-[min(1384px,100%)] flex-wrap gap-[clamp(24px,3vw,64px)] px-[clamp(20px,2.6vw,56px)] pt-[clamp(20px,1.8vw,32px)] pb-[clamp(32px,3vw,56px)]"
    >
      <!-- ── Main column: title, meta, description, activity, composer ── -->
      <main class="flex min-w-0 max-w-[1000px] flex-[1_1_520px] flex-col">
        <!-- Masthead, Linear-style: no chrome in the header at all — a quiet
             mono eyebrow, the title at full measure, one line of plain-text
             facts. Actions live with the merge-readiness status in the right
             rail (prActions below), which folds under this column rather than
             hiding, so they are reachable at every width. -->
        <header>
          <p
            class="flex items-center gap-2 font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase"
          >
            <GitPullRequestIcon size={10} class="shrink-0 text-primary" />
            <span class="min-w-0 truncate"
              >{pr.repo ? `${pr.repo} ` : ""}#{pr.number}</span
            >
          </p>

          <h1
            class="mt-3 text-[27px] leading-[1.25] font-semibold tracking-[-0.02em] text-pretty"
          >
            {pr.title}
          </h1>

          <div
            class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-muted-foreground"
          >
            <span class="flex min-w-0 items-center gap-2">
              <PrAvatar
                name={authorName}
                url={authorAvatarUrl}
                size="size-5 text-[9.5px]"
              />
              <span class="truncate font-medium text-foreground">{authorName}</span>
              {#if openedTime}
                <span class="shrink-0">opened {openedTime}</span>
              {/if}
            </span>
            {#if baseRef}
              <span class="opacity-40" aria-hidden="true">·</span>
              <!-- head → base, reading in merge direction ("move-func into main").
                   A filled mono pill: the refs are literals you might type, so
                   they get a surface of their own rather than sitting in prose. -->
              <span
                class="flex min-w-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-[10.5px] text-muted-foreground"
              >
                {#if headBranch}
                  <span class="truncate">{headBranch}</span>
                  <ArrowRightIcon size={10} class="shrink-0" aria-hidden="true" />
                {/if}
                <span class="truncate text-foreground">{baseRef}</span>
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
          </div>
        </header>

        <!-- PR description belongs to the PR header, not the activity stream. -->
        {#if detailLoading}
          <div class="mt-8 flex flex-col gap-2.5">
            <Skeleton class="h-3 w-full rounded bg-muted" />
            <Skeleton class="h-3 w-11/12 rounded bg-muted" />
            <Skeleton class="h-3 w-3/4 rounded bg-muted" />
          </div>
        {:else if detail?.body?.trim()}
          <!-- No rule under the masthead: the spacing steps (4 → 8) already
               close the title block, and a hairline here would be the only one
               above the timeline's spine. -->
          <!-- Typography lives in `.prose-pr-description` (index.css), not in
               utilities here: the `.prose-cloud` rules are unlayered, so a
               utility override of any property they set — size, leading,
               colour, heading margins — loses the cascade regardless of order. -->
          <section
            class="github-markdown prose-cloud prose-pr-description mt-8"
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
            class="text-[9.5px] font-medium tracking-widest text-muted-foreground uppercase"
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
                    class="h-full cursor-pointer rounded-md border-0 px-2.5 text-[12px] transition-colors {!unresolvedOnly &&
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
                class="h-7 cursor-pointer rounded-lg border-0 px-2.5 text-[12px] font-medium tabular-nums transition-colors {unresolvedOnly
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
          onReply={replyToThread}
          onResolve={resolveThread}
        />

        <!-- Composer: full measure of the main column, flush with the title and
             description rather than indented to the timeline's content column —
             it addresses the PR, not the last event. A flat muted pill rather
             than a ringed panel; the timeline already carries the page's only
             hairlines, so a second outline here reads as chrome. The send
             button is a tinted accent square, not a solid fill: at this size a
             saturated block outweighs everything above it. -->
        <div
          class="mt-8 flex items-center gap-3 rounded-xl bg-muted px-3.5 py-2.5 transition-shadow focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_14%,transparent)]"
        >
          <PrAvatar
            name={viewerLogin || "?"}
            url={viewerAvatarUrl}
            size="size-6 text-[10.5px]"
          />
          <CommentEditor
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
            class="flex size-[28px] shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-[color:color-mix(in_oklab,var(--primary)_14%,transparent)] text-primary transition-colors hover:bg-[color:color-mix(in_oklab,var(--primary)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Post comment"
            title="Comment · ⌘↵"
            onclick={postComment}
          >
            <ArrowUpIcon size={13} weight="bold" />
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
