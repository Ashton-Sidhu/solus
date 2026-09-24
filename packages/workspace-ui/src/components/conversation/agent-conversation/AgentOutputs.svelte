<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { GitPullRequest as PullRequestIcon, FileDiff as FileDiffIcon, MessagesSquare as SessionIcon } from "@lucide/svelte";
  import { planKey } from "@solus/contracts/types";
  import { sessionOutputKey } from "@solus/contracts/session-exchange";
  import PlanMessageItem from "../../plan/PlanMessageItem.svelte";
  import type { CardOutput } from "./lib/agent-conversation";

  /**
   * What the other session produced for this conversation, one row each: its
   * plans and works with the same cards they have anywhere else, the files it
   * changed, the pull request for its branch, and the sessions it started.
   * Each row names the thing; its content loads only when it is opened.
   */
  interface Props {
    outputs: CardOutput[];
    /** Opens the other session, where its changes can be read in full. */
    onOpenSession?: () => void;
    /** Opens a session the other session started. */
    onOpenStartedSession?: (sessionId: string) => void;
  }
  let { outputs, onOpenSession, onOpenStartedSession }: Props = $props();

  let filesOpen = $state(false);
</script>

<div class="flex flex-col gap-2 pt-2" data-testid="agent-outputs">
  {#each outputs as output (sessionOutputKey(output))}
    {#if output.kind === "plan"}
      <PlanMessageItem
        ref={{ kind: "plan", id: planKey(output.sessionId, output.planToolUseId), title: output.title }}
        skipMotion
      />
    {:else if output.kind === "work"}
      <PlanMessageItem
        ref={{ kind: "document", id: output.workId, title: output.title, workType: output.workType }}
        skipMotion
      />
    {:else if output.kind === "pull_request"}
      <button
        type="button"
        class="flex items-center gap-2 min-w-0 overflow-hidden rounded-md px-2 py-1 text-left text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
        onclick={() => void localApi.openExternal(output.url)}
      >
        <PullRequestIcon size={13} class="shrink-0" />
        <span class="shrink-0 font-medium text-foreground">Pull request #{output.number}</span>
        <span class="min-w-0 truncate">{output.url}</span>
      </button>
    {:else if output.kind === "session"}
      <button
        type="button"
        class="flex items-center gap-2 min-w-0 overflow-hidden rounded-md px-2 py-1 text-left text-muted-foreground enabled:cursor-pointer enabled:hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] enabled:hover:text-foreground"
        disabled={!onOpenStartedSession}
        onclick={() => onOpenStartedSession?.(output.sessionId)}
        data-testid="agent-output-session"
      >
        <SessionIcon size={13} class="shrink-0" />
        <span class="shrink-0 font-medium text-foreground">Started a session</span>
        <span class="min-w-0 truncate">{output.title}</span>
      </button>
    {:else}
      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="flex items-center gap-2 min-w-0 overflow-hidden rounded-md px-2 py-1 text-left text-muted-foreground enabled:cursor-pointer enabled:hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] enabled:hover:text-foreground"
            aria-expanded={output.paths?.length ? filesOpen : undefined}
            disabled={!output.paths?.length}
            onclick={() => (filesOpen = !filesOpen)}
          >
            <FileDiffIcon size={13} class="shrink-0" />
            <span class="truncate font-medium text-foreground">
              {output.count} {output.count === 1 ? "file" : "files"} changed{output.branch ? ` on ${output.branch}` : ""}
            </span>
          </button>
          <span class="flex-1"></span>
          {#if onOpenSession}
            <button
              type="button"
              class="shrink-0 rounded-md px-2 py-0.5 text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
              onclick={onOpenSession}
            >
              Open session
            </button>
          {/if}
        </div>
        {#if filesOpen && output.paths?.length}
          <ul class="flex flex-col pl-7 font-mono text-muted-foreground">
            {#each output.paths as path (path)}
              <li class="truncate">{path}</li>
            {/each}
            {#if output.count > output.paths.length}
              <li class="truncate">+{output.count - output.paths.length} more</li>
            {/if}
          </ul>
        {/if}
      </div>
    {/if}
  {/each}
</div>
