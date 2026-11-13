<script lang="ts">
  import {
    Bot as AgentIcon,
    Check as DoneIcon,
    File as FilesIcon,
    FileText as WorksIcon,
    GitPullRequest as PullRequestIcon,
    X as FailedIcon,
  } from "@lucide/svelte";
  import ProviderMark from "../../ui/ProviderMark.svelte";
  import { formatCompactElapsed, type RailAgentRow } from "../../project-panel/lib/rail-agents";
  import type { AgentLinkCounts } from "./lib/overview-view";

  /**
   * One agent the session dispatched: a sub-agent, or a session it started.
   * The mark is its provider. Its standing is at the end of the row: the time
   * while it runs, a check when it is done, a cross when it failed. A started
   * session also shows what it linked, as counts.
   */
  interface Props {
    row: RailAgentRow;
    /** What a started session linked. Null for a sub-agent, which links nothing of its own. */
    links: AgentLinkCounts | null;
    onOpen: (split: boolean) => void;
  }
  let { row, links, onOpen }: Props = $props();

  const mark = $derived(row.provider === "codex" ? "codex" : row.provider === "claude-code" ? "claude" : null);
</script>

<button
  type="button"
  title={row.tooltip}
  aria-label="{row.title}, {row.status}"
  disabled={row.kind === "session" && row.pending}
  class="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border-0 bg-transparent px-2 text-left text-workspace-chrome text-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:h-11"
  data-testid="artifacts-agent-row"
  data-state={row.tone}
  onclick={(event) => onOpen(event.metaKey || event.ctrlKey)}
>
  <span class="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
    {#if mark}
      <ProviderMark {mark} size={mark === "codex" ? 10 : 14} transparent />
    {:else}
      <AgentIcon size={16} strokeWidth={1.75} class="text-muted-foreground" />
    {/if}
  </span>
  <span class="min-w-0 flex-1 truncate">{row.title}</span>
  {#if links}
    <span class="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-(--solus-text-secondary) @max-[23rem]/card:hidden">
      {#if links.pullRequests > 0}
        <span
          class="inline-flex h-[18px] items-center gap-1 rounded-md bg-[var(--wash-3)] px-1.5"
          title="{links.pullRequests} pull {links.pullRequests === 1 ? 'request' : 'requests'}"
        >
          <PullRequestIcon size={11} class="text-muted-foreground" />{links.pullRequests}
        </span>
      {/if}
      {#if links.works > 0}
        <span class="inline-flex h-[18px] items-center gap-1 rounded-md bg-[var(--wash-3)] px-1.5" title="{links.works} {links.works === 1 ? 'work' : 'works'}">
          <WorksIcon size={11} class="text-muted-foreground" />{links.works}
        </span>
      {/if}
      {#if links.files > 0}
        <span class="inline-flex h-[18px] items-center gap-1 rounded-md bg-[var(--wash-3)] px-1.5" title="{links.files} {links.files === 1 ? 'file' : 'files'}">
          <FilesIcon size={11} class="text-muted-foreground" />{links.files}
        </span>
      {/if}
    </span>
  {/if}
  <span class="flex min-w-4 shrink-0 items-center justify-end">
    {#if row.tone === "live"}
      <span class="text-xs tabular-nums text-(--solus-status-running)">{formatCompactElapsed(row.elapsedMs)}</span>
    {:else if row.tone === "done"}
      <DoneIcon size={14} class="text-(--solus-status-complete)" />
    {:else if row.tone === "failed"}
      <FailedIcon size={14} class="text-(--solus-status-error)" />
    {/if}
  </span>
</button>
