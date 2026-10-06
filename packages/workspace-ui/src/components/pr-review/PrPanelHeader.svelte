<script lang="ts">
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import {
    Minimize2 as ArrowsInSimpleIcon,
    Maximize2 as ArrowsOutSimpleIcon,
    ChevronLeft as CaretLeftIcon,
    GitPullRequest as GitPullRequestIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import type { GuideHeaderActions } from "../diff/lib/review-header";
  import PrPanelOverflowMenu from "./PrPanelOverflowMenu.svelte";

  /**
   * The chrome band of the review panel that slides out beside the list — the
   * same band as the local review's, so reading a pull request and reading a
   * branch are the same object in the same places.
   *
   * Slots, left to right and fixed at every width: the tab group, flexible
   * space, the pull request's number, its actions (Review, Check out), the overflow, then
   * the pane controls. Nothing appears or disappears as the tab changes — only
   * the overflow's contents follow it. The band does not spend a slot saying
   * where in the list's order you are.
   *
   * The number is the one fact the band states about the pull request: a quiet
   * pill with the same geometry as its neighbours. The merge move lives in the
   * status card on Activity, not here. The refs and the check detail are
   * read on Activity — beside the title and in its rail — rather than repeated
   * in chrome that every tab has to carry.
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
    tab: "activity" | "map" | "guide" | "lens" | "diff";
    fullScreen: boolean;
    /** Absent when the surface is too narrow to hold a split at all — there is
     *  no smaller state to go back to, so the control is not offered. */
    onToggleFullScreen?: () => void;
    /** Open the pull request page on its external host. */
    onOpenPage?: () => void;
    /** Move the review between the leading pane and the companion beside it.
     *  Absent when this band belongs to the list's own detail panel, which has
     *  no pane of its own. */
    onClose: () => void;
    onRefresh: () => void;
    refreshing?: boolean;
    /** The guide's state and the one action it implies, drawn in the overflow. */
    guide?: GuideHeaderActions;
    /** The head branch, for the overflow's copy row. */
    headRef?: string;
    /** Map · Guide · Diff, pinned left. */
    tabs?: Snippet;
    /** The surface's own actions — Review and Check out. */
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
     that can give does: under 40rem the Review and Check out actions keep
     their glyphs and drop their labels (see `reviewButton` and
     `checkoutButton` in PrReviewPane). The number never gives
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
<!-- `--band-lead` is the row's left inset. On the record rung the row stops
     padding itself, so the rule over the tabs runs edge to edge; the top row
     takes the inset instead, and the first tab label starts under the back chevron. -->
<div
  class="flex h-(--solus-chrome-row-h,2.75rem) items-center gap-1.5 pr-3 pl-(--band-lead) @max-[30rem]/band:h-auto @max-[30rem]/band:flex-col @max-[30rem]/band:items-stretch @max-[30rem]/band:gap-0 @max-[30rem]/band:pr-0 @max-[30rem]/band:pl-0"
  style:--band-lead={fullScreen ? "max(0.75rem, var(--solus-chrome-lead-inset, 0px))" : "0.75rem"}
>
  <!-- Above the rung these two wrappers are not boxes at all, so the desktop
       band is the same single row of slots it has always been. -->
  {#if tabs}
    <span
      class="contents @max-[30rem]/band:order-2 @max-[30rem]/band:flex @max-[30rem]/band:h-11 @max-[30rem]/band:items-stretch @max-[30rem]/band:gap-[18px] @max-[30rem]/band:border-t @max-[30rem]/band:border-[var(--hairline)] @max-[30rem]/band:px-3"
    >
      {@render tabs()}
    </span>
  {/if}

  <span
    class="contents @max-[30rem]/band:order-1 @max-[30rem]/band:flex @max-[30rem]/band:h-(--solus-chrome-row-h,2.75rem) @max-[30rem]/band:items-center @max-[30rem]/band:gap-1.5 @max-[30rem]/band:pr-3 @max-[30rem]/band:pl-[calc(var(--band-lead)-0.75rem)]"
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

  <!-- Identity: the number, which never gives. The same pill as Review and
       Check out beside it, so the row reads as one set. On a record it takes
       the slack instead of the spacer above, so the number sits in the middle
       of the band the way every other phone title does. -->
  <span class="mr-1.5 flex shrink-0 items-center @max-[30rem]/band:mr-0 @max-[30rem]/band:min-w-0 @max-[30rem]/band:flex-1 @max-[30rem]/band:justify-center">
    <span
      class="inline-flex h-6.5 items-center gap-1.5 rounded-full bg-background px-2.5 text-workspace-chrome tabular-nums text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] pointer-coarse:h-10 pointer-coarse:px-3.5"
      data-testid="pr-panel-number"
    >
      <GitPullRequestIcon class="size-[15px] text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
      #{number}
    </span>
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
    class="flex shrink-0 items-center gap-1.5 @max-[30rem]/band:hidden"
  >
    {#if onToggleFullScreen}
      <button
        type="button"
        class="{PAGE_SOFT_ICON_BTN} {fullScreen ? 'bg-[var(--wash-3)]! text-foreground!' : ''}"
        title={fullScreen ? "Back to split" : "Expand to full screen"}
        aria-label={fullScreen ? "Back to split view" : "Expand to full screen"}
        aria-pressed={fullScreen}
        onclick={onToggleFullScreen}
      >
        {#if fullScreen}
          <ArrowsInSimpleIcon size={15} strokeWidth={1.5} />
        {:else}
          <ArrowsOutSimpleIcon size={15} strokeWidth={1.5} />
        {/if}
      </button>
    {/if}

    <button
      type="button"
      class={PAGE_SOFT_ICON_BTN}
      title="Close (Esc)"
      aria-label="Close pull request"
      onclick={onClose}
    >
      <XIcon size={16} strokeWidth={1.5} />
    </button>
  </div>
  </span>
</div>
</div>
