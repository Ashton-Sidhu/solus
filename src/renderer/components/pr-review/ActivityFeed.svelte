<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    CheckCircleIcon,
    GitPullRequestIcon,
    GitBranchIcon,
    ChatCircleIcon,
    ArrowUpIcon,
    CaretRightIcon,
    GitCommitIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import type { ChangedFileStat } from "../../../shared/types";
  import type {
    ReviewThread,
    ReviewComment,
    PullRequestDetail,
    PrCommit,
    PrReviewer,
  } from "../../../shared/providers";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { toasts } from "../../contexts/toast.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import { tooltip } from "../../lib/tooltip";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import type { PrActivityTarget, PostedComment } from "./lib/activity-data";
  import {
    buildActivityTimeline,
    activityEventKey,
    commitRunAuthorLabel,
  } from "./lib/activity-data";
  import PrActivityRail from "./PrActivityRail.svelte";
  import PrThreadCard from "./PrThreadCard.svelte";
  import MergeControl from "./MergeControl.svelte";

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
    onJump,
    onRefreshThreads,
  }: {
    pr: PrActivityTarget;
    /** Review threads, owned by the parent so the Diff tab and this timeline
     *  share one fetch (and one set of objects — reply/resolve mutate in place). */
    threads: ReviewThread[];
    /** The parent's thread fetch failed — folded into this tab's error banner. */
    threadsFailed?: boolean;
    /** Jump to a thread's / file's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    /** Refetch the shared threads (e.g. from this tab's Refresh button). */
    onRefreshThreads?: () => void;
  } = $props();

  const session = getWorkspaceContext();

  let detail = $state<PullRequestDetail | null>(null);
  let commits = $state<PrCommit[]>([]);
  let reviewers = $state<PrReviewer[]>([]);
  let changedFiles = $state<ChangedFileStat[]>([]);
  // Per-section loading so each region fills in as its own request resolves,
  // rather than the whole tab waiting on the slowest call. Threads come from the
  // parent (no flag here); the opened event + composer render immediately.
  let detailLoading = $state(true);
  let commitsLoading = $state(true);
  let reviewersLoading = $state(true);
  let filesLoading = $state(true);
  // Any of the four loads rejecting (expired token, network) flips this so the
  // tab shows an explicit error + retry instead of masquerading as an empty PR.
  let loadFailed = $state(false);
  const anyLoadFailed = $derived(loadFailed || threadsFailed);

  // Comments posted from the composer this session — appended optimistically so
  // they show in the timeline even though listReviewThreads only returns inline
  // threads (not conversation-level comments).
  let posted = $state<PostedComment[]>([]);

  let composer = $state("");
  let posting = $state(false);

  const markdownRenderers = { codespan: CodeSpan };

  // Composer styled like the message composer: bare field inside its own pill,
  // forced 400 weight so typed text never reads bold.
  const composerFieldClass =
    "flex-1 min-w-0 [&_.solus-md-editor_.ProseMirror]:![padding:0.25rem_0] [&_.solus-md-editor_.ProseMirror]:![min-height:1.25rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![top:0.25rem] [&_.solus-md-placeholder]:![left:0]";

  const openedTime = $derived(
    detail
      ? formatTimeAgoFromTimestamp(new Date(detail.createdAt).getTime())
      : null,
  );
  const authorName = $derived(detail?.author ?? pr.owner ?? "");
  const authorAvatarUrl = $derived(
    detail?.authorAvatarUrl ?? pr.authorAvatarUrl ?? "",
  );
  const baseRef = $derived(pr.baseRef ?? detail?.baseRef ?? "");
  const headBranch = $derived(pr.branch ?? detail?.headRef ?? "");
  const headSha = $derived(pr.headSha ?? detail?.headSha ?? "");
  // Commits, review threads, and this session's comments, merged into one
  // chronological timeline (see buildActivityTimeline). The opened event is
  // rendered separately as the fixed first row and always leads.
  const timeline = $derived(buildActivityTimeline(commits, threads, posted));

  function markLoadFailed(n: number) {
    if (pr.number === n) loadFailed = true;
  }

  // Fire each request independently and let its section fill in on resolve — no
  // shared gate, so a slow call (threads, the change set) never holds back the
  // fast ones. `n` guards against a PR switch mid-flight clobbering newer data.
  function load(force = false) {
    const n = pr.number;
    detail = null;
    commits = [];
    reviewers = [];
    changedFiles = [];
    loadFailed = false;
    detailLoading = commitsLoading = reviewersLoading = filesLoading = true;

    session.prsStore
      .loadDetail(session.ctx, n, { force })
      .then((d) => {
        if (pr.number !== n) return;
        detail = d;
        if (!pr.baseSha) loadChangedFiles(d.baseSha, n, force);
      })
      .catch(() => {
        markLoadFailed(n);
        if (pr.number === n && !pr.baseSha) filesLoading = false;
      })
      .finally(() => {
        if (pr.number === n) detailLoading = false;
      });
    session.prsStore
      .loadCommits(session.ctx, n, { force })
      .then((c) => {
        if (pr.number === n) commits = c;
      })
      .catch(() => markLoadFailed(n))
      .finally(() => {
        if (pr.number === n) commitsLoading = false;
      });
    session.prsStore
      .loadReviewers(session.ctx, n, { force })
      .then((r) => {
        if (pr.number === n) reviewers = r;
      })
      .catch(() => markLoadFailed(n))
      .finally(() => {
        if (pr.number === n) reviewersLoading = false;
      });
    if (pr.baseSha) loadChangedFiles(pr.baseSha, n, force);
  }

  function isCurrentChangedFilesLoad(sha: string, n: number) {
    return pr.number === n && (pr.baseSha || detail?.baseSha) === sha;
  }

  function loadChangedFiles(sha: string, n: number, force = false) {
    session.prsStore
      .loadChangedFiles(session.ctx, sha, { force })
      .then((f) => {
        if (isCurrentChangedFilesLoad(sha, n)) changedFiles = f;
      })
      .catch(() => {
        if (isCurrentChangedFilesLoad(sha, n)) loadFailed = true;
      })
      .finally(() => {
        if (isCurrentChangedFilesLoad(sha, n)) filesLoading = false;
      });
  }

  // The Refresh button reloads this tab's data and the parent-owned threads.
  // Exported so the host can force a reload after submitting a review — the
  // just-posted comments/review state should appear without a manual refresh.
  export function refresh() {
    load(true);
    onRefreshThreads?.();
  }

  $effect(() => {
    void pr.number;
    load();
  });

  // Reply / resolve state lives in each PrThreadCard; the feed only supplies
  // the RPCs bound to this PR.
  function replyToThread(threadId: string, body: string): Promise<ReviewComment> {
    return window.solus.prReplyThread(session.ctx, pr.number, threadId, body);
  }

  async function resolveThread(threadId: string, resolved: boolean): Promise<void> {
    if (resolved) {
      await window.solus.prResolveThread(session.ctx, pr.number, threadId);
    } else {
      await window.solus.prUnresolveThread(session.ctx, pr.number, threadId);
    }
  }

  async function postComment() {
    const body = composer.trim();
    if (!body || posting) return;
    posting = true;
    try {
      await window.solus.prSubmitReview(session.ctx, pr.number, {
        body,
        event: "COMMENT",
        commitId: headSha,
        comments: [],
      });
      // "You", not the PR author — the viewer wrote this comment, and there is
      // no viewer-identity API yet to resolve the real login.
      posted.push({
        id: crypto.randomUUID(),
        author: "You",
        body,
        ts: Date.now(),
      });
      composer = "";
      // Posting goes through the review API, so the viewer's review state may
      // change — refresh the rail quietly (no full-tab reload).
      const n = pr.number;
      void session.prsStore
        .loadReviewers(session.ctx, n, { force: true })
        .then((r) => {
          if (pr.number === n) reviewers = r;
        })
        .catch(() => {});
    } catch (err) {
      toasts.error(
        `Couldn't post comment: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      posting = false;
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
</script>

<div class="h-full min-h-0 overflow-y-auto">
    {#if anyLoadFailed}
      <div class="mx-auto w-full max-w-[92rem] px-8 pt-4">
        <div
          class="flex items-center gap-2.5 rounded-lg border border-[color:color-mix(in_srgb,var(--solus-art-negative)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--solus-art-negative)_8%,transparent)] px-3 py-2 text-[0.8125rem] text-(--solus-text-secondary)"
          role="alert"
        >
          <span class="min-w-0 flex-1 truncate">
            Couldn't load some of this pull request's data. Check your connection or provider sign-in.
          </span>
          <button
            type="button"
            class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md py-1 pr-2 pl-1.5 text-xs font-medium text-(--solus-text-primary) transition-colors hover:bg-(--solus-accent-light)"
            onclick={refresh}
          >
            <ArrowsClockwiseIcon size={12} weight="bold" class="shrink-0" />
            Retry
          </button>
        </div>
      </div>
    {/if}
    <div class="mx-auto flex w-full max-w-[92rem] gap-10 px-8 py-9">
      <!-- ── Main column: title, meta, description, activity, composer ── -->
      <main class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-start justify-between gap-3">
          <h1
            class="text-xl font-semibold tracking-tight text-balance text-(--solus-text-primary)"
          >
            {pr.title}
          </h1>
          <div class="flex shrink-0 items-start gap-2">
            {#if detail?.state === "open" && !detail.draft}
              <MergeControl pr={{ number: pr.number, title: pr.title }} />
            {/if}
            <button
              type="button"
              class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) active:scale-95"
              aria-label="Refresh activity"
              use:tooltip={"Refresh"}
              onclick={refresh}
            >
              <ArrowsClockwiseIcon size={15} />
            </button>
          </div>
        </div>

        <!-- Author / branch meta -->
        <div
          class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-(--solus-text-tertiary)"
        >
          <PrAvatar
            name={authorName}
            url={authorAvatarUrl}
            size="size-5 text-[0.5625rem]"
          />
          <span class="font-medium text-(--solus-text-secondary)"
            >{authorName}</span
          >
          <span aria-hidden="true">·</span>
          <span class="font-mono text-[0.75rem]">{pr.repo ? `${pr.repo}#` : "#"}{pr.number}</span>
          {#if baseRef}
            <span aria-hidden="true">·</span>
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <span
                class="inline-flex items-center gap-1 rounded-md bg-(--solus-art-raised) py-0.5 pr-1.5 pl-1 font-mono text-[0.6875rem] text-(--solus-text-secondary)"
              >
                <GitBranchIcon size={11} class="shrink-0" />
                {baseRef}
              </span>
              {#if headBranch}
                <span aria-hidden="true">←</span>
                <span
                  class="truncate rounded-md bg-(--solus-art-raised) px-1.5 py-0.5 font-mono text-[0.6875rem] text-(--solus-text-secondary)"
                  >{headBranch}</span
                >
              {/if}
            </span>
          {/if}
        </div>

        <!-- Description -->
        {#if detailLoading}
          <div
            class="mt-8 flex animate-pulse flex-col gap-2.5 motion-reduce:animate-none"
          >
            <div class="h-3 w-full rounded bg-(--solus-art-border)"></div>
            <div class="h-3 w-11/12 rounded bg-(--solus-art-border)"></div>
            <div class="h-3 w-3/4 rounded bg-(--solus-art-border)"></div>
          </div>
        {:else if detail?.body?.trim()}
          <details open class="group mt-7">
            <summary
              class="flex w-fit cursor-pointer list-none items-center gap-1 text-[0.75rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase select-none hover:text-(--solus-text-secondary)"
            >
              <CaretRightIcon
                size={11}
                weight="bold"
                class="transition-transform duration-150 group-open:rotate-90"
              />
              Description
            </summary>
            <div
              class="prose-cloud mt-3 text-base leading-relaxed text-(--solus-text-primary) [--solus-font-weight-body:400]"
            >
              <SvelteMarkdown
                source={detail.body}
                renderers={markdownRenderers}
                sanitizeUrl={remoteMarkdownSanitizeUrl}
              />
            </div>
          </details>
        {/if}

        <!-- Activity timeline -->
        <h2
          class="mt-8 mb-4 text-[0.75rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase"
        >
          Activity
        </h2>

        <ol class="flex flex-col" role="list">
          <!-- Opened event -->
          <li class="relative flex gap-3">
            <div class="flex flex-col items-center">
              <span
                class="grid size-6 shrink-0 place-items-center rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)] text-(--solus-art-positive)"
              >
                <GitPullRequestIcon size={13} weight="bold" />
              </span>
              {#if timeline.length > 0}
                <span class="my-1 w-px flex-1 bg-(--solus-art-border)"></span>
              {/if}
            </div>
            <p
              class="mt-0.5 pb-6 text-[0.8125rem] text-(--solus-text-secondary)"
            >
              <span class="font-medium text-(--solus-text-primary)"
                >{authorName}</span
              >
              opened this pull request{#if openedTime}<span
                  class="text-(--solus-text-tertiary)"
                >
                  · {openedTime}</span
                >{/if}
            </p>
          </li>

          <!-- Commits, review threads, and session comments, interleaved by
               time (see buildActivityTimeline). The connector threads through
               every row but the last. -->
          {#each timeline as event, i (activityEventKey(event))}
            {@const isLast = i === timeline.length - 1}
            {#if event.kind === "commits"}
              <li class="relative flex gap-3">
                <div class="flex flex-col items-center">
                  <span
                    class="grid size-6 shrink-0 place-items-center rounded-full bg-(--solus-art-raised) text-(--solus-text-tertiary)"
                  >
                    <GitCommitIcon size={13} weight="bold" />
                  </span>
                  {#if !isLast}
                    <span class="my-1 w-px flex-1 bg-(--solus-art-border)"></span>
                  {/if}
                </div>
                <div class="mt-0.5 min-w-0 flex-1 pb-6">
                  <p class="text-[0.8125rem] text-(--solus-text-secondary)">
                    <span class="font-medium text-(--solus-text-primary)"
                      >{commitRunAuthorLabel(event.commits, authorName)}</span
                    >
                    added {event.commits.length}
                    {event.commits.length === 1
                      ? "commit"
                      : "commits"}<span class="text-(--solus-text-tertiary)">
                      · {formatTimeAgoFromTimestamp(event.ts)}</span
                    >
                  </p>
                  <ul
                    class="mt-2.5 flex flex-col divide-y divide-(--solus-art-border) overflow-hidden rounded-xl border border-(--solus-art-border) bg-white dark:bg-white/3"
                    role="list"
                  >
                    {#each event.commits as commit (commit.sha)}
                      <li class="flex items-center gap-2.5 px-3 py-2">
                        <GitCommitIcon
                          size={13}
                          weight="bold"
                          class="shrink-0 text-(--solus-text-tertiary)"
                        />
                        <span
                          class="min-w-0 flex-1 truncate text-[0.8125rem] text-(--solus-text-secondary)"
                          >{commit.message}</span
                        >
                        <span
                          class="max-w-36 shrink truncate text-[0.75rem] font-medium text-(--solus-text-tertiary)"
                          >{commit.author || authorName}</span
                        >
                        <code
                          class="shrink-0 rounded-md bg-(--solus-art-raised) px-1.5 py-0.5 font-mono text-[0.6875rem] text-(--solus-text-tertiary)"
                          >{commit.sha.slice(0, 7)}</code
                        >
                      </li>
                    {/each}
                  </ul>
                </div>
              </li>
            {:else if event.kind === "thread"}
              <li class="relative flex gap-3">
                <div class="flex flex-col items-center">
                  <span
                    class={event.thread.isResolved
                      ? "grid size-6 shrink-0 place-items-center rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)] text-(--solus-art-positive)"
                      : "grid size-6 shrink-0 place-items-center rounded-full bg-(--solus-art-raised) text-(--solus-text-tertiary)"}
                  >
                    {#if event.thread.isResolved}
                      <CheckCircleIcon size={13} weight="fill" />
                    {:else}
                      <ChatCircleIcon size={13} weight="fill" />
                    {/if}
                  </span>
                  {#if !isLast}
                    <span class="my-1 w-px flex-1 bg-(--solus-art-border)"></span>
                  {/if}
                </div>

                <div class="-mt-1 min-w-0 flex-1 pb-6">
                  <PrThreadCard
                    thread={event.thread}
                    onJump={jumpToFile}
                    onReply={replyToThread}
                    onResolve={resolveThread}
                  />
                </div>
              </li>
            {:else}
              <li class="relative flex gap-3">
                <div class="flex flex-col items-center">
                  <PrAvatar name={event.comment.author} size="size-6 text-[0.625rem]" />
                  {#if !isLast}
                    <span class="my-1 w-px flex-1 bg-(--solus-art-border)"></span>
                  {/if}
                </div>
                <div class="mt-0.5 min-w-0 flex-1 pb-6">
                  <div class="mb-1 text-[0.8125rem]">
                    <span class="font-medium text-(--solus-text-primary)"
                      >{event.comment.author}</span
                    >
                    <span class="text-(--solus-text-tertiary)">
                      · {formatTimeAgoFromTimestamp(event.comment.ts)}</span
                    >
                  </div>
                  <p
                    class="text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-(--solus-text-secondary)"
                  >
                    {event.comment.body}
                  </p>
                </div>
              </li>
            {/if}
          {/each}
        </ol>

        <!-- Composer -->
        <div
          class="mt-3 flex items-center gap-2.5 rounded-xl border border-(--solus-art-border) bg-white px-3 py-2.5 focus-within:border-(--solus-accent) dark:bg-white/3"
        >
          <PrAvatar name="You" size="size-6 text-[0.625rem]" />
          <MarkdownEditor
            value={composer}
            onValueChange={(md) => (composer = md)}
            onKeyDown={onComposerKey}
            enterInsertsNewline
            hidePlaceholderOnFocus
            maxHeight={160}
            placeholder="Leave a comment…"
            class={composerFieldClass}
          />
          <button
            type="button"
            disabled={!composer.trim() || posting}
            class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-(--solus-accent) text-(--solus-on-accent,#fff) transition-[opacity,scale] duration-150 ease-out hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Post comment"
            use:tooltip={"Comment · ⌘↵"}
            onclick={postComment}
          >
            <ArrowUpIcon size={15} weight="bold" />
          </button>
        </div>
      </main>

      <!-- ── Right rail: status + meta, changed files ── -->
      <PrActivityRail
        {detail}
        {reviewers}
        {reviewersLoading}
        {changedFiles}
        {filesLoading}
        {openedTime}
        onFileJump={(path) => jumpToFile(path)}
      />
    </div>
</div>
