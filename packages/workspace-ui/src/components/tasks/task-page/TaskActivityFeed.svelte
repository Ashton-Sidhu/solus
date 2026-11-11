<script lang="ts">
  import { windowTimeline } from "../../../lib/timeline-window";
  import CommentMarkdown from '../../github-markdown/CommentMarkdown.svelte';
  import { SvelteSet } from "svelte/reactivity";
  import {
    ChevronDown as CaretDownIcon,
    CircleAlert as CircleAlertIcon,
    SquareTerminal as TerminalWindowIcon,
  } from "@lucide/svelte";
  import type { User, UserId } from "@solus/contracts/user";
  import type { Activity } from "@solus/contracts/activity";
  import type {
    TaskComment,
    TaskLink,
    TaskSessionLink,
  } from "@solus/contracts/task-types";
  import ArtifactActivityCard from "../../artifact/ArtifactActivityCard.svelte";
  import UserAvatar from "../../users/UserAvatar.svelte";
  import ActivityRow from "../../activity/ActivityRow.svelte";
  import { activityLine } from "../../activity/lib/activity-line";
  import { Button } from "../../ui/button";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import {
    FILTER_CHIP,
    FILTER_CHIP_OFF,
    FILTER_CHIP_ON,
  } from "../../ui/list-page/filter-styles";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { authorInitials, relativeTime } from "../lib/tasks-api";
  import {
    activityFeed,
    commentAuthorName,
    commentDelivery,
    commentSessionLink,
    commentSessionName,
    linkedArtifactForActivity,
  } from "./lib/task-page";

  interface Props {
    comments: TaskComment[];
    /** The task's `task_changed` activity. */
    activity: Activity[];
    /** The task's current links, so a `linked` change can show the artifact
     *  it brought, collapsed, at the point in the story where it arrived. */
    links?: TaskLink[];
    /** False while the feed is mounted but hidden, so an opened render holds
     *  no live frame nobody can see. */
    enabled?: boolean;
    sessions: TaskSessionLink[];
    onOpenSession: (sessionId: string) => void;
    /** The reader on the task's host: their own comments and changes read "You". */
    currentUserId: UserId | null;
    /** The provider that owns the task, as a person reads it. */
    providerName: string;
    /** Send a comment that the provider did not take again. */
    onRetry: (commentId: string) => Promise<void>;
    /** Discard a comment that the provider did not take. */
    onDiscard: (commentId: string) => Promise<void>;
    /** True where the section is a tab of its own. The strip above already says
     *  "Activity", so the band states the one thing it does not — which end of
     *  the feed is the newest. */
    stacked?: boolean;
  }

  let {
    comments,
    activity,
    links = [],
    enabled = true,
    sessions,
    onOpenSession,
    currentUserId,
    providerName,
    onRetry,
    onDiscard,
    stacked = false,
  }: Props = $props();

  /** The unsent comments with a Retry or a Discard on its way, so that the
   *  row cannot send the same comment two times. */
  let busyCommentIds = $state(new SvelteSet<string>());

  async function settle(commentId: string, command: (commentId: string) => Promise<void>) {
    if (busyCommentIds.has(commentId)) return;
    busyCommentIds.add(commentId);
    try {
      await command(commentId);
    } finally {
      busyCommentIds.delete(commentId);
    }
  }

  type FeedFilter = "all" | "comments";
  let filter = $state<FeedFilter>("all");

  const filterOptions: { value: FeedFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "comments", label: "Comments" },
  ];

  const filterLabel = $derived(
    filterOptions.find((option) => option.value === filter)?.label ?? "All",
  );

  function selectFilter(value: string) {
    const option = filterOptions.find((option) => option.value === value);
    if (!option) return;
    filter = option.value;
    revealedCount = 0;
    requestInputFocus();
  }

  /** One live frame at a time: the artifact card the reader has open. */
  let openArtifactWorkId = $state<string | null>(null);

  function toggleArtifact(workId: string) {
    openArtifactWorkId = openArtifactWorkId === workId ? null : workId;
  }

  const entries = $derived(activityFeed(comments, activity));
  const shown = $derived(
    filter === "all" ? entries : entries.filter((e) => e.type === "comment"),
  );

  let revealedCount = $state(0);
  const revealPage = 10;
  const timelineWindow = $derived(windowTimeline(shown, revealedCount, {
    threshold: 20,
    oldest: 2,
    newest: 8,
    textBudget: 16_000,
    textSize: (entry) => entry.type === "comment" ? entry.comment.body.length : 0,
  }));
  const visibleEntries = $derived([...timelineWindow.before, ...timelineWindow.after]);

  /** An agent's comment is authored by a session, not a person, so it takes the
   *  accent wash and the Solus mark instead of a face. */
  function isAgent(comment: TaskComment): boolean {
    return !!comment.author && comment.author.kind !== "user";
  }

  /** The person who wrote a comment in Solus, drawn with their face. */
  function commentUser(comment: TaskComment): User | null {
    return comment.author?.kind === "user" ? comment.author.user : null;
  }
