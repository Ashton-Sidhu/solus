<script lang="ts">
  import { RefreshCw as ArrowsClockwiseIcon } from "@lucide/svelte";
  import type { ReviewView } from "../../contexts/workspace/routing/route-registry";

  /**
   * Which face of the change you are reading: Map · Guide · Diff.
   *
   * Deliberately the same row, in the same order, as the pull-request review
   * pane's — reading a local branch and reading a PR are the same job, and the
   * control that switches between views should not be a different shape
   * depending on where the change came from.
   *
   * The Guide tab carries its own state, because generating a guide has no
   * other home now that the guide is a view rather than a destination: a
   * spinner while one is being produced. Ready and absent guides stay quiet;
   * the guide content itself makes the state clear when opened.
   */
  let {
    view,
    guideState,
    onSelect,
  }: {
    view: ReviewView;
    /** `absent` offers generation, `generating` reports it, `unread` marks a
     *  guide that became ready on another tab, `ready` is the quiet state. */
    guideState: "absent" | "generating" | "unread" | "ready";
    onSelect: (view: ReviewView) => void;
  } = $props();

  const TABS: { id: ReviewView; label: string }[] = [
    { id: "map", label: "Map" },
    { id: "guide", label: "Guide" },
    { id: "diff", label: "Diff" },
  ];

  const guideHint = $derived(
    guideState === "absent"
      ? "No guide yet — generate one"
      : guideState === "generating"
        ? "Generating the review guide…"
        : guideState === "unread"
          ? "A new guide is ready"
          : undefined,
  );
</script>

<!-- No track behind the group and no rule under it: the active tab's own wash is
     the whole cue. A track would draw a second object into a band whose point is
     that it holds still. -->
<div
  class="no-drag flex shrink-0 items-center gap-0.5"
  role="tablist"
  aria-label="Review views"
>
  {#each TABS as tab (tab.id)}
    {@const isActive = view === tab.id}
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      title={tab.id === "guide" ? guideHint : undefined}
      class="relative flex h-7 cursor-pointer items-center gap-1 rounded-lg px-2 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 @min-[34rem]/band:px-2.5 @min-[53.75rem]/band:px-3 pointer-fine:[.is-laptop-display_&]:h-6.5 {isActive
        ? 'bg-[var(--wash-2)] font-medium text-foreground'
        : 'bg-transparent font-normal text-muted-foreground hover:text-foreground'}"
      onclick={() => onSelect(tab.id)}
    >
      {tab.label}
      {#if tab.id === "guide"}
        {#if guideState === "generating"}
          <ArrowsClockwiseIcon
            size={11}
            class="shrink-0 animate-spin [animation-duration:1.2s] motion-reduce:animate-none"
          />
        {/if}
      {/if}
    </button>
  {/each}
</div>
