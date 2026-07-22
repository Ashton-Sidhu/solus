<script lang="ts">
  import {
    ArrowsCounterClockwiseIcon,
    CheckCircleIcon,
    ChatCircleIcon,
    GitCommitIcon,
    GitPullRequestIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { ReviewComment, ReviewThread } from "../../../shared/providers";
  import {
    formatTimeAgoFromTimestamp,
    formatAbsoluteTimestamp,
  } from "../../lib/sessionUtils";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import { githubMarkdownExtensions } from "../../lib/githubMarkdown";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { githubMarkdownRenderers } from "../ui/markdown-renderers";
  import { Skeleton } from "../ui/skeleton";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import PrReviewStateBadge from "../prs/PrReviewStateBadge.svelte";
  import PrThreadCard from "./PrThreadCard.svelte";
  import type { ActivityEvent } from "./lib/activity-data";
  import {
    activityEventKey,
    commitRunAuthorLabel,
    commitRunPreview,
    reviewMilestone,
  } from "./lib/activity-data";

  // The activity timeline proper: the opened event plus commits, review
  // threads, and conversation interleaved by time on one hairline spine.
  // Signal hierarchy — milestone review verdicts (approved / changes
  // requested) get tinted headline rows, conversations sit mid-weight, and
  // commit runs demote to small tertiary nodes that collapse when long.
  let {
    events,
    loading = false,
    filtered = false,
    authorName,
    openedAt,
    onJump,
    onReply,
    onResolve,
  }: {
    /** Already filtered by the host; thread events keep the parent's object
     *  identity (PrThreadCard mutates reply/resolve in place — the Diff tab
     *  renders the same objects). */
    events: ActivityEvent[];
    /** Commits/comments still loading — renders ghost rows on the spine. */
    loading?: boolean;
    /** A header filter is active, so an empty list means "nothing matches". */
    filtered?: boolean;
    /** PR author, the opened event's subject and commit-author fallback. */
    authorName: string;
    /** When the PR opened (ms); null until `detail` resolves. */
    openedAt: number | null;
    /** Jump to a thread's / file's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    onReply: (threadId: string, body: string) => Promise<ReviewComment>;
    onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  } = $props();

  // Comment/review bodies are GitHub markdown — same pipeline as the PR
  // description, scaled to the timeline's 13px type with edge margins trimmed.
  const bodyProseClass =
    "github-markdown prose-cloud mt-1.5 text-[0.8125rem] leading-relaxed text-(--solus-text-secondary) [--solus-font-weight-body:400] [&>:first-child]:mt-0 [&>:last-child]:mb-0";

  // Which commit runs are expanded past their preview, keyed by event key.
  // Mutated in place ($state proxies are deeply reactive); stale keys from a
  // previous PR are harmless — its runs simply start collapsed again.
  const expandedRuns = $state<Record<string, boolean>>({});

  function expandRun(key: string) {
    expandedRuns[key] = true;
    requestInputFocus();
  }

  function commentTs(createdAt: string): number {
    return new Date(createdAt).getTime();
  }
</script>

<!-- Sparse timelines (a fresh PR: opened + one commit run) tighten up so the
     page doesn't read as a few rows adrift in whitespace; the airy gap is
     reserved for feeds long enough to need the breathing room. -->
<ol
  class="relative flex flex-col {loading || events.length > 3
    ? 'gap-8'
    : 'gap-6'}"
  role="list"
>
  <span
    class="absolute top-3 bottom-3 left-3.5 w-px bg-[linear-gradient(to_bottom,var(--solus-art-border),var(--solus-art-border)_85%,transparent)]"
    aria-hidden="true"
  ></span>

  <!-- Opened event: fixed first row, never filtered out. -->
  <li class="relative flex gap-4 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
    <span
      class="relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-(--solus-container-bg) text-(--solus-art-positive) shadow-[0_0_0_1px_var(--solus-art-border)]"
    >
      <GitPullRequestIcon size={13} weight="bold" />
    </span>
    <div class="min-w-0 flex-1 pt-1">
      <p class="text-[0.8125rem] text-(--solus-text-secondary)">
        <span class="font-semibold text-(--solus-text-primary)">{authorName}</span>
        opened this pull request{#if openedAt}<span
            class="text-(--solus-text-tertiary)"
            use:tooltip={formatAbsoluteTimestamp(openedAt)}
          >
            · {formatTimeAgoFromTimestamp(openedAt)}</span
          >{/if}
      </p>
    </div>
  </li>

  {#if loading}
    <!-- Ghost rows share the spine so loading reads as the timeline filling in. -->
    {#each [0, 1, 2] as ghost (ghost)}
      <li class="relative flex gap-4" aria-hidden="true">
        <Skeleton
          class="relative z-10 mt-0.5 size-7 shrink-0 rounded-full bg-(--solus-art-border)"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-2 pt-1.5">
          <Skeleton class="h-3 w-52 rounded bg-(--solus-art-border)" />
          {#if ghost !== 2}
            <Skeleton class="h-3 w-80 max-w-full rounded bg-(--solus-art-border)" />
          {/if}
        </div>
      </li>
    {/each}
  {:else}
    {#each events as event (activityEventKey(event))}
      {#if event.kind === "commits"}
        {@const preview = commitRunPreview(
          event.commits,
          expandedRuns[activityEventKey(event)] ?? false,
        )}
        <!-- Commit runs are low-signal: a small tertiary node (mx-1 keeps its
             center on the left-3.5 spine and the content column aligned) and
             12px meta type; long runs collapse behind a quiet expander. -->
        <li class="relative flex gap-4 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
          <span
            class="relative z-10 mx-1 mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-(--solus-container-bg) text-(--solus-text-tertiary) shadow-[0_0_0_1px_var(--solus-art-border)]"
          >
            <GitCommitIcon size={11} weight="bold" />
          </span>
          <div class="min-w-0 flex-1 pt-1">
            <p class="text-[0.75rem] text-(--solus-text-tertiary)">
              <span class="font-medium text-(--solus-text-secondary)"
                >{commitRunAuthorLabel(event.commits, authorName)}</span
              >
              added {event.commits.length}
              {event.commits.length === 1 ? "commit" : "commits"}
              <span use:tooltip={formatAbsoluteTimestamp(event.ts)}
                >· {formatTimeAgoFromTimestamp(event.ts)}</span
              >
            </p>
            <!-- Sha + message only — the run header already credits the author,
                 and repeating the name at the row's far edge reads orphaned. -->
            <ul class="mt-2 flex flex-col gap-1" role="list">
              {#each preview.visible as commit (commit.sha)}
                <li class="flex items-baseline gap-2.5">
                  <code
                    class="shrink-0 font-mono text-[0.6875rem] text-(--solus-text-tertiary)"
                    >{commit.sha.slice(0, 7)}</code
                  >
                  <span
                    class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-secondary)"
                    >{commit.message}</span
                  >
                </li>
              {/each}
            </ul>
            {#if preview.hidden > 0}
              <Button
                type="button"
                variant="ghost"
                class="-mx-2 mt-1 justify-start cursor-pointer rounded-lg px-2 py-1 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)"
                onclick={() => expandRun(activityEventKey(event))}
              >
                Show {preview.hidden} more commit{preview.hidden === 1 ? "" : "s"}
              </Button>
            {/if}
          </div>
        </li>
      {:else if event.kind === "thread"}
        <li class="relative flex gap-4 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
          <span
            class={event.thread.isResolved
              ? "relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-(--solus-container-bg) text-(--solus-art-positive) shadow-[0_0_0_1px_var(--solus-art-border)]"
              : "relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-(--solus-container-bg) text-(--solus-accent) shadow-[0_0_0_1px_var(--solus-art-border)]"}
          >
            {#if event.thread.isResolved}
              <CheckCircleIcon size={13} weight="fill" />
            {:else}
              <ChatCircleIcon size={13} weight="fill" />
            {/if}
          </span>
          <!-- Bare column: PrThreadCard brings its own raised surface. -->
          <div class="min-w-0 flex-1">
            <PrThreadCard
              thread={event.thread}
              {onJump}
              {onReply}
              {onResolve}
            />
          </div>
        </li>
      {:else}
        {@const milestone = reviewMilestone(event.comment)}
        {@const ts = commentTs(event.comment.createdAt)}
        {#if milestone}
          <!-- Milestone verdict: the single most important event in a PR's
               life — tinted node + bold headline, no badge (the headline IS
               the verdict). Same icons as PrReviewStateBadge. -->
          <li class="relative flex gap-4 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
            <span
              class={milestone.tone === "positive"
                ? "relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-(--solus-container-bg) text-(--solus-art-positive) shadow-[0_0_0_1px_var(--solus-art-border)]"
                : "relative z-10 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-(--solus-container-bg) text-(--solus-art-negative) shadow-[0_0_0_1px_var(--solus-art-border)]"}
            >
              {#if milestone.tone === "positive"}
                <CheckCircleIcon size={13} weight="fill" />
              {:else}
                <ArrowsCounterClockwiseIcon size={13} weight="bold" />
              {/if}
            </span>
            <div class="min-w-0 flex-1 pt-1">
              <p class="text-[0.8125rem] font-semibold text-(--solus-text-primary)">
                {event.comment.author}
                {milestone.headline}<span
                  class="font-normal text-(--solus-text-tertiary)"
                  use:tooltip={formatAbsoluteTimestamp(ts)}
                >
                  · {formatTimeAgoFromTimestamp(ts)}</span
                >
              </p>
              {#if event.comment.body.trim()}
                <div class={bodyProseClass}>
                  <SvelteMarkdown
                    source={event.comment.body}
                    extensions={githubMarkdownExtensions}
                    renderers={githubMarkdownRenderers}
                    sanitizeUrl={remoteMarkdownSanitizeUrl}
                  />
                </div>
              {/if}
            </div>
          </li>
        {:else}
          <li class="relative flex gap-4 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
            <span
              class="relative z-10 mt-0.5 shrink-0 rounded-full shadow-[0_0_0_3px_var(--solus-container-bg)]"
            >
              <PrAvatar
                name={event.comment.author}
                size="size-7 text-[0.625rem]"
              />
            </span>
            <div class="min-w-0 flex-1 pt-0.5">
              <div class="text-[0.8125rem]">
                <span class="font-medium text-(--solus-text-primary)"
                  >{event.comment.author}</span
                >
                <span
                  class="text-(--solus-text-tertiary)"
                  use:tooltip={formatAbsoluteTimestamp(ts)}
                >
                  · {formatTimeAgoFromTimestamp(ts)}</span
                >
                {#if event.comment.kind === "review" && event.comment.reviewState}
                  <span class="ml-2 inline-flex align-middle">
                    <PrReviewStateBadge state={event.comment.reviewState} />
                  </span>
                {/if}
              </div>
              {#if event.comment.body.trim()}
                <div class={bodyProseClass}>
                  <SvelteMarkdown
                    source={event.comment.body}
                    extensions={githubMarkdownExtensions}
                    renderers={githubMarkdownRenderers}
                    sanitizeUrl={remoteMarkdownSanitizeUrl}
                  />
                </div>
              {/if}
            </div>
          </li>
        {/if}
      {/if}
    {/each}
    {#if filtered && events.length === 0}
      <li class="relative flex gap-4 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
        <span class="size-7 shrink-0" aria-hidden="true"></span>
        <p class="min-w-0 flex-1 pt-1 text-[0.8125rem] text-(--solus-text-tertiary)">
          Nothing matches this filter.
        </p>
      </li>
    {/if}
  {/if}
</ol>
