<script lang="ts">
  import { CaretRightIcon, GitMergeIcon, GitPullRequestIcon } from "phosphor-svelte";
  import type { PrChip } from "./lib/task-list";

  interface Props {
    chip: PrChip;
    onOpen: () => void;
  }
  let { chip, onOpen }: Props = $props();

  // Each state carries its own tone so a PR reads at a glance: a review the
  // person owes leads in the brand accent, a merged PR settles into plum, and a
  // live open PR shows the on-brand sage. Draft alone stays neutral — an open
  // PR the agent has not committed to yet is not news.
  const tone = $derived.by(() => {
    switch (chip.state) {
      case "approvalRequested":
        return {
          color: "color-mix(in oklch, var(--primary) 58%, var(--foreground))",
          background: "color-mix(in oklch, var(--primary) 14%, transparent)",
        };
      case "merged":
        return {
          color: "var(--solus-art-6)",
          background: "color-mix(in oklch, var(--solus-art-6) 12%, transparent)",
        };
      case "open":
        return {
          color: "var(--solus-art-positive)",
          background: "color-mix(in oklch, var(--solus-art-positive) 12%, transparent)",
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
  class="group/pr relative flex shrink-0 cursor-pointer items-center gap-[0.21875rem] rounded bg-(--pr-bg) py-0.5 pr-[0.3125rem] pl-1 text-(--pr-color) transition-[color,background-color,box-shadow,scale] duration-150 before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-[''] hover:bg-[color-mix(in_oklch,var(--pr-color)_18%,transparent)] hover:text-foreground hover:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--pr-color)_22%,transparent)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
  <span class="font-mono text-[0.6875rem] tracking-[-0.01em] tabular-nums"
    >#{chip.number}</span
  >
  <CaretRightIcon
    size={9}
    weight="bold"
    class="-ml-px shrink-0 opacity-40 transition-[opacity,translate] duration-150 group-hover/pr:translate-x-px group-hover/pr:opacity-100 group-focus-visible/pr:opacity-100"
    aria-hidden="true"
  />
</button>
