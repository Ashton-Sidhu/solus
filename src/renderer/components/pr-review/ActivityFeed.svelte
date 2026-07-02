<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    CheckCircleIcon,
    ArrowBendUpLeftIcon,
    GitPullRequestIcon,
    GitMergeIcon,
    GitBranchIcon,
    ChatCircleIcon,
    SmileyIcon,
    PaperclipIcon,
    ArrowUpIcon,
    CaretRightIcon,
    CaretDownIcon,
    FileIcon,
    GitCommitIcon,
  } from "phosphor-svelte";
  import { SvelteSet } from "svelte/reactivity";
  import Icon from "@iconify/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import type { PrReviewContext, ChangedFileStat } from "../../../shared/types";
  import type {
    ReviewThread,
    PullRequestDetail,
    PrCommit,
    PrReviewer,
  } from "../../../shared/providers";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { toasts } from "../../contexts/toast.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { formatTimeAgoFromTimestamp } from "../../lib/sessionUtils";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import { tooltip } from "../../lib/tooltip";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../diagram/iconify";
  import {
    hunkToPatch,
    initials,
    fileName,
    dirName,
  } from "./lib/activity-data";
  import GuideFileDiff from "./guide/GuideFileDiff.svelte";

  // Register the lazy (~12MB) `logos` icon set so changed-file rows can resolve
  // their vibrant brand icon. Idempotent and shared across the app.
  ensureIconCollections();

  // The Activity tab: a Linear-style PR overview. The centered main column shows
  // the title, author/branch meta, the PR description, and an activity timeline
  // (open event + existing GitHub review threads, each still repliable /
  // resolvable). The right rail summarises status, reviewers, resolves, and the
  // changed files. Pending local drafts live in the submit tray, not here.
  let {
    pr,
    threads,
    threadsFailed = false,
    onJump,
    onRefreshThreads,
  }: {
    pr: PrReviewContext;
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
  let posted = $state<
    { id: string; author: string; body: string; ts: number }[]
  >([]);

  let replyingTo = $state<string | null>(null);
  let replyText = $state("");
  let busy = $state<string | null>(null);
  let composer = $state("");
  let posting = $state(false);
  let filesExpanded = $state(false);

  // A resolved thread collapses to a "Marked as resolved" bar (hiding its diff
  // hunk + conversation), matching the inline Diff tab. This tracks the ones the
  // user re-expanded; a resolved thread not in the set renders collapsed.
  const expandedThreads = new SvelteSet<string>();
  const threadCollapsed = (t: ReviewThread) =>
    t.isResolved && !expandedThreads.has(t.id);

  const markdownRenderers = { codespan: CodeSpan };
  const FILES_PREVIEW = 6;

  // Markdown comment inputs styled like the message composer: forced 400 weight
  // so typed text never reads bold. The reply box is a bordered transparent
  // field; the composer is bare and sits inside its own pill.
  const replyFieldClass =
    "rounded-lg border border-(--solus-art-border) bg-transparent px-2.5 transition-colors focus-within:border-(--solus-accent) [&_.solus-md-editor_.ProseMirror]:![min-height:2.5rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![left:0.875rem]";
  const composerFieldClass =
    "flex-1 min-w-0 [&_.solus-md-editor_.ProseMirror]:![padding:0.25rem_0] [&_.solus-md-editor_.ProseMirror]:![min-height:1.25rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![top:0.25rem] [&_.solus-md-placeholder]:![left:0]";
  const sidebarPanelBg =
    "bg-[color:color-mix(in_srgb,var(--solus-container-bg)_90%,color-mix(in_srgb,var(--solus-input-pill-bg)_70%,var(--solus-surface-primary))_10%)]";

  const openedTime = $derived(
    detail
      ? formatTimeAgoFromTimestamp(new Date(detail.updatedAt).getTime())
      : null,
  );
  // The commit group is stamped with its most recent commit, like GitHub's "added N commits".
  const commitsTime = $derived(
    commits.length
      ? formatTimeAgoFromTimestamp(
          new Date(commits[commits.length - 1].committedAt).getTime(),
        )
      : null,
  );
  const hasTimelineAfterOpened = $derived(
    commits.length > 0 || threads.length > 0 || posted.length > 0,
  );
  const visibleFiles = $derived(
    filesExpanded ? changedFiles : changedFiles.slice(0, FILES_PREVIEW),
  );
  const moreFiles = $derived(Math.max(0, changedFiles.length - FILES_PREVIEW));

  const totalAdds = $derived(
    changedFiles.reduce((sum, f) => sum + f.additions, 0),
  );
  const totalDels = $derived(
    changedFiles.reduce((sum, f) => sum + f.deletions, 0),
  );
  const addPct = $derived(
    totalAdds + totalDels > 0 ? (totalAdds / (totalAdds + totalDels)) * 100 : 0,
  );

  const statusBadge = $derived.by(() => {
    if (!detail) return null;
    if (detail.draft && detail.state === "open")
      return {
        label: "Draft",
        Icon: GitBranchIcon,
        tone: "var(--solus-text-tertiary)",
      };
    if (detail.state === "merged")
      return {
        label: "Merged",
        Icon: GitMergeIcon,
        tone: "var(--solus-accent)",
      };
    if (detail.state === "closed")
      return {
        label: "Closed",
        Icon: GitPullRequestIcon,
        tone: "var(--solus-art-negative)",
      };
    return {
      label: "Open",
      Icon: GitPullRequestIcon,
      tone: "var(--solus-art-positive)",
    };
  });

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

    const failed = () => {
      if (pr.number === n) loadFailed = true;
    };

    session.prsStore
      .loadDetail(session.ctx, n, { force })
      .then((d) => {
        if (pr.number === n) detail = d;
      })
      .catch(failed)
      .finally(() => {
        if (pr.number === n) detailLoading = false;
      });
    session.prsStore
      .loadCommits(session.ctx, n, { force })
      .then((c) => {
        if (pr.number === n) commits = c;
      })
      .catch(failed)
      .finally(() => {
        if (pr.number === n) commitsLoading = false;
      });
    session.prsStore
      .loadReviewers(session.ctx, n, { force })
      .then((r) => {
        if (pr.number === n) reviewers = r;
      })
      .catch(failed)
      .finally(() => {
        if (pr.number === n) reviewersLoading = false;
      });
    window.solus
      .prChangedFiles(session.ctx, pr.baseSha)
      .then((f) => {
        if (pr.number === n) changedFiles = f;
      })
      .catch(failed)
      .finally(() => {
        if (pr.number === n) filesLoading = false;
      });
  }

  // The Refresh button reloads this tab's data and the parent-owned threads.
  function refresh() {
    load(true);
    onRefreshThreads?.();
  }

  $effect(() => {
    void pr.number;
    load();
  });

  async function submitReply(thread: ReviewThread) {
    const body = replyText.trim();
    if (!body) return;
    busy = thread.id;
    try {
      const comment = await window.solus.prReplyThread(
        session.ctx,
        pr.number,
        thread.id,
        body,
      );
      thread.comments.push(comment);
      replyingTo = null;
      replyText = "";
    } catch (err) {
      toasts.error(
        `Reply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busy = null;
    }
  }

  async function toggleResolved(thread: ReviewThread) {
    busy = thread.id;
    try {
      if (thread.isResolved) {
        await window.solus.prUnresolveThread(session.ctx, pr.number, thread.id);
        thread.isResolved = false;
      } else {
        await window.solus.prResolveThread(session.ctx, pr.number, thread.id);
        thread.isResolved = true;
        // Always collapse on resolve, even if it had been expanded before.
        expandedThreads.delete(thread.id);
      }
    } catch (err) {
      toasts.error(
        `Couldn't update thread: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      busy = null;
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
        commitId: pr.headSha,
        comments: [],
      });
      posted.push({
        id: crypto.randomUUID(),
        author: detail?.author ?? "You",
        body,
        ts: Date.now(),
      });
      composer = "";
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

{#snippet avatar(name: string, size: string)}
  <span
    class="grid shrink-0 place-items-center rounded-full bg-(--solus-accent) font-semibold text-(--solus-on-accent,#fff) {size}"
  >
    {initials(name)}
  </span>
{/snippet}

{#snippet reviewStateBadge(state: PrReviewer['state'])}
  {#if state === 'APPROVED'}
    <span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-(--solus-art-positive) bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)]">
      <CheckCircleIcon size={10} weight="fill" />
      Approved
    </span>
  {:else if state === 'CHANGES_REQUESTED'}
    <span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-(--solus-art-negative) bg-[color:color-mix(in_srgb,var(--solus-art-negative)_12%,transparent)]">
      <ArrowsClockwiseIcon size={10} weight="bold" />
      Changes
    </span>
  {:else if state === 'COMMENTED'}
    <span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-(--solus-text-tertiary) bg-(--solus-art-raised)">
      <ChatCircleIcon size={10} weight="fill" />
      Commented
    </span>
  {:else}
    <span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-(--solus-text-tertiary) bg-(--solus-art-raised)">
      Pending
    </span>
  {/if}
{/snippet}

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
            class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-primary) transition-colors hover:bg-(--solus-accent-light)"
            onclick={refresh}
          >
            <ArrowsClockwiseIcon size={12} weight="bold" />
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
            class="text-[1.35rem] leading-tight font-semibold tracking-tight text-(--solus-text-primary)"
          >
            {pr.title}
          </h1>
          <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
            aria-label="Refresh activity"
            use:tooltip={"Refresh"}
            onclick={refresh}
          >
            <ArrowsClockwiseIcon size={15} />
          </button>
        </div>

        <!-- Author / branch meta -->
        <div
          class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-(--solus-text-tertiary)"
        >
          {@render avatar(
            detail?.author ?? pr.owner,
            "size-5 text-[0.5625rem]",
          )}
          <span class="font-medium text-(--solus-text-secondary)"
            >{detail?.author ?? pr.owner}</span
          >
          <span aria-hidden="true">·</span>
          <span class="font-mono">{pr.repo}#{pr.number}</span>
          <span aria-hidden="true">·</span>
          <GitBranchIcon size={13} class="shrink-0" />
          <span class="font-mono">{pr.baseRef}</span>
          <span aria-hidden="true">←</span>
          <span class="font-mono truncate">{pr.branch}</span>
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
              class="prose-cloud mt-3 text-[0.9375rem] leading-relaxed text-(--solus-text-primary) [--solus-font-weight-body:400]"
            >
              <SvelteMarkdown
                source={detail.body}
                renderers={markdownRenderers}
                sanitizeUrl={markdownSanitizeUrl}
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

        <ol class="flex flex-col">
          <!-- Opened event -->
          <li class="relative flex gap-3">
            <div class="flex flex-col items-center">
              <span
                class="grid size-5 shrink-0 place-items-center text-(--solus-art-positive)"
              >
                <GitPullRequestIcon size={15} weight="bold" />
              </span>
              {#if hasTimelineAfterOpened}
                <span class="w-px flex-1 bg-(--solus-art-border)"></span>
              {/if}
            </div>
            <p
              class="-mt-0.5 pb-5 text-[0.8125rem] text-(--solus-text-secondary)"
            >
              <span class="font-medium text-(--solus-text-primary)"
                >{detail?.author ?? pr.owner}</span
              >
              opened this pull request{#if openedTime}<span
                  class="text-(--solus-text-tertiary)"
                >
                  · {openedTime}</span
                >{/if}
            </p>
          </li>

          <!-- Commits pushed to the PR, grouped like GitHub's "added N commits" -->
          {#if commits.length > 0}
            <li class="relative flex gap-3">
              <div class="flex flex-col items-center">
                <span
                  class="grid size-5 shrink-0 place-items-center text-(--solus-text-tertiary)"
                >
                  <GitCommitIcon size={15} weight="bold" />
                </span>
                {#if threads.length > 0 || posted.length > 0}
                  <span class="w-px flex-1 bg-(--solus-art-border)"></span>
                {/if}
              </div>
              <div class="-mt-0.5 min-w-0 flex-1 pb-5">
                <p class="text-[0.8125rem] text-(--solus-text-secondary)">
                  <span class="font-medium text-(--solus-text-primary)"
                    >{detail?.author ?? pr.owner}</span
                  >
                  added {commits.length}
                  {commits.length === 1
                    ? "commit"
                    : "commits"}{#if commitsTime}<span
                      class="text-(--solus-text-tertiary)"
                    >
                      · {commitsTime}</span
                    >{/if}
                </p>
                <ul
                  class="mt-2.5 flex flex-col gap-px overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)"
                >
                  {#each commits as commit (commit.sha)}
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
                        class="inline-flex shrink-0 items-center gap-1 text-(--solus-art-positive)"
                      >
                        <CheckCircleIcon size={13} weight="fill" />
                      </span>
                      <code
                        class="shrink-0 font-mono text-[0.6875rem] text-(--solus-text-tertiary)"
                        >{commit.sha.slice(0, 7)}</code
                      >
                    </li>
                  {/each}
                </ul>
              </div>
            </li>
          {/if}

          <!-- Existing review threads, repliable / resolvable -->
          {#each threads as thread, ti (thread.id)}
            {@const diffHunk = thread.comments[0]?.diffHunk}
            <li class="relative flex gap-3">
              <div class="flex flex-col items-center">
                <span
                  class="grid size-5 shrink-0 place-items-center text-(--solus-text-tertiary)"
                >
                  <ChatCircleIcon size={14} weight="fill" />
                </span>
                {#if ti < threads.length - 1 || posted.length > 0}
                  <span class="w-px flex-1 bg-(--solus-art-border)"></span>
                {/if}
              </div>

              <div class="-mt-0.5 min-w-0 flex-1 pb-5">
                <div
                  class="overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)"
                >
                  <div
                    class="flex items-center gap-2 border-b border-(--solus-art-border) px-3 py-2"
                  >
                    <button
                      type="button"
                      class="min-w-0 flex-1 truncate text-left font-mono text-[0.75rem] text-(--solus-text-secondary) hover:text-(--solus-accent)"
                      onclick={() => jumpToFile(thread.filePath, thread.line)}
                    >
                      {thread.filePath}{thread.line !== null
                        ? `:${thread.line}`
                        : ""}
                    </button>
                    {#if thread.isOutdated}
                      <span
                        class="shrink-0 rounded bg-(--solus-accent-light) px-1.5 py-0.5 text-[0.625rem] font-semibold text-(--solus-text-tertiary)"
                        >Outdated</span
                      >
                    {/if}
                    {#if thread.isResolved}
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded bg-[color:color-mix(in_srgb,var(--solus-art-positive)_16%,transparent)] px-1.5 py-0.5 text-[0.625rem] font-semibold text-(--solus-art-positive)"
                      >
                        <CheckCircleIcon size={11} weight="fill" /> Resolved
                      </span>
                    {/if}
                  </div>

                  {#if threadCollapsed(thread)}
                    <button
                      type="button"
                      class="flex w-full items-center gap-1.5 px-3 py-2.5 text-left transition-colors hover:bg-(--solus-accent-light)"
                      onclick={() => expandedThreads.add(thread.id)}
                      aria-expanded="false"
                    >
                      <CheckCircleIcon
                        size={13}
                        weight="fill"
                        class="shrink-0 text-(--solus-art-positive)"
                      />
                      <span class="text-[0.8125rem] font-medium text-(--solus-text-secondary)">
                        Marked as resolved
                      </span>
                      <span class="ml-auto inline-flex items-center gap-1 text-xs text-(--solus-text-tertiary)">
                        Show thread
                        <CaretDownIcon size={11} weight="bold" />
                      </span>
                    </button>
                  {:else}
                  <!-- The diff GitHub anchored the thread to (first comment's hunk),
                       rendered through the same @pierre/diffs engine as the Diff tab. -->
                  {#if diffHunk}
                    <div class="border-b border-(--solus-art-border)">
                      <GuideFileDiff
                        patch={hunkToPatch(thread.filePath, diffHunk)}
                        filePath={thread.filePath}
                      />
                    </div>
                  {/if}

                  <div class="flex flex-col px-3 py-2.5">
                    {#each thread.comments as comment, ci (comment.id)}
                      <div class="flex gap-2.5">
                        <!-- Avatar + connector line linking stacked replies together -->
                        <div class="flex flex-col items-center">
                          {@render avatar(
                            comment.author,
                            "size-6 text-[0.625rem]",
                          )}
                          {#if ci < thread.comments.length - 1}
                            <span
                              class="mt-1 w-px flex-1 bg-(--solus-art-border)"
                            ></span>
                          {/if}
                        </div>
                        <div class="min-w-0 flex-1 pb-3">
                          <div
                            class="mb-0.5 flex items-baseline gap-1.5 text-[0.75rem]"
                          >
                            <span
                              class="font-semibold text-(--solus-text-primary)"
                              >{comment.author}</span
                            >
                            <span class="text-(--solus-text-tertiary)"
                              >{formatTimeAgoFromTimestamp(
                                new Date(comment.createdAt).getTime(),
                              )}</span
                            >
                          </div>
                          <p
                            class="text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-(--solus-text-secondary)"
                          >
                            {comment.body}
                          </p>
                        </div>
                      </div>
                    {/each}

                    {#if replyingTo === thread.id}
                      <div class="flex flex-col gap-1.5">
                        <MarkdownEditor
                          value={replyText}
                          onValueChange={(md) => (replyText = md)}
                          enterInsertsNewline
                          hidePlaceholderOnFocus
                          maxHeight={140}
                          placeholder="Reply…"
                          class={replyFieldClass}
                        />
                        <div class="flex justify-end gap-1.5">
                          <button
                            type="button"
                            class="rounded-md px-2.5 py-1 text-xs font-medium text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)"
                            onclick={() => {
                              replyingTo = null;
                              replyText = "";
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={busy === thread.id || !replyText.trim()}
                            class="rounded-md bg-(--solus-accent) px-2.5 py-1 text-xs font-semibold text-(--solus-on-accent,#fff) disabled:opacity-50"
                            onclick={() => submitReply(thread)}
                          >
                            Reply
                          </button>
                        </div>
                      </div>
                    {:else}
                      <div class="flex items-center gap-1">
                        <button
                          type="button"
                          class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
                          onclick={() => {
                            replyingTo = thread.id;
                            replyText = "";
                          }}
                        >
                          <ArrowBendUpLeftIcon size={13} /> Reply
                        </button>
                        <button
                          type="button"
                          disabled={busy === thread.id}
                          class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) disabled:opacity-50"
                          onclick={() => toggleResolved(thread)}
                        >
                          {thread.isResolved ? "Unresolve" : "Resolve"}
                        </button>
                        {#if thread.isResolved}
                          <button
                            type="button"
                            class="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
                            onclick={() => expandedThreads.delete(thread.id)}
                          >
                            Hide
                          </button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                  {/if}
                </div>
              </div>
            </li>
          {/each}

          <!-- Comments posted this session -->
          {#each posted as p, pi (p.id)}
            <li class="relative flex gap-3">
              <div class="flex flex-col items-center">
                {@render avatar(p.author, "size-5 text-[0.5625rem]")}
                {#if pi < posted.length - 1}
                  <span class="w-px flex-1 bg-(--solus-art-border)"></span>
                {/if}
              </div>
              <div class="-mt-0.5 min-w-0 flex-1 pb-5">
                <div class="mb-1 text-[0.8125rem]">
                  <span class="font-medium text-(--solus-text-primary)"
                    >{p.author}</span
                  >
                  <span class="text-(--solus-text-tertiary)">
                    · {formatTimeAgoFromTimestamp(p.ts)}</span
                  >
                </div>
                <p
                  class="text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-(--solus-text-secondary)"
                >
                  {p.body}
                </p>
              </div>
            </li>
          {/each}
        </ol>

        <!-- Composer -->
        <div
          class="mt-3 flex items-center gap-2.5 rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface) px-3 py-2.5 focus-within:border-(--solus-accent)"
        >
          {@render avatar(detail?.author ?? pr.owner, "size-6 text-[0.625rem]")}
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
            class="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--solus-accent) text-(--solus-on-accent,#fff) transition-opacity disabled:opacity-40"
            aria-label="Post comment"
            use:tooltip={"Comment · ⌘↵"}
            onclick={postComment}
          >
            <ArrowUpIcon size={15} weight="bold" />
          </button>
        </div>
      </main>

      <!-- ── Right rail: status + meta, changed files ── -->
      <aside class="hidden w-[16.5rem] shrink-0 lg:block">
        <div class="sticky top-9 flex flex-col gap-3.5">
          <!-- Status & meta card -->
          <section
            class="overflow-hidden rounded-2xl border border-(--solus-art-border) {sidebarPanelBg} shadow-[var(--solus-card-shadow-collapsed)]"
          >
            <!-- Status row -->
            <div
              class="flex items-center justify-between gap-3 px-3.5 pt-3 pb-3"
            >
              <span class="text-xs font-normal text-(--solus-text-secondary)"
                >Status</span
              >
              {#if statusBadge}
                {@const Badge = statusBadge.Icon}
                <span
                  class="inline-flex items-center gap-1.5 rounded-full py-1 pr-2 pl-1 text-[0.75rem] font-medium leading-none"
                  style={`color:${statusBadge.tone};background:color-mix(in srgb,${statusBadge.tone} 12%,transparent)`}
                >
                  <Badge size={12} weight="fill" />
                  {statusBadge.label}
                </span>
              {/if}
            </div>

            <!-- Reviewers / Resolves rows -->
            <dl
              class="divide-y divide-(--solus-art-border) border-t border-(--solus-art-border)"
            >
              <div class="px-3.5 py-2.5">
                <dt
                  class="mb-1.5 text-xs font-normal text-(--solus-text-secondary)"
                >
                  Reviewers
                </dt>
                <dd>
                  {#if reviewersLoading}
                    <div class="flex animate-pulse items-center gap-2 motion-reduce:animate-none">
                      <span class="size-5 shrink-0 rounded-full bg-(--solus-art-border)"></span>
                      <span class="h-3 w-24 rounded bg-(--solus-art-border)"></span>
                    </div>
                  {:else if reviewers.length === 0}
                    <span class="text-[0.75rem] font-normal text-(--solus-text-tertiary)">None</span>
                  {:else}
                    <ul class="flex flex-col gap-1.5">
                      {#each reviewers as reviewer (reviewer.login)}
                        <li class="flex items-center gap-2">
                          {@render avatar(reviewer.login, "size-5 text-[0.5rem]")}
                          <span class="min-w-0 flex-1 truncate text-[0.75rem] font-normal text-(--solus-text-secondary)">{reviewer.login}</span>
                          {@render reviewStateBadge(reviewer.state)}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </dd>
              </div>
              <div class="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <dt
                  class="shrink-0 text-xs font-normal text-(--solus-text-secondary)"
                >
                  Resolves
                </dt>
                <dd class="text-[0.75rem] font-normal text-(--solus-text-tertiary)">
                  None
                </dd>
              </div>
              {#if openedTime}
                <div
                  class="flex items-center justify-between gap-3 px-3.5 py-2.5"
                >
                  <dt
                    class="shrink-0 text-xs font-normal text-(--solus-text-secondary)"
                  >
                    Updated
                  </dt>
                  <dd class="text-[0.75rem] font-normal text-(--solus-text-tertiary)">
                    {openedTime}
                  </dd>
                </div>
              {/if}
            </dl>
          </section>

          <!-- Changed files card -->
          <section
            class="overflow-hidden rounded-2xl border border-(--solus-art-border) {sidebarPanelBg} shadow-[var(--solus-card-shadow-collapsed)]"
          >
            <div
              class="flex items-center justify-between gap-2 px-3.5 pt-3 pb-2.5"
            >
              <h3
                class="text-[0.6875rem] font-semibold tracking-wider text-(--solus-text-tertiary) uppercase"
              >
                Changed files
              </h3>
              {#if filesLoading}
                <span
                  class="h-[1.125rem] w-5 animate-pulse rounded-full bg-(--solus-art-border) motion-reduce:animate-none"
                ></span>
              {:else}
                <span
                  class="grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-(--solus-art-raised) px-1 text-[0.625rem] font-semibold tabular-nums text-(--solus-text-secondary)"
                >
                  {changedFiles.length}
                </span>
              {/if}
            </div>

            {#if totalAdds + totalDels > 0}
              <div class="flex items-center gap-2 px-3.5 pb-3">
                <div
                  class="flex h-1.5 flex-1 overflow-hidden rounded-full bg-(--solus-art-raised)"
                >
                  {#if totalAdds}
                    <div
                      class="h-full bg-(--solus-art-positive)"
                      style={`width:${addPct}%`}
                    ></div>
                  {/if}
                  {#if totalDels}
                    <div
                      class="h-full bg-(--solus-art-negative)"
                      style={`width:${100 - addPct}%`}
                    ></div>
                  {/if}
                </div>
                <div
                  class="flex shrink-0 items-center gap-1.5 text-[0.6875rem] font-semibold tabular-nums"
                >
                  {#if totalAdds}<span class="text-(--solus-art-positive)"
                      >+{totalAdds}</span
                    >{/if}
                  {#if totalDels}<span class="text-(--solus-art-negative)"
                      >−{totalDels}</span
                    >{/if}
                </div>
              </div>
            {/if}

            <ul
              class="flex flex-col gap-px border-t border-(--solus-art-border) p-1.5"
            >
              {#if filesLoading}
                {#each [0, 1, 2, 3] as i (i)}
                  <li
                    class="flex animate-pulse items-center gap-2 px-2 py-1.5 motion-reduce:animate-none"
                  >
                    <span class="size-3.5 shrink-0 rounded bg-(--solus-art-border)"></span>
                    <span
                      class="h-3 rounded bg-(--solus-art-border)"
                      style={`width:${70 - i * 12}%`}
                    ></span>
                  </li>
                {/each}
              {/if}
              {#each visibleFiles as file (file.path)}
                {@const icon = fileTypeIcon(file.path)}
                <li>
                  <button
                    type="button"
                    class="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--solus-accent-light)"
                    onclick={() => jumpToFile(file.path)}
                  >
                    {#if icon}
                      <Icon {icon} width="14" height="14" class="shrink-0" />
                    {:else}
                      <FileIcon
                        size={14}
                        weight="regular"
                        class="shrink-0 text-(--solus-text-tertiary)"
                      />
                    {/if}
                    <span class="min-w-0 flex-1 truncate text-[0.75rem]">
                      <span
                        class="!font-normal text-(--solus-text-secondary) group-hover:text-(--solus-accent)"
                        >{fileName(file.path)}</span
                      >
                      {#if dirName(file.path)}
                        <span
                          class="ml-1 font-mono text-[0.625rem] text-(--solus-text-tertiary)"
                          >{dirName(file.path).replace(/\/$/, "")}</span
                        >
                      {/if}
                    </span>
                    {#if file.additions}
                      <span
                        class="shrink-0 tabular-nums text-[0.625rem] font-semibold text-(--solus-art-positive)"
                        >+{file.additions}</span
                      >
                    {/if}
                    {#if file.deletions}
                      <span
                        class="shrink-0 tabular-nums text-[0.625rem] font-semibold text-(--solus-art-negative)"
                        >−{file.deletions}</span
                      >
                    {/if}
                  </button>
                </li>
              {/each}
              {#if moreFiles > 0}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-secondary)"
                    onclick={() => (filesExpanded = !filesExpanded)}
                  >
                    <CaretRightIcon
                      size={11}
                      weight="bold"
                      class={`transition-transform ${filesExpanded ? "rotate-90" : ""}`}
                    />
                    {filesExpanded
                      ? "Show fewer files"
                      : `${moreFiles} more ${moreFiles === 1 ? "file" : "files"}`}
                  </button>
                </li>
              {/if}
            </ul>
          </section>
        </div>
      </aside>
    </div>
</div>
