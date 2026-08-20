<script lang="ts">
  import {
    ArrowUpRight as OpenPageIcon,
    ArrowRight as ArrowRightIcon,
    Minimize2 as ArrowsInSimpleIcon,
    Maximize2 as ArrowsOutSimpleIcon,
    ChevronLeft as CaretLeftIcon,
    ChevronRight as CaretRightIcon,
    GitPullRequest as GitPullRequestIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import PaneSwapButton from "../ui/PaneSwapButton.svelte";

  /**
   * The chrome band of the review panel that slides out beside the list.
   *
   * There is no breadcrumb here: the list it came out of is still on screen to
   * the left, so the way back is the panel's own close control. What the band
   * carries instead is identity (the number and the merge direction), which view
   * of the change is showing, and the queue — where this pull request sits in
   * the list order, and the two keys that walk it. The state belongs with the
   * facts it qualifies, so it is stated in the PR's subtitle instead.
   *
   * The view tabs ride in this band rather than above the content the way the
   * page-shaped review has them: the panel is narrow and its three views have
   * different amounts of chrome of their own, so a row that only exists in some
   * of them reads as an empty band in the others.
   */
  let {
    number,
    headRef,
    baseRef,
    position,
    total,
    fullScreen,
    onStep,
    onToggleFullScreen,
    onOpenPage,
    onMoveAcross,
    isLeading = true,
    onClose,
    tabs,
    actions,
  }: {
    number: number;
    headRef?: string;
    baseRef?: string;
    /** 1-based place in the list order; 0 when this PR is not in the list. */
    position: number;
    total: number;
    fullScreen: boolean;
    onStep: (delta: number) => void;
    /** Absent when the surface is too narrow to hold a split at all — there is
     *  no smaller state to go back to, so the control is not offered. */
    onToggleFullScreen?: () => void;
    /** Replace the list's embedded detail panel with the standalone review route. */
    onOpenPage?: () => void;
    /** Move the review between the leading pane and the companion beside it.
     *  Absent when this band belongs to the list's own detail panel, which has
     *  no pane of its own. */
    onMoveAcross?: () => void;
    /** Which way `onMoveAcross` sends it. */
    isLeading?: boolean;
    onClose: () => void;
    /** Which view of the change is showing. Centred, so it stays in one place
     *  while the identity on its left grows and shrinks with the branch name. */
    tabs?: Snippet;
    /** Surface-owned controls (checks, chat) between the views and the queue. */
    actions?: Snippet;
  } = $props();

  // A queue of one, or a pull request the list is not showing (opened, then
  // filtered out) has nowhere to step to: `onStep` walks the published list
  // order and returns early when this number is not in it. Offer the control
  // only where it moves, rather than leaving two arrows and a blank count.
  const canStepQueue = $derived(position > 0 && total > 1);

  const roundButton =
    "no-drag pointer-events-auto flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";
</script>

<!-- Beside the list this row starts at the panel's own edge. Covering the list
     it starts at the window's, where the macOS window controls are — so the
     lead inset applies there and only there. -->
<div
  class="workspace-titlebar flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center gap-2 border-b border-[var(--hairline)] pr-2.5"
  style={fullScreen
    ? "padding-left: max(0.875rem, var(--solus-chrome-lead-inset, 0px))"
    : "padding-left: 0.875rem"}
>
  <span class="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
    <GitPullRequestIcon size={11} aria-hidden="true" />
    <span>#{number}</span>
  </span>

  {#if headRef && baseRef}
    <!-- head → base, reading in merge direction. -->
    <span
      class="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground opacity-70"
    >
      <span class="truncate">{headRef}</span>
      <CopyButton text={headRef} title="Copy branch name" iconOnly />
      <ArrowRightIcon size={10} class="shrink-0 opacity-50" aria-hidden="true" />
      <span class="shrink-0">{baseRef}</span>
    </span>
  {/if}

  <span class="flex-1"></span>

  {#if tabs}{@render tabs()}{/if}

  <span class="flex-1"></span>

  {#if actions}{@render actions()}{/if}

  <!-- Position, not history: how far through the queue this review is. -->
  {#if canStepQueue}
    <div class="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        class={roundButton}
        title="Previous pull request (K)"
        aria-label="Previous pull request"
        onclick={() => onStep(-1)}
      >
        <CaretLeftIcon size={11} />
      </button>
      <span
        class="min-w-[44px] text-center text-xs tabular-nums text-muted-foreground opacity-75"
      >
        {position} of {total}
      </span>
      <button
        type="button"
        class={roundButton}
        title="Next pull request (J)"
        aria-label="Next pull request"
        onclick={() => onStep(1)}
      >
        <CaretRightIcon size={11} />
      </button>
    </div>
  {/if}

  <!-- Seam between the surface's own actions and the pane controls. -->
  <span
    class="mx-1 h-[18px] w-px shrink-0 bg-[var(--hairline-strong)]"
    aria-hidden="true"
  ></span>

  {#if onMoveAcross}
    <PaneSwapButton
      {isLeading}
      onMove={onMoveAcross}
      iconSize={13}
      class={roundButton}
    />
  {/if}

  {#if onOpenPage}
    <button
      type="button"
      class={roundButton}
      title="Open pull request page"
      aria-label="Open pull request page"
      onclick={onOpenPage}
    >
      <OpenPageIcon size={13} />
    </button>
  {/if}

  {#if onToggleFullScreen}
    <button
      type="button"
      class="{roundButton} {fullScreen
        ? 'bg-[var(--wash-2)] text-foreground'
        : ''}"
      title={fullScreen ? "Back to split (E)" : "Expand to full screen (E)"}
      aria-label={fullScreen ? "Back to split view" : "Expand to full screen"}
      aria-pressed={fullScreen}
      onclick={onToggleFullScreen}
    >
      {#if fullScreen}
        <ArrowsInSimpleIcon size={13} />
      {:else}
        <ArrowsOutSimpleIcon size={13} />
      {/if}
    </button>
  {/if}

  <button
    type="button"
    class={roundButton}
    title="Close (Esc)"
    aria-label="Close pull request"
    onclick={onClose}
  >
    <XIcon size={13} />
  </button>
</div>
