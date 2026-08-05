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
  import * as TooltipUI from "@renderer/components/ui/tooltip";
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

  // Comment/review bodies are GitHub markdown — same pipeline *and* the same
  // `.prose-pr` typography as the description above them. Sizes/colour can't be
  // set with utilities here: the `.prose-cloud` rules are unlayered and win.
  const bodyProseClass = "github-markdown prose-cloud prose-pr prose-pr-comment mt-1.5";

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

<!-- The spine: a 1px rail under 22px nodes, so every row's content column
     starts 30px in (node + gap) and the rail runs through the node centers. -->
<ol class="relative flex flex-col gap-5" role="list">
  <span
    class="absolute top-2 bottom-2 left-[11px] w-px bg-border"
    aria-hidden="true"
  ></span>

  <!-- Opened event: fixed first row, never filtered out. Nodes are neutral
       discs throughout — the glyph's tint carries the state, so the spine
       reads as one material instead of a column of coloured badges. -->
  <li class="relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
    <span
      class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-primary"
    >
      <GitPullRequestIcon size={13} weight="bold" />
    </span>
    <div class="min-w-0 flex-1 pt-1">
      <p class="text-[13px] text-muted-foreground">
        <span class="font-medium text-foreground">{authorName}</span>
        opened this pull request{#if openedAt}<TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <span {...tooltipProps}
            class="text-muted-foreground"
          >
            · {formatTimeAgoFromTimestamp(openedAt)}</span
          >
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={formatAbsoluteTimestamp(openedAt)} />
        </TooltipUI.Root>{/if}
      </p>
    </div>
  </li>

  {#if loading}
    <!-- Ghost rows share the spine so loading reads as the timeline filling in. -->
    {#each [0, 1, 2] as ghost (ghost)}
      <li class="relative flex gap-2" aria-hidden="true">
        <Skeleton
          class="relative z-10 mt-0.5 size-[22px] shrink-0 rounded-full bg-muted"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-2 pt-1.5">
          <Skeleton class="h-3 w-52 rounded bg-muted" />
          {#if ghost !== 2}
            <Skeleton class="h-3 w-80 max-w-full rounded bg-muted" />
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
        <!-- Commit runs keep the spine's node size and type; the muted colour
             alone demotes them. Long runs collapse behind a quiet expander. -->
        <li class="relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
          <span
            class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
          >
            <GitCommitIcon size={12} weight="bold" />
          </span>
          <div class="min-w-0 flex-1 pt-1">
            <p class="text-[13px] text-muted-foreground">
              <span class="font-medium text-foreground"
                >{commitRunAuthorLabel(event.commits, authorName)}</span
              >
              added {event.commits.length}
              {event.commits.length === 1 ? "commit" : "commits"}
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props: tooltipProps })}
                    <span {...tooltipProps}
                >· {formatTimeAgoFromTimestamp(event.ts)}</span
              >
                  {/snippet}
                </TooltipUI.Trigger>
                <TooltipUI.Content value={formatAbsoluteTimestamp(event.ts)} />
              </TooltipUI.Root>
            </p>
            <!-- Sha + message only — the run header already credits the author,
                 and repeating the name at the row's far edge reads orphaned.
                 Each commit sits on its own card chip inside a half-pixel ring:
                 shas are literals, and a bare column of them disappears into the
                 surrounding prose. A ring rather than a wash, so the chips read
                 as objects lifted off the timeline instead of holes punched in
                 it — same treatment as the composer at the foot of the feed. -->
            <ul class="mt-2 flex flex-col gap-1.5" role="list">
              {#each preview.visible as commit (commit.sha)}
                <li
                  class="flex items-center gap-3 rounded-[10px] bg-card px-3 py-[9px] shadow-[inset_0_0_0_.5px_var(--hairline-strong)]"
                >
                  <code class="shrink-0 font-mono text-[11px] text-primary"
                    >{commit.sha.slice(0, 7)}</code
                  >
                  <span
                    class="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground"
                    >{commit.message}</span
                  >
                </li>
              {/each}
            </ul>
            {#if preview.hidden > 0}
              <Button
                type="button"
                variant="ghost"
                class="-mx-2 mt-1.5 h-[24px] cursor-pointer justify-start rounded-md border-0 bg-transparent px-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onclick={() => expandRun(activityEventKey(event))}
              >
                Show {preview.hidden} more commit{preview.hidden === 1 ? "" : "s"}
              </Button>
            {/if}
          </div>
        </li>
      {:else if event.kind === "thread"}
        <li class="relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
          <span
            class={event.thread.isResolved
              ? "relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-(--solus-art-positive)"
              : "relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-primary"}
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
          <li class="relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
            <span
              class={milestone.tone === "positive"
                ? "relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-(--solus-art-positive)"
                : "relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-(--solus-art-negative)"}
            >
              {#if milestone.tone === "positive"}
                <CheckCircleIcon size={13} weight="fill" />
              {:else}
                <ArrowsCounterClockwiseIcon size={13} weight="bold" />
              {/if}
            </span>
            <div class="min-w-0 flex-1 pt-1">
              <p class="text-[13px] font-medium">
                {event.comment.author}
                {milestone.headline}<TooltipUI.Root>
                  <TooltipUI.Trigger>
                    {#snippet child({ props: tooltipProps })}
                      <span {...tooltipProps}
                  class="font-normal text-muted-foreground"
                >
                  · {formatTimeAgoFromTimestamp(ts)}</span
                >
                    {/snippet}
                  </TooltipUI.Trigger>
                  <TooltipUI.Content value={formatAbsoluteTimestamp(ts)} />
                </TooltipUI.Root>
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
          <li class="relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
            <span
              class="relative z-10 mt-0.5 shrink-0 rounded-full shadow-[0_0_0_3px_var(--card)]"
            >
              <PrAvatar
                name={event.comment.author}
                size="size-[22px] text-[9.5px]"
              />
            </span>
            <div class="min-w-0 flex-1 pt-0.5">
              <div class="text-[13px]">
                <span class="font-medium text-foreground"
                  >{event.comment.author}</span
                >
                <TooltipUI.Root>
                  <TooltipUI.Trigger>
                    {#snippet child({ props: tooltipProps })}
                      <span {...tooltipProps}
                  class="text-muted-foreground"
                >
                  · {formatTimeAgoFromTimestamp(ts)}</span
                >
                    {/snippet}
                  </TooltipUI.Trigger>
                  <TooltipUI.Content value={formatAbsoluteTimestamp(ts)} />
                </TooltipUI.Root>
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
      <li class="relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
        <span class="size-[22px] shrink-0" aria-hidden="true"></span>
        <p class="min-w-0 flex-1 pt-1 text-[13px] text-muted-foreground">
          Nothing matches this filter.
        </p>
      </li>
    {/if}
  {/if}
</ol>
