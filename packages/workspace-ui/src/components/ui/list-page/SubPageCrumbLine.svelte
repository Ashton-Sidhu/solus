<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ChevronLeft as CaretLeftIcon,
    ChevronRight as CaretRightIcon,
    Maximize2 as ArrowsOutIcon,
    Minimize2 as ArrowsInIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { NavPage } from "../../../lib/page-nav";
  import CopyButton from "../CopyButton.svelte";
  import PaneSwapButton from "../PaneSwapButton.svelte";
  import ParentPageCrumb from "./ParentPageCrumb.svelte";
  import type { SubPageStepper, SubPageTrailSegment } from "./list-page";
  import {
    SUB_PAGE_CRUMB_BTN,
    SUB_PAGE_CRUMB_TEXT,
    SUB_PAGE_ICON,
    SUB_PAGE_ROUND_BTN,
  } from "./sub-page-styles";

  /**
   * The head of every sub page — a task, a pull request, an Insights turn, an
   * automation. The list pages share one crumb line (`PageCrumbLine`); this is
   * its counterpart one level down, so a reader moving from a task to a pull
   * request to a turn finds the same row in the same order every time:
   *
   *   <page> / [trail…] / <leaf> [copy]   …   [actions] [stepper] | [window]
   *
   * The page segment is the way back. The leaf is where you are; it is plain
   * text unless the host supplies a control (the pull request's switcher).
   * Actions are the page's own verbs; the stepper walks the list's order; the
   * window controls act on the pane and sit past a rule so they never read as
   * part of the record.
   *
   * Geometry comes from `sub-page-styles`, at the desktop, laptop and touch
   * rungs; type comes from the shared chrome rung.
   */
  interface Props {
    page: NavPage;
    /** Back to the list. */
    onOpenPage: () => void;
    trail?: SubPageTrailSegment[];
    /** Where you are, as text. */
    leaf?: string;
    leafTitle?: string;
    /** Where you are, as a control — replaces `leaf`. */
    leafControl?: Snippet;
    /** The record's own id, copied beside the leaf. */
    copyText?: string;
    copyTitle?: string;
    /** The page's own verbs and chips, before the stepper. */
    actions?: Snippet;
    stepper?: SubPageStepper;
    onMoveAcross?: () => void;
    isLeading?: boolean;
    onToggleMaximize?: () => void;
    maximized?: boolean;
    maximizeLabel?: string;
    restoreLabel?: string;
    onClose?: () => void;
    closeLabel?: string;
    /** The band starts at the window's edge and has to clear its controls. A
     *  band docked beside a list starts at its own edge instead. */
    clearsWindowControls?: boolean;
  }

  let {
    page,
    onOpenPage,
    trail = [],
    leaf,
    leafTitle,
    leafControl,
    copyText,
    copyTitle = "Copy ID",
    actions,
    stepper,
    onMoveAcross,
    isLeading = true,
    onToggleMaximize,
    maximized = false,
    maximizeLabel = "Maximize",
    restoreLabel = "Restore",
    onClose,
    closeLabel = "Close (Esc)",
    clearsWindowControls = true,
  }: Props = $props();

  const hasWindowControls = $derived(!!onMoveAcross || !!onToggleMaximize || !!onClose);
  const queueLabel = $derived(
    stepper?.position && stepper.total ? `${stepper.position} of ${stepper.total}` : "",
  );
  const hint = (key: string | undefined) => (key ? ` (${key})` : "");
</script>

<!-- One row, one height, one seam, whichever record it heads. The right
     padding is the only thing that varies: a band that carries its own window
     controls reaches the pane's edge, one that does not reserves the room the
     floating PaneChrome cluster occupies.

     At the record rung the band is 56px, because its controls already are: the
     touch rung gives every button in here a 36–44px box, which did not fit the
     40px band and overflowed it. Both insets are marked `!` so the desktop
     pair above cannot win them back on a phone, where `.is-laptop-display` is
     also set. -->
<div
  class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-1 border-b border-[var(--hairline)] text-workspace-chrome [.is-laptop-display_&]:gap-0.5 @max-[30rem]/pane:h-14! @max-[30rem]/pane:pl-2! @max-[30rem]/pane:pr-2! {clearsWindowControls
    ? 'pl-[max(1rem,var(--solus-chrome-lead-inset,0px))] [.is-laptop-display_&]:pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]'
    : 'pl-3 [.is-laptop-display_&]:pl-2.5'} {hasWindowControls
    ? 'pr-3.5 [.is-laptop-display_&]:pr-3'
    : 'pr-[max(0.875rem,var(--solus-pane-chrome-inset,0px))]'}"
