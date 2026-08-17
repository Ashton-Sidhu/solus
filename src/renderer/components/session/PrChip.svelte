<script lang="ts">
  import { GitMergeIcon, GitPullRequestIcon } from "phosphor-svelte";
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
        return {
          color: "color-mix(in oklch, var(--review) 58%, var(--foreground))",
          background: "color-mix(in oklch, var(--review) 14%, transparent)",
        };
      case "merged":
        return {
          color: "var(--review)",
          background: "color-mix(in oklch, var(--review) 12%, transparent)",
        };
      case "open":
        return {
          color: "var(--success)",
          background: "color-mix(in oklch, var(--success) 12%, transparent)",
        };
      default:
        return { color: "var(--muted-foreground)", background: "transparent" };
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
  class="relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] rounded bg-(--pr-bg) px-1 py-0.5 text-(--pr-color) transition-[color,background-color,box-shadow,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-[''] hover:bg-[color-mix(in_oklch,var(--pr-color)_18%,transparent)] hover:text-foreground hover:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--pr-color)_22%,transparent)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
  style:--pr-color={tone.color}
  style:--pr-bg={tone.background}
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
    <GitMergeIcon size={12.5} class="shrink-0" />
  {:else}
    <GitPullRequestIcon
      size={12.5}
      weight={chip.state === "draft" ? "light" : "regular"}
      class="shrink-0 {chip.state === 'draft' ? 'opacity-70' : ''}"
    />
  {/if}
  <span class="font-mono text-xs tabular-nums"
    >#{chip.number}</span
  >
</button>
