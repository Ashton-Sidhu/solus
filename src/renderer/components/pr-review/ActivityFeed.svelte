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
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { SvelteSet } from "svelte/reactivity";
  import Icon from "@iconify/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import type { ChangedFileStat } from "../../../shared/types";
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
    type PrActivityTarget,
  } from "./lib/activity-data";
  import GuideFileDiff from "./guide/GuideFileDiff.svelte";
  import MergeControl from "./MergeControl.svelte";

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
    onJump,
    onRefreshThreads,
  }: {
    pr: PrActivityTarget;
    /** Review threads, owned by the parent so the Diff tab and this timeline
     *  share one fetch (and one set of objects — reply/resolve mutate in place). */
    threads: ReviewThread[];
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
  let mergeabilityRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // A resolved thread collapses to a "Marked as resolved" bar (hiding its diff
  // hunk + conversation), matching the inline Diff tab. This tracks the ones the
  // user re-expanded; a resolved thread not in the set renders collapsed.
  const expandedThreads = new SvelteSet<string>();
  const threadCollapsed = (t: ReviewThread) =>
    t.isResolved && !expandedThreads.has(t.id);
  const collapsedDiffs = new SvelteSet<string>();
  const diffExpanded = (thread: ReviewThread) => !collapsedDiffs.has(thread.id);

  const markdownRenderers = { codespan: CodeSpan };
  const FILES_PREVIEW = 6;
  const MERGEABILITY_RETRY_DELAYS_MS = [1_000, 2_500, 5_000];

  // Markdown comment inputs styled like the message composer: forced 400 weight
  // so typed text never reads bold. The reply box is a bordered transparent
  // field; the composer is bare and sits inside its own pill.
  const replyFieldClass =
    "rounded-lg border border-(--solus-art-border) bg-transparent px-2.5 transition-colors focus-within:border-(--solus-accent) [&_.solus-md-editor_.ProseMirror]:![min-height:2.5rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![left:0.875rem]";
  const composerFieldClass =
    "flex-1 min-w-0 [&_.solus-md-editor_.ProseMirror]:![padding:0.25rem_0] [&_.solus-md-editor_.ProseMirror]:![min-height:1.25rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![top:0.25rem] [&_.solus-md-placeholder]:![left:0]";
  // Timeline event markers: one consistent 24px circle so the connector line
  // threads through evenly sized dots, tinted only where state matters
  // (opened / resolved read positive; everything else stays neutral).
  const markerClass =
    "grid size-6 shrink-0 place-items-center rounded-full bg-(--solus-art-raised) text-(--solus-text-tertiary)";
  const markerPositiveClass =
    "grid size-6 shrink-0 place-items-center rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)] text-(--solus-art-positive)";

  // Resolve display fields from `detail` once it loads, falling back to the
  // up-front hints on `pr` so the header paints instantly (the list already has
  // author + avatar from the summary; the review pane has the branch refs).
  const authorName = $derived(detail?.author ?? pr.owner ?? "");
  const authorAvatarUrl = $derived(
    detail?.authorAvatarUrl ?? pr.authorAvatarUrl ?? "",
  );
  const baseRef = $derived(pr.baseRef ?? detail?.baseRef ?? "");
  const headBranch = $derived(pr.branch ?? detail?.headRef ?? "");

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

  const canMerge = $derived(detail?.state === "open" && !detail?.draft);

  const mergeability = $derived.by(() => {
    if (!detail) return null;
    if (detail.state === "merged")
      return {
        label: "Merged",
        description: "This PR has already been merged.",
        Icon: GitMergeIcon,
        tone: "var(--solus-accent)",
      };
    if (detail.state === "closed")
      return {
        label: "Closed",
        description: "Closed PRs cannot be merged.",
        Icon: GitPullRequestIcon,
        tone: "var(--solus-text-tertiary)",
      };
    if (detail.draft)
      return {
        label: "Draft",
        description: "Mark ready for review before merging.",
        Icon: GitBranchIcon,
        tone: "var(--solus-text-tertiary)",
      };
    if (detail.mergeable === true)
      return {
        label: "Good to merge",
        description: "GitHub reports no merge conflicts.",
        Icon: CheckCircleIcon,
        tone: "var(--solus-art-positive)",
      };
    if (detail.mergeable === false)
      return {
        label: "Merge conflicts",
        description: "Resolve conflicts before merging.",
        Icon: WarningCircleIcon,
        tone: "var(--solus-art-negative)",
      };
    return {
      label: "Checking",
      description: "GitHub is still computing mergeability.",
      Icon: ArrowsClockwiseIcon,
      tone: "var(--solus-text-tertiary)",
    };
  });

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
    const baseSha = pr.baseSha;
    const isCurrentPr = () => pr?.number === n;
    clearMergeabilityRetry();
    detail = null;
    commits = [];
    reviewers = [];
    changedFiles = [];
    detailLoading = commitsLoading = reviewersLoading = filesLoading = true;

    session.prsStore
      .loadDetail(session.ctx, n, { force })
      .then((d) => {
        if (!isCurrentPr()) return;
        detail = d;
        // The list preview has no worktree base up front — take it from the
        // detail it just fetched. The review pane passes `baseSha`, so it has
        // already kicked off the change set below in parallel.
        if (!baseSha) loadChangedFiles(d.baseSha, n);
        scheduleMergeabilityRetry(n);
      })
      .catch(() => {
        // Without `detail` there's no fallback base, so stop the files spinner.
        if (isCurrentPr() && !baseSha) filesLoading = false;
      })
      .finally(() => {
        if (isCurrentPr()) detailLoading = false;
      });
    session.prsStore
      .loadCommits(session.ctx, n, { force })
      .then((c) => {
        if (isCurrentPr()) commits = c;
      })
      .catch(() => {})
      .finally(() => {
        if (isCurrentPr()) commitsLoading = false;
      });
    session.prsStore
      .loadReviewers(session.ctx, n, { force })
      .then((r) => {
        if (isCurrentPr()) reviewers = r;
      })
      .catch(() => {})
      .finally(() => {
        if (isCurrentPr()) reviewersLoading = false;
      });
    if (baseSha) loadChangedFiles(baseSha, n);
  }

  function clearMergeabilityRetry() {
    if (!mergeabilityRetryTimer) return;
    clearTimeout(mergeabilityRetryTimer);
    mergeabilityRetryTimer = null;
  }

  function scheduleMergeabilityRetry(n: number, attempt = 0) {
    clearMergeabilityRetry();
    if (
      pr?.number !== n ||
      detail?.state !== "open" ||
      detail.draft ||
      detail.mergeable !== null ||
      attempt >= MERGEABILITY_RETRY_DELAYS_MS.length
    ) {
      return;
    }

    mergeabilityRetryTimer = setTimeout(() => {
      mergeabilityRetryTimer = null;
      session.prsStore
        .loadDetail(session.ctx, n, { force: true })
        .then((d) => {
          if (pr?.number !== n) return;
          detail = d;
          scheduleMergeabilityRetry(n, attempt + 1);
        })
        .catch(() => {});
    }, MERGEABILITY_RETRY_DELAYS_MS[attempt]);
  }

  function loadChangedFiles(baseSha: string, n: number) {
    window.solus
      .prChangedFiles(session.ctx, baseSha)
      .then((f) => {
        if (pr?.number === n) changedFiles = f;
      })
      .catch(() => {})
      .finally(() => {
        if (pr?.number === n) filesLoading = false;
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

  $effect(() => {
    return () => clearMergeabilityRetry();
  });

  // When the merge queue finishes merging this PR, force-reload so the status
  // flips to Merged without a manual refresh.
  let lastMerge: { number: number; status: string | null } = {
    number: -1,
    status: null,
  };
  $effect(() => {
    const status = session.mergeQueueStore.entryFor(pr.number)?.status ?? null;
    const prev = lastMerge;
    lastMerge = { number: pr.number, status };
    if (
      prev.number === pr.number &&
      prev.status !== status &&
      status === "merged"
    ) {
      load(true);
    }
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
        commitId: detail?.headSha ?? pr.headSha ?? "",
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

  function toggleDiff(threadId: string) {
    if (collapsedDiffs.has(threadId)) collapsedDiffs.delete(threadId);
    else collapsedDiffs.add(threadId);
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

{#snippet avatarImg(url: string, name: string, size: string)}
  {#if url}
    <img
      src={url}
      alt={name}
      class="shrink-0 rounded-full object-cover outline-1 -outline-offset-1 outline-black/5 dark:outline-white/10 {size}"
    />
  {:else}
    {@render avatar(name, size)}
  {/if}
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
    <div class="mx-auto flex w-full max-w-[92rem] gap-10 px-8 py-9">
      <!-- ── Main column: title, meta, description, activity, composer ── -->
      <main class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-start justify-between gap-3">
          <h1
            class="text-xl font-semibold tracking-tight text-balance text-(--solus-text-primary)"
          >
            {pr.title}
          </h1>
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

        <!-- Author / branch meta -->
        <div
          class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-(--solus-text-tertiary)"
        >
          {@render avatarImg(
            authorAvatarUrl,
            authorName,
            "size-5 text-[0.5625rem]",
          )}
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
              <span aria-hidden="true">←</span>
              <span
                class="truncate rounded-md bg-(--solus-art-raised) px-1.5 py-0.5 font-mono text-[0.6875rem] text-(--solus-text-secondary)"
                >{headBranch}</span
              >
            </span>
          {/if}
        </div>

        <!-- Merge action for narrow layouts, where the right rail is hidden -->
        {#if canMerge}
          <div class="mt-5 flex max-w-[22rem] flex-col gap-2 lg:hidden">
            {#if mergeability}
              {@const MergeabilityIcon = mergeability.Icon}
              <div
                class="flex items-center gap-2 rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface) px-3 py-2"
              >
                <span
                  class="grid size-6 shrink-0 place-items-center rounded-full"
                  style={`color:${mergeability.tone};background:color-mix(in srgb,${mergeability.tone} 12%,transparent)`}
                >
                  <MergeabilityIcon size={14} weight="fill" />
                </span>
                <div class="min-w-0">
                  <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">
                    {mergeability.label}
                  </div>
                  <div class="truncate text-[0.75rem] text-(--solus-text-tertiary)">
                    {mergeability.description}
                  </div>
                </div>
              </div>
            {/if}
            <MergeControl {pr} />
          </div>
        {/if}

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

        <ol class="flex flex-col" role="list">
          <!-- Opened event -->
          <li class="relative flex gap-3">
            <div class="flex flex-col items-center">
              <span class={markerPositiveClass}>
                <GitPullRequestIcon size={13} weight="bold" />
              </span>
              {#if hasTimelineAfterOpened}
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

          <!-- Commits pushed to the PR, grouped like GitHub's "added N commits" -->
          {#if commits.length > 0}
            <li class="relative flex gap-3">
              <div class="flex flex-col items-center">
                <span class={markerClass}>
                  <GitCommitIcon size={13} weight="bold" />
                </span>
                {#if threads.length > 0 || posted.length > 0}
                  <span class="my-1 w-px flex-1 bg-(--solus-art-border)"></span>
                {/if}
              </div>
              <div class="mt-0.5 min-w-0 flex-1 pb-6">
                <p class="text-[0.8125rem] text-(--solus-text-secondary)">
                  <span class="font-medium text-(--solus-text-primary)"
                    >{authorName}</span
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
                  class="mt-2.5 flex flex-col divide-y divide-(--solus-art-border) overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)"
                  role="list"
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
                      <code
                        class="shrink-0 rounded-md bg-(--solus-art-raised) px-1.5 py-0.5 font-mono text-[0.6875rem] text-(--solus-text-tertiary)"
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
            {@const showDiff = diffExpanded(thread)}
            <li class="relative flex gap-3">
              <div class="flex flex-col items-center">
                <span class={thread.isResolved ? markerPositiveClass : markerClass}>
                  {#if thread.isResolved}
                    <CheckCircleIcon size={13} weight="fill" />
                  {:else}
                    <ChatCircleIcon size={13} weight="fill" />
                  {/if}
                </span>
                {#if ti < threads.length - 1 || posted.length > 0}
                  <span class="my-1 w-px flex-1 bg-(--solus-art-border)"></span>
                {/if}
              </div>

              <div class="-mt-1 min-w-0 flex-1 pb-6">
                <div
                  class="overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)"
                >
                  <div
                    class="flex items-center gap-2 border-b border-(--solus-art-border) px-3 py-2"
                  >
                    {#if diffHunk && !threadCollapsed(thread)}
                      <button
                        type="button"
                        class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[color,background-color,scale] duration-150 ease-out hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) active:scale-[0.92]"
                        aria-expanded={showDiff}
                        aria-label={showDiff
                          ? `Collapse diff for ${fileName(thread.filePath)}`
                          : `Expand diff for ${fileName(thread.filePath)}`}
                        use:tooltip={showDiff ? "Collapse diff" : "Expand diff"}
                        onclick={() => toggleDiff(thread.id)}
                      >
                        {#if showDiff}
                          <CaretDownIcon size={13} weight="bold" />
                        {:else}
                          <CaretRightIcon size={13} weight="bold" />
                        {/if}
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[0.75rem] text-(--solus-text-secondary) hover:text-(--solus-accent)"
                      use:tooltip={"Open in Diff tab"}
                      onclick={() => jumpToFile(thread.filePath, thread.line)}
                    >
                      <span class="text-(--solus-text-tertiary)"
                        >{dirName(thread.filePath)}</span
                      >{fileName(thread.filePath)}{thread.line !== null
                        ? `:${thread.line}`
                        : ""}
                    </button>
                    {#if thread.isOutdated}
                      <span
                        class="shrink-0 rounded-full bg-(--solus-art-raised) px-1.5 py-0.5 text-[0.625rem] font-medium text-(--solus-text-tertiary)"
                        >Outdated</span
                      >
                    {/if}
                    {#if thread.isResolved}
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--solus-art-positive)_12%,transparent)] py-0.5 pr-1.5 pl-1 text-[0.625rem] font-medium text-(--solus-art-positive)"
                      >
                        <CheckCircleIcon size={11} weight="fill" /> Resolved
                      </span>
                    {/if}
                  </div>

                  {#if threadCollapsed(thread)}
                    <button
                      type="button"
                      class="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2.5 text-left transition-colors hover:bg-(--solus-accent-light)"
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
                  {#if diffHunk && showDiff}
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
                            class="cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
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
                            class="cursor-pointer rounded-md bg-(--solus-accent) px-2.5 py-1 text-xs font-semibold text-(--solus-on-accent,#fff) hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                            onclick={() => submitReply(thread)}
                          >
                            {busy === thread.id ? "Replying…" : "Reply"}
                          </button>
                        </div>
                      </div>
                    {:else}
                      <div class="flex items-center gap-1">
                        <button
                          type="button"
                          class="inline-flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 pl-1.5 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
                          onclick={() => {
                            replyingTo = thread.id;
                            replyText = "";
                          }}
                        >
                          <ArrowBendUpLeftIcon size={13} class="shrink-0" /> Reply
                        </button>
                        <button
                          type="button"
                          disabled={busy === thread.id}
                          class="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) disabled:cursor-not-allowed disabled:opacity-50"
                          onclick={() => toggleResolved(thread)}
                        >
                          {thread.isResolved ? "Unresolve" : "Resolve"}
                        </button>
                        {#if thread.isResolved}
                          <button
                            type="button"
                            class="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
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
                {@render avatarImg(authorAvatarUrl, p.author, "size-6 text-[0.625rem]")}
                {#if pi < posted.length - 1}
                  <span class="my-1 w-px flex-1 bg-(--solus-art-border)"></span>
                {/if}
              </div>
              <div class="mt-0.5 min-w-0 flex-1 pb-6">
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
          {@render avatarImg(authorAvatarUrl, authorName, "size-6 text-[0.625rem]")}
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
      <aside class="hidden w-[16.5rem] shrink-0 lg:block">
        <div class="sticky top-9 flex flex-col gap-3.5">
          <!-- Status & meta card -->
          <section
            class="overflow-hidden rounded-2xl border border-(--solus-art-border) bg-(--solus-art-surface)"
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

            <!-- Mergeability row -->
            <div class="border-t border-(--solus-art-border) px-3.5 py-3">
              {#if detailLoading}
                <div class="flex animate-pulse items-center gap-2 motion-reduce:animate-none">
                  <span class="size-7 shrink-0 rounded-full bg-(--solus-art-border)"></span>
                  <span class="h-3 w-28 rounded bg-(--solus-art-border)"></span>
                </div>
              {:else if mergeability}
                {@const MergeabilityIcon = mergeability.Icon}
                <div class="flex items-start gap-2.5">
                  <span
                    class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full"
                    style={`color:${mergeability.tone};background:color-mix(in srgb,${mergeability.tone} 12%,transparent)`}
                  >
                    <MergeabilityIcon size={15} weight="fill" />
                  </span>
                  <div class="min-w-0">
                    <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">
                      {mergeability.label}
                    </div>
                    <div class="mt-0.5 text-[0.75rem] leading-snug text-(--solus-text-tertiary)">
                      {mergeability.description}
                    </div>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Merge action -->
            {#if canMerge}
              <div class="border-t border-(--solus-art-border) px-3.5 py-3">
                <MergeControl {pr} />
              </div>
            {/if}

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
                    <ul class="flex flex-col gap-1.5" role="list">
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
            class="overflow-hidden rounded-2xl border border-(--solus-art-border) bg-(--solus-art-surface)"
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
              role="list"
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
                    class="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-(--solus-accent-light)"
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
                    class="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-secondary)"
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