>
  <nav class="flex min-w-0 shrink items-center" aria-label="Location">
    <ParentPageCrumb {page} onOpen={onOpenPage} />
    {#each trail as segment (segment.label)}
      {#if segment.onOpen}
        <button type="button" class={SUB_PAGE_CRUMB_BTN} onclick={segment.onOpen}>
          {segment.label}
        </button>
      {:else}
        <span class={SUB_PAGE_CRUMB_TEXT}>{segment.label}</span>
      {/if}
      <span
        class="shrink-0 px-[3px] text-muted-foreground opacity-30 [.is-laptop-display_&]:px-0.5"
        aria-hidden="true">/</span
      >
    {/each}
    {#if leafControl}
      {@render leafControl()}
    {:else if leaf}
      <span
        class="flex h-7 min-w-0 max-w-48 items-center truncate rounded px-[7px] text-foreground pointer-coarse:h-9 pointer-fine:[.is-laptop-display_&]:h-6 [.is-laptop-display_&]:px-1.5"
        title={leafTitle ?? leaf}>{leaf}</span
      >
    {/if}
    {#if copyText}
      <CopyButton text={copyText} title={copyTitle} iconOnly />
    {/if}
  </nav>

  <span class="min-w-2 flex-1" aria-hidden="true"></span>

  {#if actions}{@render actions()}{/if}

  <!-- The queue walks the list's order with K and J. A phone has neither key
       and no room for a third control group, and the switcher in the leaf
       reaches the same rows — so the stepper stands down rather than pushing
       the controls after it off the edge. -->
  {#if stepper}
    <div class="flex shrink-0 items-center gap-0.5 @max-[30rem]/pane:hidden">
      <button
        type="button"
        class={SUB_PAGE_ROUND_BTN}
        onclick={() => stepper.onPrevious?.()}
        disabled={!stepper.onPrevious}
        title="Previous {stepper.itemLabel}{hint(stepper.previousHint)}"
        aria-label="Previous {stepper.itemLabel}"
      >
        <CaretLeftIcon size={12} class={SUB_PAGE_ICON} />
      </button>
      {#if queueLabel}
        <span class="tabular-nums whitespace-nowrap text-muted-foreground">{queueLabel}</span>
      {/if}
      <button
        type="button"
        class={SUB_PAGE_ROUND_BTN}
        onclick={() => stepper.onNext?.()}
        disabled={!stepper.onNext}
        title="Next {stepper.itemLabel}{hint(stepper.nextHint)}"
        aria-label="Next {stepper.itemLabel}"
      >
        <CaretRightIcon size={12} class={SUB_PAGE_ICON} />
      </button>
    </div>
  {/if}

  {#if hasWindowControls}
    <!-- Navigation and the record's verbs end here; past the rule everything
         acts on the pane.

         All of it stands down at the record rung. A phone renders one pane, so
         there is nowhere to swap to and no smaller state to restore from; and
         the ✕ was the *last* control on a row that already overflowed 393px,
         which made it the one that got clipped off the edge. The parent crumb
         at the head of this row is the back control, and it is enough. -->
    <span
      class="mx-1 h-4 w-px shrink-0 bg-[var(--hairline-strong)] [.is-laptop-display_&]:mx-0.5 [.is-laptop-display_&]:h-3.5 @max-[30rem]/pane:hidden"
      aria-hidden="true"
    ></span>
    <span class="contents @max-[30rem]/pane:hidden">

    {#if onMoveAcross}
      <PaneSwapButton {isLeading} onMove={onMoveAcross} iconSize={13} class={SUB_PAGE_ROUND_BTN} />
    {/if}

    {#if onToggleMaximize}
      <button
        type="button"
        class="{SUB_PAGE_ROUND_BTN} {maximized ? 'bg-[var(--wash-2)] text-foreground' : ''}"
        onclick={onToggleMaximize}
        title={maximized ? restoreLabel : maximizeLabel}
        aria-label={maximized ? restoreLabel : maximizeLabel}
        aria-pressed={maximized}
      >
        {#if maximized}
          <ArrowsInIcon size={13} class={SUB_PAGE_ICON} />
        {:else}
          <ArrowsOutIcon size={13} class={SUB_PAGE_ICON} />
        {/if}
      </button>
    {/if}

    {#if onClose}
      <button
        type="button"
        class={SUB_PAGE_ROUND_BTN}
        onclick={onClose}
        title={closeLabel}
        aria-label={closeLabel}
      >
        <XIcon size={13} class={SUB_PAGE_ICON} />
      </button>
    {/if}
    </span>
  {/if}
</div>
