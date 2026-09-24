<script lang="ts">
  import GithubMarkdown from '../../github-markdown/GithubMarkdown.svelte';
  import { SvelteSet } from "svelte/reactivity";
  import {
    ArrowUp as ArrowUpIcon,
    Check as CheckIcon,
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

  let filter = $state<"all" | "comments">("all");

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
     muted line, and each comment a bordered card whose author row is its
     header. A task and a pull request are read side by side, so their
     histories read the same way. -->
<div class="text-chrome-dense {stacked ? 'pt-2' : 'pt-10'}">
  <div class="mb-4 flex items-center gap-2">
    <h2 class="text-xs font-medium text-muted-foreground uppercase">
      {stacked ? "Newest last" : "Activity"}
    </h2>
    <span class="flex-1"></span>
    <span
      class="flex items-center gap-0.5 rounded-full bg-[var(--wash-2)] p-0.5 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
    >
      <button
        type="button"
        class="h-[22px] cursor-pointer rounded-full px-2.5 text-xs transition-colors duration-150 {filter === 'all'
          ? 'bg-card text-foreground font-medium shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
          : 'text-muted-foreground'}"
        onclick={() => (filter = "all")}
      >
        All
      </button>
      <button
        type="button"
        class="h-[22px] cursor-pointer rounded-full px-2.5 text-xs transition-colors duration-150 {filter === 'comments'
          ? 'bg-card text-foreground font-medium shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
          : 'text-muted-foreground'}"
        onclick={() => (filter = "comments")}
      >
        Comments
      </button>
    </span>
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
        <li class="relative flex gap-2">
          <!-- Dropped so the node sits on the card header's centre line. -->
          <span class="flex shrink-0 self-start pt-[5px]">
            <span
              class="relative z-10 mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full text-xs font-medium shadow-[0_0_0_3px_var(--background)]"
              style={agent
                ? "background:color-mix(in oklch, var(--primary) 15%, var(--background));color:color-mix(in oklch, var(--primary) 78%, var(--foreground))"
                : "background:color-mix(in oklch, var(--chart-1) 22%, var(--background));color:color-mix(in oklch, var(--chart-1) 72%, var(--foreground))"}
            >
              {#if user}
                <UserIcon size={12} strokeWidth={2.2} aria-hidden="true" />
              {:else if agent}
                <svg
                  width="13"
                  height="13"
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
          </span>
          <div
            class="group/comment min-w-0 flex-1 overflow-hidden rounded-[14px] border border-[var(--hairline-strong)] bg-card"
          >
            <div class="flex min-h-9 items-center gap-2 py-1 pr-2 pl-4 shadow-[inset_0_-0.5px_0_var(--hairline-strong)]">
              <span class="min-w-0 flex-1">
                <span class="font-medium text-foreground">{authorName(comment)}</span>
                <span class="text-muted-foreground">· {relativeTime(comment.createdAt)}</span>
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
            <div class="px-4 py-3.5">
              <div class="github-markdown prose-cloud prose-pr prose-pr-activity">
                <GithubMarkdown source={comment.body} policy="local" />
              </div>
            </div>
          </div>
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
