<script lang="ts">
  import {
    ArrowsCounterClockwiseIcon,
    CaretDownIcon,
    CheckCircleIcon,
    ChatCircleIcon,
    GitCommitIcon,
    GitPullRequestIcon,
  } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { PrCommit, ReviewComment, ReviewThread } from "../../../shared/providers";
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
    onOpenCommit,
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
    /** Open the diff scoped to one commit's changes. */
    onOpenCommit?: (commit: PrCommit) => void;
    onReply: (threadId: string, body: string) => Promise<ReviewComment>;
    onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  } = $props();

  // Comment/review bodies are GitHub markdown — same pipeline *and* the same
  // `.prose-pr` typography as the description above them. Sizes/colour can't be
  // set with utilities here: the `.prose-cloud` rules are unlayered and win.
  const bodyProseClass = "github-markdown prose-cloud prose-pr mt-1.5";

  // Which commit runs are expanded past their preview, keyed by event key.
  // Mutated in place ($state proxies are deeply reactive); stale keys from a
  // previous PR are harmless — its runs simply start collapsed again.
  const expandedRuns = $state<Record<string, boolean>>({});

  function expandRun(key: string) {
    expandedRuns[key] = true;
    requestInputFocus();
  }

  // Which comment bodies are folded away to their header row, keyed the same
  // way. Bodies start open — a CI bot's screenful is worth folding once you've
  // read it, but nothing here is hidden by default. Focus stays on the toggle
  // rather than returning to the composer: it is the control you press again to
  // undo the fold.
  const collapsedComments = $state<Record<string, boolean>>({});

  function toggleComment(key: string) {
    collapsedComments[key] = !collapsedComments[key];
  }

  function commentTs(createdAt: string): number {
    return new Date(createdAt).getTime();
  }
</script>

<!-- The fold control: quiet until the row is hovered or the body is already
     folded, so a read-through timeline shows no chrome at all. -->
{#snippet collapseToggle(key: string, author: string)}
  {@const collapsed = collapsedComments[key] ?? false}
  <Button
    type="button"
    variant="ghost"
    size="icon-xs"
    aria-expanded={!collapsed}
    aria-label="{collapsed ? 'Expand' : 'Collapse'} comment from {author}"
    class="text-sm shrink-0 cursor-pointer text-muted-foreground opacity-0 transition-[opacity,color] hover:text-foreground focus-visible:opacity-100 group-hover/comment:opacity-100 pointer-coarse:opacity-100 {collapsed
      ? 'opacity-100'
      : ''}"
    onclick={() => toggleComment(key)}
  >
    <CaretDownIcon
      size={12}
      weight="bold"
      class="transition-transform duration-150 {collapsed ? '-rotate-90' : ''}"
    />
  </Button>
{/snippet}

<!-- The spine: a 1px rail under 22px nodes, so every row's content column
     starts 30px in (node + gap) and the rail runs through the node centers. -->
<ol class="text-sm relative flex flex-col gap-5" role="list">
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
      <p class="text-muted-foreground">
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
            <p class="text-muted-foreground">
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
                <li>
                  <!-- Each chip opens the diff scoped to that commit. Raw
                       button by the list-row rule; hover promotes the message
                       to foreground so the chip reads as pressable. -->
                  <button
                    type="button"
                    class="group/commit flex w-full cursor-pointer items-center gap-3 rounded-2xl bg-card px-3 py-[9px] text-left shadow-[inset_0_0_0_.5px_var(--hairline-strong)] transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label="View changes in commit {commit.sha.slice(0, 7)}"
                    onclick={() => onOpenCommit?.(commit)}
                  >
                    <code class="shrink-0 font-mono text-xs text-primary"
                      >{commit.sha.slice(0, 7)}</code
                    >
                    <span
                      class="min-w-0 flex-1 truncate  text-muted-foreground transition-colors group-hover/commit:text-foreground"
                      >{commit.message}</span
                    >
                  </button>
                </li>
              {/each}
            </ul>
            {#if preview.hidden > 0}
              <Button
                type="button"
                variant="ghost"
                class="-mx-2 mt-1.5 h-[24px] cursor-pointer justify-start rounded-md border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
        {@const eventKey = activityEventKey(event)}
        {@const hasBody = event.comment.body.trim().length > 0}
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
            <div class="group/comment min-w-0 flex-1 pt-1">
              <p class="flex items-start gap-2  font-medium">
                <span class="min-w-0 flex-1">
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
                </span>
                {#if hasBody}
                  {@render collapseToggle(eventKey, event.comment.author)}
                {/if}
              </p>
              {#if hasBody && !collapsedComments[eventKey]}
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
                url={event.comment.authorAvatarUrl}
                size="size-[22px] text-xs"
              />
            </span>
            <div class="group/comment min-w-0 flex-1 pt-0.5">
              <div class="flex items-start gap-2 ">
                <span class="min-w-0 flex-1">
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
                </span>
                {#if hasBody}
                  {@render collapseToggle(eventKey, event.comment.author)}
                {/if}
              </div>
              {#if hasBody && !collapsedComments[eventKey]}
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
        <p class="min-w-0 flex-1 pt-1  text-muted-foreground">
          Nothing matches this filter.
        </p>
      </li>
    {/if}
  {/if}
</ol>
