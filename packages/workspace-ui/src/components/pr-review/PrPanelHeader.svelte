<script lang="ts">
  import {
    Minimize2 as ArrowsInSimpleIcon,
    Maximize2 as ArrowsOutSimpleIcon,
    ChevronLeft as CaretLeftIcon,
    ChevronRight as CaretRightIcon,
    GitPullRequest as GitPullRequestIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import type { GuideHeaderActions } from "../diff/lib/review-header";
  import PaneSwapButton from "../ui/PaneSwapButton.svelte";
  import PrPanelOverflowMenu from "./PrPanelOverflowMenu.svelte";

  /**
   * The chrome band of the review panel that slides out beside the list — the
   * same band as the local review's, so reading a pull request and reading a
   * branch are the same object in the same places.
   *
   * Slots, left to right and fixed at every width: the tab group, flexible
   * space, the pull request's number, its primary action, the queue scrubber,
   * the overflow, then the pane controls. Nothing appears or disappears as the
   * tab changes — only the overflow's contents follow it.
   *
   * The band states which pull request you are in, not what is true of it. The
   * refs and the check state are facts about the change, so they are read on
   * Activity — beside the title and in its rail — rather than repeated in
   * chrome that every tab has to carry.
   *
   * There is no breadcrumb here: the list it came out of is still on screen to
   * the left, so the way back is the panel's own close control.
   *
   * Two rules were retired with the migration — the seam under the band and the
   * divider before the pane controls. Space separates, lines do not.
   */
  let {
    number,
    tab,
    position,
    total,
    fullScreen,
    onStep,
    onToggleFullScreen,
    onOpenPage,
    onMoveAcross,
    isLeading = true,
    onClose,
    onRefresh,
    refreshing = false,
    guide,
    headRef,
    tabs,
    actions,
  }: {
    number: number;
    /** Which view is showing. The overflow's contents follow it; the band's
     *  slots do not. */
    tab: "activity" | "map" | "guide" | "diff";
    /** 1-based place in the list order; 0 when this PR is not in the list. */
    position: number;
    total: number;
    fullScreen: boolean;
    onStep: (delta: number) => void;
    /** Absent when the surface is too narrow to hold a split at all — there is
     *  no smaller state to go back to, so the control is not offered. */
    onToggleFullScreen?: () => void;
    /** Open the pull request page on its external host. */
    onOpenPage?: () => void;
    /** Move the review between the leading pane and the companion beside it.
     *  Absent when this band belongs to the list's own detail panel, which has
     *  no pane of its own. */
    onMoveAcross?: () => void;
    /** Which way `onMoveAcross` sends it. */
    isLeading?: boolean;
    onClose: () => void;
    onRefresh: () => void;
    refreshing?: boolean;
    /** The guide's state and the one action it implies, drawn in the overflow. */
    guide?: GuideHeaderActions;
    /** The head branch, for the overflow's copy row. */
    headRef?: string;
    /** Map · Guide · Diff, pinned left. */
    tabs?: Snippet;
    /** The surface's own primary action — Ask Solus. */
    actions?: Snippet;
  } = $props();

  // A queue of one, or a pull request the list is not showing (opened, then
  // filtered out) has nowhere to step to: `onStep` walks the published list
  // order and returns early when this number is not in it. Offer the control
  // only where it moves, rather than leaving two arrows and a blank count.
  const canStepQueue = $derived(position > 0 && total > 1);
</script>

<!-- Its own container: every rung below is the *panel's* width, not the
     window's. Beside the list this row starts at the panel's own edge; covering
     the list it starts at the window's, where the macOS window controls are —
     so the lead inset applies there and only there. -->
<div
  class="workspace-titlebar @container/band flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center gap-1.5 pr-3 @min-[34rem]/band:gap-2.5 @min-[53.75rem]/band:gap-3.5"
  style={fullScreen
    ? "padding-left: max(0.75rem, var(--solus-chrome-lead-inset, 0px))"
    : "padding-left: 0.75rem"}
  data-testid="pr-panel-header"
>
  {#if tabs}{@render tabs()}{/if}

  <span class="flex-1"></span>

  <!-- Identity, and only identity: the number, which never gives. -->
  <span
    class="flex shrink-0 items-center gap-1.5 text-chrome-dense tabular-nums text-muted-foreground"
  >
    <GitPullRequestIcon size={12} aria-hidden="true" />
    <span>#{number}</span>
  </span>

  {#if actions}{@render actions()}{/if}

  <!-- Position, not history: how far through the queue this review is. Same
       pill as the local review's turn scrubber, with a fixed label column so
       stepping past 9 never nudges its neighbours. -->
  {#if canStepQueue}
    <div
      class="no-drag flex h-7 shrink-0 items-center gap-0.5 rounded-full bg-[var(--wash-2)] px-[0.1875rem] [.is-laptop-display_&]:h-6.5"
      role="group"
      aria-label="Review queue"
    >
      <button
        type="button"
        class="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-card hover:text-foreground"
        title="Previous pull request (K)"
        aria-label="Previous pull request"
        onclick={() => onStep(-1)}
      >
        <CaretLeftIcon size={12} />
      </button>
      <span class="text-center font-mono text-chrome-dense tabular-nums">
        <span class="hidden min-w-[3.25rem] @min-[62.5rem]/band:inline-block">
          {position} of {total}
        </span>
        <span class="inline-block min-w-[1.75rem] @min-[62.5rem]/band:hidden">
          {position}/{total}
        </span>
      </span>
      <button
        type="button"
        class="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-card hover:text-foreground"
        title="Next pull request (J)"
        aria-label="Next pull request"
        onclick={() => onStep(1)}
      >
        <CaretRightIcon size={12} />
      </button>
    </div>
  {/if}

  <PrPanelOverflowMenu
    {tab}
    {onRefresh}
    {refreshing}
    {onOpenPage}
    {guide}
    {headRef}
  />

  <!-- The one place a divider used to be. Space, not a rule. -->
  <div class="flex shrink-0 items-center gap-0.5 pl-1.5 @min-[53.75rem]/band:pl-2.5">
    {#if onMoveAcross}
      <PaneSwapButton
        {isLeading}
        onMove={onMoveAcross}
        iconSize={13}
        class="no-drag pointer-events-auto flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      />
    {/if}

    {#if onToggleFullScreen}
      <button
        type="button"
        class="no-drag pointer-events-auto flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {fullScreen
          ? 'bg-[var(--wash-3)] text-foreground'
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
      class="no-drag pointer-events-auto flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      title="Close (Esc)"
      aria-label="Close pull request"
      onclick={onClose}
    >
      <XIcon size={13} />
    </button>
  </div>
</div>
