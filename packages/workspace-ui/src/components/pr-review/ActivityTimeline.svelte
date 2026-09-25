<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    CircleAlert as CircleAlertIcon,
    CircleCheck as CheckCircleIcon,
    GitCommitHorizontal as GitCommitIcon,
    GitPullRequest as GitPullRequestIcon,
    LayoutTemplate as ArtifactIcon,
    LoaderCircle as LoaderIcon,
    Tag as TagIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import CommentMarkdown from '../github-markdown/CommentMarkdown.svelte';
  import type { PrCommit, ReviewComment, ReviewThread } from "@solus/contracts/providers";
  import {
    formatTimeAgoFromTimestamp,
    formatAbsoluteTimestamp,
  } from "../../lib/sessionUtils";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { Skeleton } from "../ui/skeleton";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import ArtifactActivityCard from "../artifact/ArtifactActivityCard.svelte";
  import PrReviewStateBadge from "../prs/PrReviewStateBadge.svelte";
  import PrThreadCard from "./PrThreadCard.svelte";
  import {
    activityEventKey,
    commitRunAuthorLabel,
    commitRunPreview,
    hasVisibleBody,
    prLabelActivityText,
    reviewThreadDiffHunks,
    type ActivityEvent,
  } from "./lib/activity-data";

  // The activity timeline proper: the opened event plus commits, review
  // threads, and conversation interleaved by time on one hairline spine.
  // Signal hierarchy — comments, reviews, and open threads are full-width
  // cards that break the spine (a verdict is the badge in the card's header),
  // and commit runs demote to small tertiary nodes that collapse when long.
  let {
    events,
    diffPatch = null,
    loading = false,
    loadFailed = false,
    onRetry,
    filtered = false,
    authorName,
    openedAt,
    viewerLogin,
    deletingCommentIds,
    artifactsEnabled = true,
    onJump,
    onOpenCommit,
    onReply,
    onResolve,
    onDeleteComment,
  }: {
    /** Already filtered by the host; thread events keep the parent's object
     *  identity (PrThreadCard mutates reply/resolve in place — the Diff tab
     *  renders the same objects). */
    events: ActivityEvent[];
    /** Full PR patch for comment-centered inline diff context. */
    diffPatch?: string | null;
    /** Commits/comments still loading — renders ghost rows on the spine. */
    loading?: boolean;
    /** A commit, comment, or thread read did not answer. The spine says so in
     *  the row those events would fill, and offers the retry. */
    loadFailed?: boolean;
    onRetry?: () => void;
    /** A header filter is active, so an empty list means "nothing matches". */
    filtered?: boolean;
    /** PR author, the opened event's subject and commit-author fallback. */
    authorName: string;
    /** When the PR opened (ms); null until `detail` resolves. */
    openedAt: number | null;
    /** Connected provider identity. Only this author's issue comments can be deleted. */
    viewerLogin: string;
    deletingCommentIds: ReadonlySet<string>;
    /** False while the tab is mounted but hidden, so an opened artifact card
     *  holds no live frame nobody can see. */
    artifactsEnabled?: boolean;
    /** Jump to a thread's / file's location in the Diff tab. */
    onJump?: (path: string, line: number | null) => void;
    /** Open the diff scoped to one commit's changes. */
    onOpenCommit?: (commit: PrCommit) => void;
    onReply: (threadId: string, body: string) => Promise<ReviewComment>;
    onResolve: (threadId: string, resolved: boolean) => Promise<void>;
    onDeleteComment: (commentId: string) => Promise<void>;
  } = $props();

  const threadDiffHunks = $derived(reviewThreadDiffHunks(diffPatch, events));

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

  // Resolved threads the reader reopened, keyed by thread id. Lifted out of
  // PrThreadCard because the row's shape depends on it: a folded resolved
  // thread is one line on the spine, an open thread is a full-width card that
  // breaks the rail.
  const shownResolvedThreads = $state<Record<string, boolean>>({});

  /** One live frame at a time: the artifact card the reader has open. */
  let openArtifactWorkId = $state<string | null>(null);

  function toggleArtifact(workId: string) {
    openArtifactWorkId = openArtifactWorkId === workId ? null : workId;
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

{#snippet deleteCommentButton(commentId: string, author: string)}
  <Button
    type="button"
    variant="ghost"
    size="icon-xs"
    disabled={deletingCommentIds.has(commentId)}
    aria-label="Delete comment from {author}"
    title="Delete comment"
    class="shrink-0 cursor-pointer text-muted-foreground opacity-0 transition-[opacity,color] hover:text-destructive focus-visible:opacity-100 group-hover/comment:opacity-100 pointer-coarse:opacity-100"
    onclick={() => void onDeleteComment(commentId)}
  >
    {#if deletingCommentIds.has(commentId)}
      <LoaderIcon size={12} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    {:else}
      <TrashIcon size={12} aria-hidden="true" />
    {/if}
  </Button>
{/snippet}

<!-- The spine: a 1px rail under 22px nodes, so every row's content column
     starts 30px in (node + gap) and the rail runs through the node centers.
     Comments, reviews, and open review threads are the exception: they span
     the full width and break the rail.
     Every node is opaque — the muted wash is mixed over the page background
     rather than laid over it — so the rail stops at a node's edge instead of
     showing through it. -->
<ol
  class="relative flex flex-col gap-5 [.is-laptop-display_&]:gap-4"
  role="list"
>
  <span
    class="absolute top-2 bottom-2 left-[11px] w-px bg-border"
    aria-hidden="true"
  ></span>

  <!-- Opened event: fixed first row, never filtered out. Nodes are neutral
       discs throughout — the glyph's tint carries the state, so the spine
       reads as one material instead of a column of coloured badges. -->
  <li class="relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
    <span
      class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-primary"
    >
      <GitPullRequestIcon size={13} weight="bold" />
    </span>
    <div class="min-w-0 flex-1 pt-1">
      <p class="text-muted-foreground">
        <span class="font-medium text-foreground">{authorName}</span>
        opened this pull request{#if openedAt}{" "}<TooltipUI.Root>
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

  {#if loadFailed}
    <!-- The failure sits on the spine in the row the events would have
         filled, rather than as a banner over the page. -->
    <li class="relative flex gap-2">
      <span
        class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-muted-foreground"
        aria-hidden="true"
      >
        <CircleAlertIcon size={13} />
      </span>
      <p class="flex min-w-0 flex-1 items-center gap-2 pt-1 text-muted-foreground" role="alert">
        <span class="min-w-0">Couldn’t load the activity.</span>
        {#if onRetry}
          <button
            type="button"
            class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            onclick={onRetry}
          >
            Retry
          </button>
        {/if}
      </p>
    </li>
  {:else if loading}
    <!-- Ghost rows share the spine so loading reads as the timeline filling in. -->
    {#each [0, 1, 2] as ghost (ghost)}
      <li class="relative flex gap-2" aria-hidden="true">
        <Skeleton
          class="relative z-10 mt-0.5 size-[22px] shrink-0 rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))]"
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
            class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-muted-foreground"
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
                 Plain rows, not chips: a run of commits is a list to scan, and
                 a ringed card per commit outweighed the comments around it. -->
            <ul class="mt-1 flex flex-col" role="list">
              {#each preview.visible as commit (commit.sha)}
                <li>
                  <!-- Each row opens the diff scoped to that commit. Raw
                       button by the list-row rule; the hover wash and the
                       message's step to foreground say it is pressable. -->
                  <button
                    type="button"
                    class="group/commit -mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2 py-1 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label="View changes in commit {commit.sha.slice(0, 7)}"
                    onclick={() => onOpenCommit?.(commit)}
                  >
                    <code class="shrink-0 font-mono text-[0.9em] text-primary"
                      >{commit.sha.slice(0, 7)}</code
                    >
                    <span
                      class="min-w-0 flex-1 truncate text-foreground/80 transition-colors group-hover/commit:text-foreground"
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
      {:else if event.kind === "label"}
        <li class="relative flex gap-2">
          <span
            class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-muted-foreground"
            aria-hidden="true"
          >
            <TagIcon size={12} />
          </span>
          <p class="min-w-0 flex-1 pt-1 text-muted-foreground">
            {prLabelActivityText(event.item, viewerLogin)}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <span {...tooltipProps}>· {formatTimeAgoFromTimestamp(event.ts)}</span>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value={formatAbsoluteTimestamp(event.ts)} />
            </TooltipUI.Root>
          </p>
        </li>
      {:else if event.kind === "artifact"}
        <!-- A render linked to a task on this pull request, collapsed at the
             moment it was linked. The node is the artifact glyph; the card
             below it opens the live frame in place. -->
        <li class="relative flex gap-2">
          <span
            class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-primary"
            aria-hidden="true"
          >
            <ArtifactIcon size={12} />
          </span>
          <div class="min-w-0 flex-1 pt-0.5">
            <p class="text-muted-foreground">
              An artifact was linked
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props: tooltipProps })}
                    <span {...tooltipProps}>· {formatTimeAgoFromTimestamp(event.ts)}</span>
                  {/snippet}
                </TooltipUI.Trigger>
                <TooltipUI.Content value={formatAbsoluteTimestamp(event.ts)} />
              </TooltipUI.Root>
            </p>
            <div class="mt-2">
              <ArtifactActivityCard
                workId={event.artifact.workId}
                title={event.artifact.title}
                via={event.artifact.taskTitle}
                open={openArtifactWorkId === event.artifact.workId}
                enabled={artifactsEnabled}
                onToggle={() => toggleArtifact(event.artifact.workId)}
              />
            </div>
          </div>
        </li>
      {:else if event.kind === "thread"}
        {@const threadOffRail =
          !event.thread.isResolved || (shownResolvedThreads[event.thread.id] ?? false)}
        <!-- An open thread leaves the spine like a comment (see below). A
             folded resolved thread stays one line beside its green node. One
             row for both shapes, so the card never remounts and keeps its
             reply draft and diff state when the shape changes. -->
        <li
          class={threadOffRail
            ? "relative -my-2.5 bg-background py-2.5 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]"
            : "relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]"}
        >
          {#if !threadOffRail}
            <span
              class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-(--solus-art-positive)"
            >
              <CheckCircleIcon size={13} weight="fill" />
            </span>
          {/if}
          <div class="min-w-0 flex-1">
            <PrThreadCard
              thread={event.thread}
              fullDiffHunk={threadDiffHunks.get(event.thread.id)}
              bind:showResolved={
                () => shownResolvedThreads[event.thread.id] ?? false,
                (shown) => (shownResolvedThreads[event.thread.id] = shown)
              }
              {onJump}
              {onReply}
              {onResolve}
            />
          </div>
        </li>
      {:else}
        {@const ts = commentTs(event.comment.createdAt)}
        {@const eventKey = activityEventKey(event)}
        {@const hasBody = hasVisibleBody(event.comment.body)}
        {@const bodyOpen = hasBody && !collapsedComments[eventKey]}
        <!-- A comment or review leaves the spine: the card takes the
             timeline's full width, the author's avatar moves into its tinted
             header, and a verdict is the badge beside the name. The rail
             breaks around it: the row's opaque background reaches half a gap
             past the card on each side (`-my-2.5 py-2.5`), so the rail stops
             just above the card and resumes just below it, and two adjacent
             cards leave no stub of rail between them. -->
        <li class="relative -my-2.5 bg-background py-2.5 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
          <article class="group/comment overflow-hidden rounded-lg border border-border/60 bg-background">
            <div class="flex min-h-9 items-center gap-2 bg-muted/25 py-1 pr-2 pl-3 text-xs">
              <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              <span class="inline-flex min-w-0 items-center gap-1.5">
                <PrAvatar
                  name={event.comment.author}
                  url={event.comment.authorAvatarUrl}
                  size="size-4 text-[8px]"
                />
                <span class="truncate font-medium text-foreground"
                  >{event.comment.author}</span
                >
              </span>
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props: tooltipProps })}
                    <span {...tooltipProps}
                class="text-muted-foreground"
              >{formatTimeAgoFromTimestamp(ts)}</span
              >
                  {/snippet}
                </TooltipUI.Trigger>
                <TooltipUI.Content value={formatAbsoluteTimestamp(ts)} />
              </TooltipUI.Root>
              <!-- A comment-only review is stored as `COMMENTED`; on a card
                   that is already a comment the badge says nothing. Only a
                   state that changes the review's standing gets one. -->
              {#if event.comment.kind === "review" && event.comment.reviewState && event.comment.reviewState !== "COMMENTED"}
                <span class="inline-flex">
                  <PrReviewStateBadge state={event.comment.reviewState} />
                </span>
              {/if}
              </span>
              {#if hasBody}
                {@render collapseToggle(eventKey, event.comment.author)}
              {/if}
              {#if event.comment.kind === "comment" && viewerLogin && event.comment.author.toLowerCase() === viewerLogin.toLowerCase()}
                {@render deleteCommentButton(event.comment.id, event.comment.author)}
              {/if}
            </div>
            {#if bodyOpen}
              <div class="p-3">
                <CommentMarkdown source={event.comment.body} />
              </div>
            {/if}
          </article>
        </li>
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
