<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    ArrowSquareOutIcon,
    CircleNotchIcon,
    FileIcon,
    GitBranchIcon,
    GitPullRequestIcon,
  } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type {
    PullRequestSummary,
    PullRequestDetail,
    PrCommit,
    PrReviewer,
  } from "../../../shared/providers";
  import type { ChangedFileStat } from "../../../shared/types";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { tooltip } from "../../lib/tooltip";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import { Skeleton } from "../ui/skeleton";
  import PrAvatar from "./PrAvatar.svelte";
  import PrStateIcon from "./PrStateIcon.svelte";
  import PrReviewStateBadge from "./PrReviewStateBadge.svelte";
  import { prStatusBadge, relativeTime } from "./lib/pr-utils";

  // The PRs page's right pane: breadcrumb header with the Review action, then
  // description + opened/commits timeline with a status/reviewers/files rail.
  // Pure presentation — the page owns loading and selection.
  let {
    pr,
    detail,
    commits,
    reviewers,
    changedFiles,
    detailLoading,
    commitsLoading,
    reviewersLoading,
    filesLoading,
    detailLoadFailed,
    onRetry,
    onBack,
    onOpenReview,
  }: {
    pr: PullRequestSummary;
    detail: PullRequestDetail | null;
    commits: PrCommit[];
    reviewers: PrReviewer[];
    changedFiles: ChangedFileStat[];
    detailLoading: boolean;
    commitsLoading: boolean;
    reviewersLoading: boolean;
    filesLoading: boolean;
    detailLoadFailed: boolean;
    onRetry: () => void;
    onBack: () => void;
    onOpenReview: () => void;
  } = $props();

  const markdownRenderers = { codespan: CodeSpan };
  const FILES_PREVIEW = 6;

  let filesExpanded = $state(false);
  $effect(() => {
    void pr.number;
    filesExpanded = false;
  });

  const statusBadge = $derived(prStatusBadge(detail));
  const visibleFiles = $derived(
    filesExpanded ? changedFiles : changedFiles.slice(0, FILES_PREVIEW),
  );
  const moreFiles = $derived(Math.max(0, changedFiles.length - FILES_PREVIEW));
  const totalAdds = $derived(changedFiles.reduce((sum, f) => sum + f.additions, 0));
  const totalDels = $derived(changedFiles.reduce((sum, f) => sum + f.deletions, 0));
</script>

