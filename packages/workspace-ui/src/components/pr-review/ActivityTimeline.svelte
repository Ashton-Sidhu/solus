<script lang="ts">
  import {
    RefreshCcw as ArrowsCounterClockwiseIcon,
    ChevronDown as CaretDownIcon,
    CircleAlert as CircleAlertIcon,
    CircleCheck as CheckCircleIcon,
    MessageCircle as ChatCircleIcon,
    GitCommitHorizontal as GitCommitIcon,
    GitPullRequest as GitPullRequestIcon,
    LayoutTemplate as ArtifactIcon,
    LoaderCircle as LoaderIcon,
    Tag as TagIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import GithubMarkdown from '../github-markdown/GithubMarkdown.svelte';
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
    reviewMilestone,
    type ActivityEvent,
  } from "./lib/activity-data";

  // The activity timeline proper: the opened event plus commits, review
  // threads, and conversation interleaved by time on one hairline spine.
  // Signal hierarchy — milestone review verdicts (approved / changes
  // requested) get tinted headline rows, conversations sit mid-weight, and
  // commit runs demote to small tertiary nodes that collapse when long.
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

  // Comment/review bodies are GitHub markdown — same pipeline *and* the same
  // `.prose-pr` typography as the description above them. Sizes/colour can't be
  // set with utilities here: the `.prose-cloud` rules are unlayered and win.
  const bodyProseClass = "github-markdown prose-cloud prose-pr prose-pr-activity";

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

<!-- A review verdict's words sit on a card under the verdict headline. An
     ordinary comment builds the same card with its author row inside it (see
     below), so every comment is one bounded object on the spine. The card is
     the rail's status-card material: 14px corners and a hairline border. Not a
     box-shadow ring: each timeline row has `content-visibility: auto`, whose
     paint containment clips anything drawn outside the row's box, so a shadow
     ring lost its right and bottom edges. -->
{#snippet commentBody(body: string)}
  <div class="mt-2 rounded-[14px] border border-[var(--hairline-strong)] bg-card px-4 py-3.5">
    <div class={bodyProseClass}>
      <GithubMarkdown
        source={body}
      />
    </div>
  </div>
{/snippet}

<!-- A person on the spine: their host avatar as the node, opaque over the
     rail. A verdict, when the row carries one, is a small tinted badge on the
     avatar's corner rather than a glyph in the person's place. The node is
     pinned to the avatar's 22px: as a flex child it would otherwise stretch
     to the row's full height, and its opaque background would blank the
     spine for the whole row.

     Rows that carry one are `-m-1 p-1`: the halo and the verdict badge reach
     past the node's box, and the row's `content-visibility: auto` clips paint
     to the row. The pair grows the row's box by 4px on every side without
     moving anything in it. -->
{#snippet avatarNode(author: string, avatarUrl: string | undefined, tone?: "positive" | "negative")}
  <span
    class="relative z-10 mt-0.5 size-[22px] shrink-0 self-start rounded-full bg-background shadow-[0_0_0_3px_var(--background)]"
  >
    <PrAvatar name={author} url={avatarUrl} size="size-[22px] text-xs" />
    {#if tone}
      <span
        class="absolute -right-1 -bottom-1 grid size-[14px] place-items-center rounded-full bg-background {tone ===
        'positive'
          ? 'text-(--solus-art-positive)'
          : 'text-(--solus-art-negative)'}"
        aria-hidden="true"
      >
        {#if tone === "positive"}
          <CheckCircleIcon size={12} weight="fill" />
        {:else}
          <ArrowsCounterClockwiseIcon size={11} weight="bold" />
        {/if}
      </span>
    {/if}
  </span>
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
        <li class="relative flex gap-2 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
          <span
            class={event.thread.isResolved
              ? "relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-(--solus-art-positive)"
              : "relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-primary"}
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
              fullDiffHunk={threadDiffHunks.get(event.thread.id)}
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
        {@const hasBody = hasVisibleBody(event.comment.body)}
        {#if milestone}
          <!-- Milestone verdict: the single most important event in a PR's
               life — the reviewer's avatar with the verdict as its badge, and
               a bold headline (the headline IS the verdict). Same icons as
               PrReviewStateBadge. -->
          <li class="relative -m-1 flex gap-2 p-1 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
            {@render avatarNode(
              event.comment.author,
              event.comment.authorAvatarUrl,
              milestone.tone,
            )}
            <div class="group/comment min-w-0 flex-1 pt-0.5">
              <p class="flex items-start gap-2  font-medium">
                <span class="min-w-0 flex-1">
                  {event.comment.author}
                  {milestone.headline}{" "}<TooltipUI.Root>
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
                {@render commentBody(event.comment.body)}
              {/if}
            </div>
          </li>
        {:else}
          {@const bodyOpen = hasBody && !collapsedComments[eventKey]}
          <!-- GitHub's comment shape: the author row is the card's tinted
               header, ruled off from the body, so where one comment ends and
               the next event starts is never in doubt — however many rules and
               callouts a bot puts inside it. -->
          <li class="relative -m-1 flex gap-2 p-1 [contain-intrinsic-size:auto_8rem] [content-visibility:auto]">
            <!-- Dropped so the avatar sits on the header's centre line. -->
            <span class="flex shrink-0 self-start pt-[5px]">
              {@render avatarNode(event.comment.author, event.comment.authorAvatarUrl)}
            </span>
            <div class="group/comment min-w-0 flex-1 overflow-hidden rounded-[14px] border border-[var(--hairline-strong)] bg-card">
              <div
                class="flex min-h-9 items-center gap-2 py-1 pr-2 pl-4 {bodyOpen
                  ? 'shadow-[inset_0_-0.5px_0_var(--hairline-strong)]'
                  : ''}"
              >
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
                <!-- A comment-only review is stored as `COMMENTED`; on a card
                     that is already a comment the badge says nothing. Only a
                     state that changes the review's standing gets one. -->
                {#if event.comment.kind === "review" && event.comment.reviewState && event.comment.reviewState !== "COMMENTED"}
                  <span class="ml-2 inline-flex align-middle">
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
                <div class="px-4 py-3.5">
                  <div class={bodyProseClass}>
                    <GithubMarkdown source={event.comment.body} />
                  </div>
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
