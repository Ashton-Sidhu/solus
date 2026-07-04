<script lang="ts">
  import { GitBranchIcon, GitMergeIcon, GitPullRequestIcon } from "phosphor-svelte";
  import type { PullRequestSummary } from "../../../shared/providers";

  // Open / draft / merged / closed glyph for a PR row or header.
  let { pr }: { pr: PullRequestSummary } = $props();
</script>

{#if pr.state === "merged"}
  <GitMergeIcon size={14} weight="bold" class="shrink-0 text-(--solus-accent)" />
{:else if pr.state === "closed"}
  <GitPullRequestIcon size={14} weight="bold" class="shrink-0 text-(--solus-art-negative)" />
{:else if pr.draft}
  <GitBranchIcon size={14} weight="bold" class="shrink-0 text-(--solus-text-tertiary)" />
{:else}
  <GitPullRequestIcon size={14} weight="bold" class="shrink-0 text-(--solus-art-positive)" />
{/if}
