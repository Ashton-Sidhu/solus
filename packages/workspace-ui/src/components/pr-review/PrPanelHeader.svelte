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

  /**
   * The chrome band of the review panel that slides out beside the list — the
   * same band as the local review's, so reading a pull request and reading a
   * branch are the same object in the same places.
   *
   * Slots, left to right and fixed at every width: the tab group, flexible
   * space, the pull request's number, its actions (Review, Check out, and the
   * merge move once Activity's rail has folded), the overflow, then the pane
   * controls. Nothing appears or disappears as the tab changes. The band does
   * not spend a slot saying where in the list's order you are.
   *
   * The number is the one fact the band states about the pull request: a quiet
   * pill with the same geometry as its neighbours. The merge move lives in the
   * status card on Activity while the rail has a column; narrower than that it
   * is the band's last verb. The refs and the check detail are read on
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
    fullScreen,
    onToggleFullScreen,
    onClose,
    tabs,
    actions,
    menu,
  }: {
    number: number;
    fullScreen: boolean;
    /** Absent when the surface is too narrow to hold a split at all — there is
     *  no smaller state to go back to, so the control is not offered. */
    onToggleFullScreen?: () => void;
    /** Move the review between the leading pane and the companion beside it.
     *  Absent when this band belongs to the list's own detail panel, which has
     *  no pane of its own. */
    onClose: () => void;
    /** Map · Guide · Diff, pinned left. */
    tabs?: Snippet;
    /** The surface's own actions — Review and Check out. */
    actions?: Snippet;
    /** The pull request's ⋯ menu (PrOverflowMenu). */
    menu?: Snippet;
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
     that can give does. The row with both labels needs about 44rem, so under
     52rem — before the row is tight — the Review and Check out actions keep
     their glyphs and drop their labels (see `reviewButton` and
     `checkoutButton` in PrReviewPane). The number never gives
     — in this shape the band is the only place the pull request is named.

     The merge move, once Activity's rail has folded, is the last of those
     verbs and takes the same ladder: the band's quiet pill, a glyph, and a
     short label that drops at the same 52rem (see PrPrimaryAction's band
     layout).

     ── The tabs rung (`@max-[48rem]/band`, in PrViewTabs) ──
     With every label gone the row still needs about 22rem before a single
     tab, and the five tabs another 19rem. So under 48rem the tab group folds
     into one switcher — the current view and a menu of all five — and the
     band stays one row down to the record rung. No tab is ever hidden
     without the switcher standing in for it: a hidden tab is a hidden
     destination.

     ── The record rung (`@max-[30rem]/band`) ──
     A phone renders the panel over the list, which retires the premise the
     desktop band is built on. "The way back is the close control" was true
     beside a visible list; covering it, the ✕ was the *last* thing on a row
     that already overflowed, so it was clipped off the right edge and the
     review became a surface with no exit at all. So the record leads with the
     platform's back chevron, the pane controls stand down — one pane, and
     full screen is the only state there is — and the tab group folds into
     one switcher (see PrViewTabs), so the band is still one row. -->
<div class="@container/band workspace-titlebar shrink-0" data-testid="pr-panel-header">
<!-- `--band-lead` is the row's left inset. On the record rung the back
     chevron takes it, so the row's own padding steps back by the chevron's. -->
<div
  class="flex h-(--solus-chrome-row-h,2.75rem) items-center gap-1.5 pr-3 pl-(--band-lead) @max-[30rem]/band:pl-[calc(var(--band-lead)-0.75rem)]"
  style:--band-lead={fullScreen ? "max(0.75rem, var(--solus-chrome-lead-inset, 0px))" : "0.75rem"}
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

  {#if tabs}{@render tabs()}{/if}

  <span class="flex-1"></span>

  <!-- Identity: the number, which never gives. The same pill as Review and
       Check out beside it, so the row reads as one set, at every width. -->
  <span class="mr-1.5 flex shrink-0 items-center @max-[30rem]/band:mr-0">
    <span
      class="inline-flex h-6.5 items-center gap-1.5 rounded-full bg-background px-2.5 text-workspace-chrome tabular-nums text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] pointer-coarse:h-10 pointer-coarse:px-3.5"
      data-testid="pr-panel-number"
    >
      <GitPullRequestIcon class="size-[15px] text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
      #{number}
    </span>
  </span>

  {#if actions}{@render actions()}{/if}

  {#if menu}{@render menu()}{/if}

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
</div>
</div>