<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
  <!-- Detail header breadcrumb -->
  <div class="flex shrink-0 items-center justify-between gap-3 border-b border-(--solus-popover-border) px-5 py-2">
    <div class="flex min-w-0 items-center gap-2 text-[0.8125rem]">
      <button
        type="button"
        class="hidden text-(--solus-text-tertiary) hover:text-(--solus-text-primary) @max-[44rem]:inline-flex"
        onclick={onBack}
        aria-label="Back to list"
      >
        ←
      </button>
      <PrStateIcon {pr} />
      <span class="truncate font-medium text-(--solus-text-primary)">
        {pr.title}
      </span>
      <span class="shrink-0 text-(--solus-text-tertiary) tabular-nums">
        #{pr.number}
      </span>
      {#if pr.additions > 0 || pr.deletions > 0}
        <span class="shrink-0 text-[0.6875rem] tabular-nums">
          <span class="text-(--solus-art-positive)">+{pr.additions}</span>
          <span class="text-(--solus-art-negative)">-{pr.deletions}</span>
        </span>
      {/if}
    </div>
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-1.5 rounded-[0.4375rem] border-0 bg-(--solus-accent-light) px-2.5 py-[0.3125rem] text-[0.6875rem] font-semibold text-(--solus-accent) transition-[background-color] duration-100 hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      onclick={onOpenReview}
    >
      <ArrowSquareOutIcon size={13} weight="bold" />
      <span>Review</span>
    </button>
  </div>

  <!-- Detail body: scrollable -->
  <div class="h-full min-h-0 overflow-y-auto [scrollbar-width:thin]">
    <div class="mx-auto flex w-full max-w-[64rem] gap-8 px-6 py-7">
      <!-- Main column -->
      <main class="flex min-w-0 flex-1 flex-col">
        <!-- Title -->
        <h1 class="text-[1.25rem] leading-tight font-semibold tracking-tight text-(--solus-text-primary)">
          {pr.title}
        </h1>

        <!-- Author / branch meta -->
        <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-(--solus-text-tertiary)">
          <PrAvatar name={pr.author} url={pr.authorAvatarUrl} size="size-5 text-[0.5625rem]" />
          <span class="font-medium text-(--solus-text-secondary)">{pr.author}</span>
          <span aria-hidden="true">·</span>
          <span class="tabular-nums">#{pr.number}</span>
          {#if detail}
            <span aria-hidden="true">·</span>
            <GitBranchIcon size={13} class="shrink-0" />
            <span class="font-mono text-[0.75rem]">{detail.baseRef}</span>
            <span aria-hidden="true">←</span>
            <span class="font-mono text-[0.75rem] truncate">{detail.headRef}</span>
          {/if}
        </div>

        {#if detailLoadFailed}
          <div
            class="mt-5 flex items-center gap-2.5 rounded-lg border border-[color:color-mix(in_srgb,var(--solus-art-negative)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--solus-art-negative)_8%,transparent)] px-3 py-2 text-[0.8125rem] text-(--solus-text-secondary)"
            role="alert"
          >
            <span class="min-w-0 flex-1">Couldn't load this pull request's details.</span>
            <button
              type="button"
              class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-primary) transition-colors hover:bg-(--solus-accent-light)"
              onclick={onRetry}
            >
              <ArrowsClockwiseIcon size={12} weight="bold" />
              Retry
            </button>
          </div>
        {/if}

        <!-- Description -->
        {#if detailLoading}
          <div class="mt-8 flex flex-col gap-2.5">
            <Skeleton class="h-3 w-full rounded bg-(--solus-art-border)" />
            <Skeleton class="h-3 w-11/12 rounded bg-(--solus-art-border)" />
            <Skeleton class="h-3 w-3/4 rounded bg-(--solus-art-border)" />
          </div>
        {:else if detail?.body?.trim()}
          <div class="mt-6">
            <h2 class="text-[0.75rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
              Description
            </h2>
            <div class="prose-cloud mt-3 text-[0.875rem] leading-relaxed text-(--solus-text-primary) [--solus-font-weight-body:400]">
              <SvelteMarkdown
                source={detail.body}
                renderers={markdownRenderers}
                sanitizeUrl={remoteMarkdownSanitizeUrl}
              />
            </div>
          </div>
        {/if}

        <!-- Activity: opened event + commits -->
        <h2 class="mt-8 mb-4 text-[0.75rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
          Activity
        </h2>

        <ol class="flex flex-col">
          <!-- Opened event -->
          <li class="relative flex gap-3">
            <div class="flex flex-col items-center">
              <span class="grid size-5 shrink-0 place-items-center text-(--solus-art-positive)">
                <GitPullRequestIcon size={15} weight="bold" />
              </span>
              {#if commits.length > 0}
                <span class="w-px flex-1 bg-(--solus-art-border)"></span>
              {/if}
            </div>
            <p class="-mt-0.5 pb-5 text-[0.8125rem] text-(--solus-text-secondary)">
              <span class="font-medium text-(--solus-text-primary)">
                {detail?.author ?? pr.author}
              </span>
              opened this pull request
              <span class="text-(--solus-text-tertiary)">
                · {relativeTime(pr.createdAt)}
              </span>
            </p>
          </li>

          <!-- Commits -->
          {#if commitsLoading}
            <li class="flex gap-3 pb-4">
              <div class="flex flex-col items-center">
                <CircleNotchIcon
                  size={15}
                  class="animate-spin text-(--solus-text-tertiary) [animation-duration:0.9s]"
                />
              </div>
              <span class="-mt-0.5 text-[0.8125rem] text-(--solus-text-tertiary)">Loading commits…</span>
            </li>
          {:else if commits.length > 0}
            <li class="relative flex gap-3">
              <div class="flex flex-col items-center">
                <span class="grid size-5 shrink-0 place-items-center text-(--solus-text-tertiary)">
                  <GitBranchIcon size={15} weight="bold" />
                </span>
              </div>
              <div class="-mt-0.5 min-w-0 flex-1 pb-5">
                <p class="text-[0.8125rem] text-(--solus-text-secondary)">
                  <span class="font-medium text-(--solus-text-primary)">{detail?.author ?? pr.author}</span>
                  added {commits.length} {commits.length === 1 ? "commit" : "commits"}
                  <span class="text-(--solus-text-tertiary)">· {relativeTime(commits[commits.length - 1].committedAt)}</span>
                </p>
                <ul class="mt-2.5 flex flex-col gap-px overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)">
                  {#each commits as commit (commit.sha)}
                    <li class="flex items-center gap-2.5 px-3 py-2">
                      <GitBranchIcon size={13} weight="bold" class="shrink-0 text-(--solus-text-tertiary)" />
                      <span class="min-w-0 flex-1 truncate text-[0.8125rem] text-(--solus-text-secondary)">{commit.message}</span>
                      <code class="shrink-0 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">{commit.sha.slice(0, 7)}</code>
                    </li>
                  {/each}
                </ul>
              </div>
            </li>
          {/if}
        </ol>
      </main>

      <!-- Right sidebar -->
      <aside class="hidden w-56 shrink-0 flex-col gap-6 @min-[50rem]:flex">
        <!-- Status -->
        {#if statusBadge}
          <div>
            <h3 class="mb-2 text-[0.6875rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
              Status
            </h3>
            <span
              class="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium"
              style="color: {statusBadge.tone}"
            >
              <statusBadge.Icon size={14} weight="bold" />
              {statusBadge.label}
            </span>
          </div>
        {/if}

        <!-- Reviewers -->
        <div>
          <h3 class="mb-2 text-[0.6875rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
            Reviewers
          </h3>
          {#if reviewersLoading}
            <div class="flex flex-col gap-2">
              <Skeleton class="h-4 w-24 rounded bg-(--solus-art-border)" />
            </div>
          {:else if reviewers.length === 0}
            <p class="text-[0.75rem] text-(--solus-text-tertiary)">No reviewers</p>
          {:else}
            <ul class="flex flex-col gap-2" role="list">
              {#each reviewers as reviewer (reviewer.login)}
                <li class="flex items-center gap-2">
                  <PrAvatar name={reviewer.login} size="size-5 text-[0.5625rem]" />
                  <span class="min-w-0 flex-1 truncate text-[0.8125rem] text-(--solus-text-secondary)">
                    {reviewer.login}
                  </span>
                  <PrReviewStateBadge state={reviewer.state} />
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <!-- Files changed -->
        <div>
          <h3 class="mb-2 text-[0.6875rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
            {changedFiles.length} files changed
          </h3>
          {#if filesLoading}
            <div class="flex flex-col gap-1.5">
              {#each Array(3) as _}
                <Skeleton class="h-4 w-full rounded bg-(--solus-art-border)" />
              {/each}
            </div>
          {:else}
            {#if totalAdds + totalDels > 0}
              <div class="mb-3 flex items-center gap-2 text-[0.6875rem] tabular-nums">
                <span class="text-(--solus-art-positive)">+{totalAdds}</span>
                <span class="text-(--solus-art-negative)">-{totalDels}</span>
              </div>
            {/if}
            <ul class="flex flex-col gap-0.5" role="list">
              {#each visibleFiles as file (file.path)}
                {@const icon = fileTypeIcon(file.path)}
                <li class="flex items-center gap-1.5 py-0.5">
                  {#if icon}
                    <Icon icon={icon} class="size-3.5 shrink-0" />
                  {:else}
                    <FileIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
                  {/if}
                  <span class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-secondary)"
                    use:tooltip={file.path}
                  >
                    {file.path.split("/").pop()}
                  </span>
                  <span class="shrink-0 text-[0.625rem] tabular-nums text-(--solus-art-positive)">+{file.additions}</span>
                  <span class="shrink-0 text-[0.625rem] tabular-nums text-(--solus-art-negative)">-{file.deletions}</span>
                </li>
              {/each}
            </ul>
            {#if moreFiles > 0}
              <button
                type="button"
                class="mt-1.5 cursor-pointer border-0 bg-transparent p-0 text-[0.75rem] text-(--solus-accent) hover:underline"
                onclick={() => (filesExpanded = !filesExpanded)}
              >
                {filesExpanded ? "Show fewer" : `${moreFiles} more files`}
              </button>
            {/if}
          {/if}
        </div>
      </aside>
    </div>
  </div>
</div>
