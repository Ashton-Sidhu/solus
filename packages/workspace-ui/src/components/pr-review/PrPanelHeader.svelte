<script lang="ts">
  import {
    Minimize2 as ArrowsInSimpleIcon,
    Maximize2 as ArrowsOutSimpleIcon,
    ChevronLeft as CaretLeftIcon,
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
   * space, the pull request's number, its primary action, the overflow, then
   * the pane controls. Nothing appears or disappears as the tab changes — only
   * the overflow's contents follow it. J and K still walk the list's order;
   * the band does not spend a slot saying where in it you are.
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
    fullScreen,
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
    fullScreen: boolean;
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
    /** The surface's own primary action — Check out. */
    actions?: Snippet;
  } = $props();
</script>

<!-- Its own container: every rung below is the *panel's* width, not the
     window's. Beside the list this row starts at the panel's own edge; covering
     the list it starts at the window's, where the macOS window controls are —
     so the lead inset applies there and only there.

     The container is declared on this wrapper and the band is the child, because
     an element cannot query itself: the band's own geometry has a record rung
     too, and it can only read the width if something outside it is measuring.

     ── The ladder above the record ──
     Every slot on the row is rigid, so the row overflows the moment their sum
     passes the band's width, and the two it pushes off the end are the
     overflow and the ✕ — under the pane beside this one, where they cannot be
     reached. Beside a companion the band is legally ~40rem, and in full screen
     the traffic-light inset spends another ~6rem of it, so the widest slot
     that can give does: under 40rem the Check out action keeps its glyph and
     drops its label (see `checkoutButton` in PrReviewPane). The number never gives
     — in this shape the band is the only place the pull request is named.

     ── The record rung (`@max-[30rem]/band`) ──
     A phone renders the panel over the list, which retires the premise the
     desktop band is built on. "The way back is the close control" was true
     beside a visible list; covering it, the ✕ was the *last* thing on a row
     that already overflowed, so it was clipped off the right edge and the
     review became a surface with no exit at all. So the record leads with the
     platform's back chevron, the pane controls stand down — one pane, and
     full screen is the only state there is — and the tabs take a row of their
     own underneath, where four of them fit. -->
<div class="@container/band workspace-titlebar shrink-0" data-testid="pr-panel-header">
<div
  class="flex h-(--solus-chrome-row-h,2.75rem) items-center gap-1.5 pr-3 @min-[34rem]/band:gap-2.5 @min-[53.75rem]/band:gap-3.5 @max-[30rem]/band:h-auto @max-[30rem]/band:flex-col @max-[30rem]/band:items-stretch @max-[30rem]/band:gap-0 @max-[30rem]/band:pr-0"
  style={fullScreen
    ? "padding-left: max(0.75rem, var(--solus-chrome-lead-inset, 0px))"
    : "padding-left: 0.75rem"}
>
  <!-- Above the rung these two wrappers are not boxes at all, so the desktop
       band is the same single row of slots it has always been. -->
  {#if tabs}
    <span
      class="contents @max-[30rem]/band:order-2 @max-[30rem]/band:flex @max-[30rem]/band:h-11 @max-[30rem]/band:items-stretch @max-[30rem]/band:gap-[18px] @max-[30rem]/band:border-t @max-[30rem]/band:border-[var(--hairline)] @max-[30rem]/band:px-4"
    >
      {@render tabs()}
    </span>
  {/if}

  <span
    class="contents @max-[30rem]/band:order-1 @max-[30rem]/band:flex @max-[30rem]/band:h-14 @max-[30rem]/band:items-center @max-[30rem]/band:gap-1 @max-[30rem]/band:px-2"
  >
  <!-- The way out, and at this rung the only one. It is the same `onClose` the
       ✕ carries, drawn where a thumb expects to find it. -->
  <button
    type="button"
    class="no-drag pointer-events-auto hidden size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground active:bg-[var(--wash-2)] active:text-foreground @max-[30rem]/band:flex [-webkit-tap-highlight-color:transparent]"
    title="Back to list (Esc)"
    aria-label="Back to pull requests"
    onclick={onClose}
  >
    <CaretLeftIcon size={19} />
  </button>

  <span class="flex-1 @max-[30rem]/band:hidden"></span>

  <!-- Identity, and only identity: the number, which never gives. On a record
       it takes the slack instead of the spacer above, so the number sits in the
       middle of the band the way every other phone title does. -->
  <span
    class="flex shrink-0 items-center gap-1.5 text-workspace-chrome tabular-nums text-muted-foreground @max-[30rem]/band:min-w-0 @max-[30rem]/band:flex-1 @max-[30rem]/band:justify-center"
  >
    <GitPullRequestIcon size={12} aria-hidden="true" />
    <span>#{number}</span>
  </span>

  {#if actions}{@render actions()}{/if}

  <PrPanelOverflowMenu
    {tab}
    {onRefresh}
    {refreshing}
    {onOpenPage}
    {guide}
    {headRef}
  />

  <!-- The one place a divider used to be. Space, not a rule.

       All three act on a pane, and a record has one pane: there is nowhere to
       swap to, full screen is the only state, and the ✕ would be a second way
       out beside the chevron that leads this row. -->
  <div
    class="flex shrink-0 items-center gap-0.5 pl-1.5 @min-[53.75rem]/band:pl-2.5 @max-[30rem]/band:hidden"
  >
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
  </span>
</div>
</div>
