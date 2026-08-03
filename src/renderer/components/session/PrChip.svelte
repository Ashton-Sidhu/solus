<script lang="ts">
  import { GitMergeIcon, GitPullRequestIcon } from "phosphor-svelte";
  import type { PrChip } from "./lib/task-list";

  interface Props {
    chip: PrChip;
  }
  let { chip }: Props = $props();

  // The fill only changes once a human verdict exists — an unreviewed PR is not
  // news, so open and draft stay neutral and unfilled.
  const tone = $derived.by(() => {
    switch (chip.state) {
      case "approvalRequested":
        return {
          color: "color-mix(in oklch, var(--primary) 58%, var(--foreground))",
          background: "color-mix(in oklch, var(--primary) 14%, transparent)",
        };
      case "merged":
        return {
          color: "var(--muted-foreground)",
          background: "color-mix(in oklch, var(--foreground) 6%, transparent)",
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
</script>

<span
  class="flex shrink-0 items-center gap-[0.21875rem] rounded py-0.5 pr-[0.3125rem] pl-1"
  style:color={tone.color}
  style:background={tone.background}
  aria-label={label}
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
  <span class="font-mono text-[0.6875rem] tracking-[-0.01em] tabular-nums"
    >#{chip.number}</span
  >
</span>