</script>

<!-- The pull request timeline's grammar (pr-review/ActivityTimeline.svelte):
     the same dense type, 22px nodes on one hairline spine, events as one
     muted line, and each comment a full-width bordered card whose author row
     is its header, breaking the spine. A task and a pull request are read side by side, so their
     histories read the same way. -->
<div class="text-chrome-dense {stacked ? 'pt-2' : 'pt-10'}">
  <div class="mb-4 flex items-center gap-2">
    <h2 class="text-xs font-medium text-muted-foreground uppercase">
      {stacked ? "Newest last" : "Activity"}
    </h2>
    <span class="flex-1"></span>
    <!-- The pull request feed's focus control (pr-review/ActivityFeed.svelte):
         the list pages' filter chip and radio menu, tinted while it narrows
         the feed. -->
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="{FILTER_CHIP} {filter !== 'all'
              ? FILTER_CHIP_ON
              : `${FILTER_CHIP_OFF} hover:bg-[var(--wash-2)] hover:text-foreground`}"
            aria-label="Filter activity: {filterLabel}"
          >
            <span>{filterLabel}</span>
            <CaretDownIcon size={12} class="shrink-0 opacity-70" aria-hidden="true" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-44">
        <DropdownMenu.RadioGroup value={filter} onValueChange={selectFilter}>
          {#each filterOptions as option (option.value)}
            <DropdownMenu.RadioItem value={option.value}>
              {option.label}
            </DropdownMenu.RadioItem>
          {/each}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  <ol class="relative flex flex-col gap-5" role="list">
    <span class="absolute top-2 bottom-2 left-[11px] w-px bg-border" aria-hidden="true"></span>

    {#each visibleEntries as entry, index (entry.key)}
      {#if timelineWindow.hiddenCount > 0 && index === timelineWindow.before.length}
        <li class="relative flex gap-2">
          <span class="size-[22px] shrink-0" aria-hidden="true"></span>
          <button
            type="button"
            class="cursor-pointer rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onclick={() => (revealedCount += revealPage)}
          >
            Show {Math.min(revealPage, timelineWindow.hiddenCount)} of {timelineWindow.hiddenCount} hidden events
          </button>
        </li>
      {/if}
      {#if entry.type === "activity"}
        {@const glyph = activityLine(entry.activity, currentUserId).glyph}
        {@const artifact = linkedArtifactForActivity(entry.activity, links)}
        <li class="relative flex gap-2">
          <span
            class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_6%,var(--background))] text-muted-foreground"
            aria-hidden="true"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              stroke-width="0.875"
              stroke-linecap="round"
              stroke-linejoin="round"><path d={glyph} /></svg
            >
          </span>
          <div class="min-w-0 flex-1 pt-1">
            <p class="text-muted-foreground">
              <ActivityRow activity={entry.activity} self={currentUserId} />
              <span>· {relativeTime(entry.at)}</span>
            </p>
            {#if artifact}
              <!-- The render the link brought, collapsed where it arrived. -->
              <div class="mt-2">
                <ArtifactActivityCard
                  workId={artifact.targetKey}
                  title={artifact.liveTitle || artifact.title}
                  open={openArtifactWorkId === artifact.targetKey}
                  {enabled}
                  onToggle={() => toggleArtifact(artifact.targetKey)}
                />
              </div>
            {/if}
          </div>
        </li>
      {:else}
        {@const comment = entry.comment}
        {@const agent = isAgent(comment)}
        {@const user = commentUser(comment)}
        {@const originSessionId = commentSessionLink(comment, sessions)?.sessionId ?? comment.originSessionId}
        {@const originSessionName = commentSessionName(comment, sessions)}
        {@const delivery = commentDelivery(comment)}
        <!-- A comment leaves the spine, as on the pull request timeline: a
             full-width card with the author's mark in its tinted header, and
             the rail broken half a gap above and below it. -->
        <li class="relative -my-2.5 bg-background py-2.5">
          <article
            class="overflow-hidden rounded-lg border bg-background {delivery.state === 'unsent'
              ? 'border-[color-mix(in_oklch,var(--failure)_45%,var(--border))]'
              : 'border-border/60'}"
          >
            <div class="flex min-h-9 items-center gap-2 bg-muted/25 py-1 pr-2 pl-3 text-xs">
              <span class="flex min-w-0 flex-1 items-center gap-1.5">
                {#if user}
                  <UserAvatar {user} size={16} />
                {:else}
                <span
                  class="grid size-4 shrink-0 place-items-center rounded-full text-[8px] font-medium"
                  style={agent
                    ? "background:color-mix(in oklch, var(--primary) 15%, var(--background));color:color-mix(in oklch, var(--primary) 78%, var(--foreground))"
                    : "background:color-mix(in oklch, var(--chart-1) 22%, var(--background));color:color-mix(in oklch, var(--chart-1) 72%, var(--foreground))"}
                >
                  {#if agent}
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 32 32"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      aria-hidden="true"
                    >
                      <circle cx="16" cy="16" r="6.4" fill="currentColor" stroke="none" />
                      <path d="M16 5A11 11 0 0127 16" opacity=".55" />
                      <path d="M25.24 23.48A11 11 0 0112.48 26.56" opacity=".55" />
                      <path d="M6.76 23.48A11 11 0 015 12.48" opacity=".55" />
                    </svg>
                  {:else}
                    {authorInitials(comment.externalAuthor)}
                  {/if}
                </span>
                {/if}
                <span class="truncate font-medium text-foreground">{commentAuthorName(comment, currentUserId)}</span>
                <span class="shrink-0 text-muted-foreground">{relativeTime(comment.createdAt)}</span>
              </span>
              {#if delivery.state === "unsent"}
                <span
                  class="flex shrink-0 items-center gap-1 font-medium text-[color-mix(in_oklch,var(--failure)_72%,var(--foreground))]"
                >
                  <CircleAlertIcon size={12} aria-hidden="true" />
                  Not sent
                </span>
              {/if}
              {#if originSessionId && originSessionName}
                <button
                  type="button"
                  class="flex h-5 min-w-0 self-center cursor-pointer items-center gap-0.5 overflow-hidden rounded-md px-1.5 text-[11px] leading-none font-medium transition-[background-color,transform] duration-150 hover:bg-[color-mix(in_oklch,var(--primary)_20%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.96]"
                  style="background:color-mix(in oklch, var(--primary) 13%, transparent);color:color-mix(in oklch, var(--primary) 82%, var(--foreground))"
                  title="Open session: {originSessionName}"
                  aria-label="Open source session {originSessionName}"
                  onclick={() => onOpenSession(originSessionId)}
                >
                  <TerminalWindowIcon size={10} class="shrink-0" aria-hidden="true" />
                  <span class="max-w-48 truncate">{originSessionName}</span>
                </button>
              {/if}
            </div>
            <div class="p-3">
              <CommentMarkdown source={comment.body} policy="local" />
            </div>
            {#if delivery.state === "unsent"}
              {@const busy = busyCommentIds.has(comment.id)}
              <!-- The comment is on this host only. The row says why the
                   provider did not take it, and gives the two ways out. -->
              <div
                class="flex flex-wrap items-center gap-2 border-t border-border/60 bg-[color-mix(in_oklch,var(--failure)_7%,var(--background))] py-1.5 pr-2 pl-3 text-xs"
                role="alert"
              >
                <span class="min-w-0 flex-1 text-[color-mix(in_oklch,var(--failure)_72%,var(--foreground))]">
                  {providerName} did not take this comment. {delivery.error}
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onclick={() => void settle(comment.id, onRetry)}
                >
                  {busy ? "Sending…" : "Retry"}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onclick={() => void settle(comment.id, onDiscard)}
                >
                  Discard
                </Button>
              </div>
            {/if}
          </article>
        </li>
      {/if}
    {:else}
      <li class="relative flex gap-2">
        <span class="size-[22px] shrink-0" aria-hidden="true"></span>
        <p class="min-w-0 flex-1 pt-1 text-muted-foreground">
          {filter === "comments" ? "No comments yet." : "No activity yet."}
        </p>
      </li>
    {/each}
  </ol>
</div>
