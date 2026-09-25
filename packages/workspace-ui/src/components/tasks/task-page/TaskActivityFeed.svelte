<script lang="ts">
  import CommentMarkdown from '../../github-markdown/CommentMarkdown.svelte';
  import { SvelteSet } from "svelte/reactivity";
  import {
    ArrowUp as ArrowUpIcon,
    Check as CheckIcon,
    ChevronDown as CaretDownIcon,
    LoaderCircle as CircleNotchIcon,
    SquareTerminal as TerminalWindowIcon,
    Trash2 as TrashIcon,
    UserRound as UserIcon,
  } from "@lucide/svelte";
  import type {
    TaskComment,
    TaskEvent,
    TaskLink,
    TaskSessionLink,
  } from "@solus/contracts/task-types";
  import ArtifactActivityCard from "../../artifact/ArtifactActivityCard.svelte";
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
    commentSessionName,
    eventLine,
    linkedArtifactForEvent,
  } from "./lib/task-page";
  import { commentSyncState } from "./lib/task-upstream";

  interface Props {
    comments: TaskComment[];
    events: TaskEvent[];
    /** The task's current links, so a `linked` event can show the artifact
     *  it brought, collapsed, at the point in the story where it arrived. */
    links?: TaskLink[];
    /** False while the feed is mounted but hidden, so an opened render holds
     *  no live frame nobody can see. */
    enabled?: boolean;
    sessions: TaskSessionLink[];
    onOpenSession: (sessionId: string) => void;
    /** The system a comment can be published to, when this task has one. Null
     *  leaves every entry with no publish affordance at all. */
    provider: string | null;
    /** Queue this comment for the ticket. Resolves once the host has taken it;
     *  the engine posts it on its next pass. */
    onPublish: (commentId: string) => Promise<void>;
    onDelete: (commentId: string) => Promise<void>;
    /** True where the section is a tab of its own. The strip above already says
     *  "Activity", so the band states the one thing it does not — which end of
     *  the feed is the newest. */
    stacked?: boolean;
  }

  let {
    comments,
    events,
    links = [],
    enabled = true,
    sessions,
    onOpenSession,
    provider,
    onPublish,
    onDelete,
    stacked = false,
  }: Props = $props();

  /** Comments the user has just pressed Publish on, so the row stops offering
   *  the action before the host's answer arrives. */
  let publishing = $state(new SvelteSet<string>());
  let deleting = $state(new SvelteSet<string>());

  async function publish(commentId: string) {
    if (publishing.has(commentId)) return;
    publishing.add(commentId);
    try {
      await onPublish(commentId);
    } finally {
      publishing.delete(commentId);
    }
  }

  async function deleteComment(commentId: string) {
    if (deleting.has(commentId)) return;
    deleting.add(commentId);
    try {
      await onDelete(commentId);
    } finally {
      deleting.delete(commentId);
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
    requestInputFocus();
  }

  /** One live frame at a time: the artifact card the reader has open. */
  let openArtifactWorkId = $state<string | null>(null);

  function toggleArtifact(workId: string) {
    openArtifactWorkId = openArtifactWorkId === workId ? null : workId;
  }

  const entries = $derived(activityFeed(comments, events));
  const shown = $derived(
    filter === "all" ? entries : entries.filter((e) => e.type === "comment"),
  );


  /** An agent's comment is authored by a session, not a person, so it takes the
   *  accent wash and the Solus mark instead of initials. */
  function isAgent(comment: TaskComment): boolean {
    return comment.author === "agent" || comment.author === "automation";
  }

  function isUser(comment: TaskComment): boolean {
    return comment.author === "You";
  }

  function authorName(comment: TaskComment): string {
    if (comment.author === "agent") return "Solus";
    if (comment.author === "automation") return "Automation";
    return comment.author?.trim() || "Unknown";
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

  <ol class="relative flex flex-col gap-5 [.is-laptop-display_&]:gap-4" role="list">
    <span class="absolute top-2 bottom-2 left-[11px] w-px bg-border" aria-hidden="true"></span>

    {#each shown as entry (entry.key)}
      {#if entry.type === "event"}
        {@const line = eventLine(entry.event)}
        {@const artifact = linkedArtifactForEvent(entry.event, links)}
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
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"><path d={line.icon} /></svg
            >
          </span>
          <div class="min-w-0 flex-1 pt-1">
            <p class="text-muted-foreground">
              {line.text}
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
        {@const user = isUser(comment)}
        {@const originSessionId = comment.originSessionId}
        {@const originSessionName = commentSessionName(comment, sessions)}
        <!-- A comment leaves the spine, as on the pull request timeline: a
             full-width card with the author's mark in its tinted header, and
             the rail broken half a gap above and below it. -->
        <li class="relative -my-2.5 bg-background py-2.5">
          <article
            class="group/comment overflow-hidden rounded-lg border border-border/60 bg-background"
          >
            <div class="flex min-h-9 items-center gap-2 bg-muted/25 py-1 pr-2 pl-3 text-xs">
              <span class="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  class="grid size-4 shrink-0 place-items-center rounded-full text-[8px] font-medium"
                  style={agent
                    ? "background:color-mix(in oklch, var(--primary) 15%, var(--background));color:color-mix(in oklch, var(--primary) 78%, var(--foreground))"
                    : "background:color-mix(in oklch, var(--chart-1) 22%, var(--background));color:color-mix(in oklch, var(--chart-1) 72%, var(--foreground))"}
                >
                  {#if user}
                    <UserIcon size={10} strokeWidth={2.2} aria-hidden="true" />
                  {:else if agent}
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 32 32"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.6"
                      stroke-linecap="round"
                      aria-hidden="true"
                    >
                      <circle cx="16" cy="16" r="6.4" fill="currentColor" stroke="none" />
                      <path d="M16 5A11 11 0 0127 16" opacity=".55" />
                      <path d="M25.24 23.48A11 11 0 0112.48 26.56" opacity=".55" />
                      <path d="M6.76 23.48A11 11 0 015 12.48" opacity=".55" />
                    </svg>
                  {:else}
                    {authorInitials(comment.author)}
                  {/if}
                </span>
                <span class="truncate font-medium text-foreground">{authorName(comment)}</span>
                <span class="shrink-0 text-muted-foreground">{relativeTime(comment.createdAt)}</span>
              </span>
              {#if provider}
                {@const sync = commentSyncState(comment, true)}
                <!-- Publishing is per comment: a note meant for the team here is
                     not automatically a note for the ticket's audience. -->
                {#if sync === "published"}
                  <span
                    class="flex items-center gap-1 text-muted-foreground opacity-65"
                    title="Published to {provider}"
                  >
                    <CheckIcon size={10} weight="bold" aria-hidden="true" />
                    {provider}
                  </span>
                {:else if sync === "queued" || publishing.has(comment.id)}
                  <span
                    class="flex items-center gap-1 text-muted-foreground opacity-65"
                    title="Queued for {provider} — it posts on the next sync"
                  >
                    <CircleNotchIcon
                      size={10}
                      class="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    Queued
                  </span>
                {:else if sync === "held"}
                  <button
                    type="button"
                    class="flex h-[22px] cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-primary hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
                    onclick={() => void publish(comment.id)}
                    title="Publish this comment to {provider}"
                  >
                    <ArrowUpIcon size={10} weight="bold" aria-hidden="true" />
                    Publish
                  </button>
                {/if}
              {/if}
              {#if originSessionId && originSessionName}
                <button
                  type="button"
                  class="flex h-5 shrink-0 self-center cursor-pointer items-center gap-0.5 rounded-md px-1.5 text-[11px] leading-none font-medium transition-[background-color,transform] duration-150 hover:bg-[color-mix(in_oklch,var(--primary)_20%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.96]"
                  style="background:color-mix(in oklch, var(--primary) 13%, transparent);color:color-mix(in oklch, var(--primary) 82%, var(--foreground))"
                  title="Open session {originSessionId}"
                  aria-label="Open source session {originSessionName}"
                  onclick={() => onOpenSession(originSessionId)}
                >
                  <TerminalWindowIcon size={10} aria-hidden="true" />
                  <span class="max-w-48 truncate">{originSessionName}</span>
                </button>
              {/if}
              {#if user && comment.source === "local" && !comment.externalId}
                <button
                  type="button"
                  class="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,color] hover:text-destructive focus-visible:opacity-100 group-hover/comment:opacity-100 pointer-coarse:opacity-100"
                  disabled={deleting.has(comment.id)}
                  aria-label="Delete comment"
                  title="Delete comment"
                  onclick={() => void deleteComment(comment.id)}
                >
                  {#if deleting.has(comment.id)}
                    <CircleNotchIcon size={12} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  {:else}
                    <TrashIcon size={12} aria-hidden="true" />
                  {/if}
                </button>
              {/if}
            </div>
            <div class="p-3">
              <CommentMarkdown source={comment.body} policy="local" />
            </div>
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
