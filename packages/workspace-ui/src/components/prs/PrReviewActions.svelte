<script lang="ts">
  import { fly } from "svelte/transition";
  import {
    BookOpenText as BookOpenTextIcon,
    LoaderCircle as CircleNotchIcon,
    Play as PlayIcon,
  } from "@lucide/svelte";
  import { Button } from "../ui/button";

  /** What the checked rows can be sent to: a count, a way to clear the
   *  checks, background review guides, and Review Mode over just those rows. */
  interface Props {
    selectedCount: number;
    guideEligibleCount: number;
    guidesInFlight: number;
    onClear: () => void;
    onGenerateGuides: () => void;
    onReview: () => void;
  }
  let {
    selectedCount,
    guideEligibleCount,
    guidesInFlight,
    onClear,
    onGenerateGuides,
    onReview,
  }: Props = $props();
</script>

<div class="flex items-center gap-1.5" transition:fly={{ y: -4, duration: 160 }}>
  <span class="text-xs tabular-nums whitespace-nowrap text-muted-foreground">
    {selectedCount} selected
  </span>
  <Button
    type="button"
    class="inline-flex h-[26px] shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent px-2 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    onclick={onClear}
    aria-label={`Clear ${selectedCount} selected pull requests`}
  >
    Clear
  </Button>
  <Button
    type="button"
    class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-2.5 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    disabled={guideEligibleCount === 0}
    onclick={onGenerateGuides}
    aria-label={`Generate ${guideEligibleCount} review guides in the background`}
  >
    {#if guidesInFlight > 0}
      <CircleNotchIcon size={12} class="shrink-0 animate-spin [animation-duration:0.9s]" />
    {:else}
      <BookOpenTextIcon size={12} class="shrink-0" />
    {/if}
    <span>Guides</span>
  </Button>
  <Button
    type="button"
    onclick={onReview}
    class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-primary px-2.5 text-workspace-chrome font-medium text-primary-foreground transition-[filter] duration-100 hover:brightness-[1.07]"
  >
    <PlayIcon size={12} class="shrink-0" />
    <span>Review</span>
  </Button>
</div>
