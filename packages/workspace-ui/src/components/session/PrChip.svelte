<script lang="ts">
  import { GitMerge as GitMergeIcon, GitPullRequest as GitPullRequestIcon } from "@lucide/svelte";
  import type { PrChip } from "./lib/task-list";

  interface Props {
    chip: PrChip;
    onOpen: () => void;
  }
  let { chip, onOpen }: Props = $props();

  // Match Git host conventions: open is green and merged is purple. Review
  // requests also use purple as an attention state; drafts stay neutral.
  const tone = $derived.by(() => {
    switch (chip.state) {
      case "approvalRequested":
        return "color-mix(in oklch, var(--review) 58%, var(--foreground))";
      case "merged":
        return "var(--review)";
      case "open":
        return "var(--success)";
      default:
        return "var(--muted-foreground)";
    }
  });

  const label = $derived(
    chip.state === "approvalRequested"
      ? `Pull request #${chip.number} — your review requested`
      : `Pull request #${chip.number} — ${chip.state}`,
  );
  const actionLabel = $derived(`${label}. Open in secondary pane.`);
</script>

<button
  type="button"
  class="relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] text-xs text-(--pr-color) transition-[color,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-[''] hover:text-foreground active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-fine:[.is-laptop-display_&]:gap-0.5"
  style:--pr-color={tone}
  aria-label={actionLabel}
  title={actionLabel}
  onclick={(event) => {
    event.stopPropagation();
    onOpen();
  }}
>
  <!-- The same two marks the Pull Requests page uses, so a PR reads identically
       wherever it surfaces: the line comes back into the trunk once it has
       landed. Draft is the same mark drawn lighter — an open PR the agent has
       not committed to yet. -->
  {#if chip.state === "merged"}
    <GitMergeIcon size={12.5} class="shrink-0 pointer-fine:[.is-laptop-display_&]:size-3" />
  {:else}
    <GitPullRequestIcon
      size={12.5}
      weight={chip.state === "draft" ? "light" : "regular"}
      class="shrink-0 pointer-fine:[.is-laptop-display_&]:size-3 {chip.state === 'draft' ? 'opacity-70' : ''}"
    />
  {/if}
  <span class="tabular-nums"
    >#{chip.number}</span
  >
</button>
