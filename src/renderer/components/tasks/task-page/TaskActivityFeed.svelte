<script lang="ts">
  import SvelteMarkdown, {
    type SanitizeUrlFn,
  } from "@humanspeak/svelte-markdown";
  import { SvelteSet } from "svelte/reactivity";
  import {
    ArrowUpIcon,
    CheckIcon,
    CircleNotchIcon,
    TerminalWindowIcon,
  } from "phosphor-svelte";
  import type {
    TaskComment,
    TaskEvent,
    TaskSessionLink,
  } from "../../../../shared/task-types";
  import { githubMarkdownExtensions } from "../../../lib/githubMarkdown";
  import { markdownSanitizeUrl } from "../../../lib/markdownSanitize";
  import MarkdownImage from "../../conversation/MarkdownImage.svelte";
  import { githubMarkdownRenderers } from "../../ui/markdown-renderers";
  import { authorInitials, relativeTime } from "../lib/tasks-api";
  import { isInlineTaskImageUrl } from "./lib/task-image";
  import {
    activityFeed,
    commentSessionName,
    eventLine,
  } from "./lib/task-page";
  import { commentSyncState } from "./lib/task-upstream";

  interface Props {
    comments: TaskComment[];
    events: TaskEvent[];
    sessions: TaskSessionLink[];
    onOpenSession: (sessionId: string) => void;
    /** The system a comment can be published to, when this task has one. Null
     *  leaves every entry with no publish affordance at all. */
    provider: string | null;
    /** Queue this comment for the ticket. Resolves once the host has taken it;
     *  the engine posts it on its next pass. */
    onPublish: (commentId: string) => Promise<void>;
  }

  let {
    comments,
    events,
    sessions,
    onOpenSession,
    provider,
    onPublish,
  }: Props = $props();

  /** Comments the user has just pressed Publish on, so the row stops offering
   *  the action before the host's answer arrives. */
  let publishing = $state(new SvelteSet<string>());

  async function publish(commentId: string) {
    if (publishing.has(commentId)) return;
    publishing.add(commentId);
    try {
      await onPublish(commentId);
    } finally {
      publishing.delete(commentId);
    }
  }

  const taskMarkdownRenderers = {
    ...githubMarkdownRenderers,
    image: MarkdownImage,
  };
  // The task editor embeds pasted screenshots as data URLs. Keep that exception
  // image-only and raster-only; links, SVG, and arbitrary payloads still use
  // the shared protocol allowlist.
  const taskMarkdownSanitizeUrl: SanitizeUrlFn = (url, context) => {
    if (context.type === "image" && isInlineTaskImageUrl(url)) return url;
    return markdownSanitizeUrl(url, context);
  };

  let filter = $state<"all" | "comments">("all");

  const entries = $derived(activityFeed(comments, events));
  const shown = $derived(
    filter === "all" ? entries : entries.filter((e) => e.type === "comment"),
  );

  const SEGMENT =
    "h-[22px] cursor-pointer rounded-full px-2.5 text-xs transition-colors duration-150";
  const SEGMENT_ON =
    "bg-card text-foreground font-medium shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]";
  const SEGMENT_OFF = "text-muted-foreground";

  /** An agent's comment is authored by a session, not a person, so it takes the
   *  accent wash and the Solus mark instead of initials. */
  function isAgent(comment: TaskComment): boolean {
    return comment.author === "agent" || comment.author === "automation";
  }

  function authorName(comment: TaskComment): string {
    if (comment.author === "agent") return "Solus";
    if (comment.author === "automation") return "Automation";
    return comment.author?.trim() || "Unknown";
  }
</script>

<div class="text-xs text-xs pt-7">
  <div class="flex items-center gap-2.5 pb-1">
    <span
      class="font-normal text-muted-foreground uppercase"
    >
      Activity
    </span>
    <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
    <span
      class="flex items-center gap-0.5 rounded-full bg-[var(--wash-2)] p-0.5 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
    >
      <button
        type="button"
        class="{SEGMENT} {filter === 'all' ? SEGMENT_ON : SEGMENT_OFF}"
        onclick={() => (filter = "all")}
      >
        All
      </button>
      <button
        type="button"
        class="{SEGMENT} {filter === 'comments' ? SEGMENT_ON : SEGMENT_OFF}"
        onclick={() => (filter = "comments")}
      >
        Comments
      </button>
    </span>
  </div>

  <div class="relative pt-1.5">
    <div
      class="absolute top-4 bottom-3.5 left-3 w-px bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]"
      aria-hidden="true"
    ></div>

    {#each shown as entry (entry.key)}
      {#if entry.type === "event"}
        {@const line = eventLine(entry.event)}
        <div class="relative flex gap-3 py-[5px]">
          <span
            class="flex size-[25px] shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground"
          >
            <span
              class="flex size-[19px] items-center justify-center rounded-full bg-[var(--wash-2)] shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="opacity-75"
                aria-hidden="true"><path d={line.icon} /></svg
              >
            </span>
          </span>
          <span
            class="flex min-h-[25px] min-w-0 flex-1 flex-wrap items-center gap-2"
          >
            <span class="leading-[1.55] text-muted-foreground"
              >{line.text}</span
            >
            <span
              class="text-muted-foreground opacity-60"
            >
              {relativeTime(entry.at)}
            </span>
          </span>
        </div>
      {:else}
        {@const comment = entry.comment}
        {@const agent = isAgent(comment)}
        {@const originSessionId = comment.originSessionId}
        {@const originSessionName = commentSessionName(comment, sessions)}
        <div class="relative flex gap-3 py-3">
          <span
            class="flex size-[25px] shrink-0 items-center justify-center rounded-full font-medium shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
            style={agent
              ? "background:color-mix(in oklch, var(--primary) 15%, transparent);color:color-mix(in oklch, var(--primary) 78%, var(--foreground))"
              : "background:color-mix(in oklch, var(--chart-1) 22%, transparent);color:color-mix(in oklch, var(--chart-1) 72%, var(--foreground))"}
          >
            {#if agent}
              <svg
                width="14"
                height="14"
                viewBox="0 0 32 32"
                fill="none"
                stroke="currentColor"
                stroke-width="2.6"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <circle
                  cx="16"
                  cy="16"
                  r="6.4"
                  fill="currentColor"
                  stroke="none"
                />
                <path d="M16 5A11 11 0 0127 16" opacity=".55" />
                <path d="M25.24 23.48A11 11 0 0112.48 26.56" opacity=".55" />
                <path d="M6.76 23.48A11 11 0 015 12.48" opacity=".55" />
              </svg>
            {:else}
              {authorInitials(comment.author)}
            {/if}
          </span>
          <span class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span class="flex min-h-[25px] flex-wrap items-center gap-2">
              <span class="text-sm font-medium ">
                {authorName(comment)}
              </span>
              <span
                class="text-muted-foreground opacity-60"
              >
                {relativeTime(comment.createdAt)}
              </span>
              <span class="flex-1"></span>
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
            </span>
            <div class="github-markdown prose-cloud prose-pr w-full">
              <SvelteMarkdown
                source={comment.body}
                extensions={githubMarkdownExtensions}
                renderers={taskMarkdownRenderers}
                sanitizeUrl={taskMarkdownSanitizeUrl}
              />
            </div>
          </span>
        </div>
      {/if}
    {:else}
      <div class="py-3 pl-9 text-muted-foreground">
        {filter === "comments" ? "No comments yet." : "No activity yet."}
      </div>
    {/each}
  </div>
</div>
