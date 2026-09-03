<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ChevronLeft as CaretLeftIcon,
    ChevronRight as CaretRightIcon,
    MessageCircle as ChatCircleTextIcon,
    Minimize as ArrowsInIcon,
    Maximize as ArrowsOutIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { TurnSnapshot } from "@solus/contracts/types";
  import type { ReviewView } from "../../contexts/workspace/routing/route-registry";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import ChangeSummaryPopover from "./ChangeSummaryPopover.svelte";
  import ReviewPanelOverflowMenu from "./ReviewPanelOverflowMenu.svelte";
  import {
    turnScrubberLabel,
    type ChangedFileSummary,
    type GuideHeaderActions,
  } from "./lib/review-header";

  /**
   * The review panel's one chrome row.
   *
   * It carries navigation and state and nothing else: where you are (the tabs),
   * what changed (the branch and its two counts), which turn you are reading,
   * and the two window controls. Anything the *view* can be configured to do —
   * unified/split, the file tree, collapse, token highlighting, refresh — lives
   * under the overflow, whose contents follow the active tab. That is what lets
   * the band's slots stay fixed: only the menu is contextual.
   *
   * There is no rule under it and no divider beside it. Separation comes from
   * the gap before the window controls and from the body's own surface.
   *
   * Height is the workspace chrome row rather than the mock's flat 46px: this
   * row shares a baseline with the tab strip in the pane beside it, and macOS
   * grows that row to clear the traffic lights.
   */
  let {
    view,
    viewTabs,
    branchLabel,
    branchTitle,
    additions,
    deletions,
    changedFiles,
    baseLabel,
    turns,
    selectedTurnIndex,
    onStepTurn,
    diffStyle,
    onSetStyle,
    tokenHighlight,
    onToggleTokenHighlight,
    allCollapsed,
    onToggleCollapseAll,
    treeCollapsed,
    onToggleTree,
    onRefresh,
    refreshing,
    guide,
    onOpenFile,
    commentsCount,
    commentsOpen,
    onToggleComments,
    commentsAnchorRef,
    onToggleMaximize = null,
    maximized = false,
    onClose,
  }: {
    view: ReviewView;
    /** The host's Map · Guide · Diff row. The host owns it because the Guide
     *  tab reports generation state this panel knows nothing about. */
    viewTabs?: Snippet;
    branchLabel: string;
    branchTitle?: string;
    additions: number;
    deletions: number;
    changedFiles: ChangedFileSummary[];
    baseLabel: string;
    /** Empty where turns are not a scope this panel can take — a working-tree
     *  read, or a panel embedded in a surface that owns the scope itself. */
    turns: TurnSnapshot[];
    selectedTurnIndex: number | null;
    onStepTurn: (direction: 1 | -1) => void;
    diffStyle: "unified" | "split";
    onSetStyle: (style: "unified" | "split") => void;
    tokenHighlight: boolean;
    onToggleTokenHighlight: () => void;
    allCollapsed: boolean;
    onToggleCollapseAll: () => void;
    treeCollapsed: boolean;
    onToggleTree: () => void;
    onRefresh: () => void;
    refreshing: boolean;
    /** The guide's state and its one action, on the Guide tab. Absent where the
     *  host has no guide. */
    guide?: GuideHeaderActions;
    onOpenFile: (path: string) => void;
    commentsCount: number;
    commentsOpen: boolean;
    onToggleComments: () => void;
    commentsAnchorRef?: (el: HTMLButtonElement | null) => void;
    /** Absent where the surface has no pane to maximize (the web client's
     *  full-height sheet). */
    onToggleMaximize?: (() => void) | null;
    maximized?: boolean;
    onClose: () => void;
  } = $props();

  const showTurns = $derived(turns.length > 0);
  const turnLabelWide = $derived(turnScrubberLabel(turns, selectedTurnIndex, "wide"));
  const turnLabelNarrow = $derived(turnScrubberLabel(turns, selectedTurnIndex, "narrow"));
  const scopeLabel = $derived(
    selectedTurnIndex === null ? "all turns" : turnScrubberLabel(turns, selectedTurnIndex, "wide").toLowerCase(),
  );

  const maximizeHint = $derived(comboHint("pane.maximize"));

  let commentsBtn: HTMLButtonElement | null = $state(null);
  $effect(() => {
    commentsAnchorRef?.(commentsBtn);
  });
</script>

<!-- The band measures the *panel's* width, not the window's. A review panel is
     legally ~356px wide beside a companion pane, so a window-width reading here
     would be wrong by the whole split.

     The container is declared on this wrapper rather than on the band itself,
     because an element cannot query itself: the band carried `@container/band`
     and `@min-[…]/band` on the same class list, so every rung it declared for
     its own geometry was dead — no error, no warning, just a row that never
     changed shape. The rungs on its *children* fired all along, which is what
     made the defect invisible.

     ── The record rung (`@max-[30rem]/band`) ──
     Six slots on one 40px row do not fit a phone, and the two that got pushed
     off the end were the pane controls — so the review covered the conversation
     with no way back to it. The record leads with the platform's back chevron,
     the turn scrubber and the pane cluster stand down (one pane, no ⌥ keys to
     step with), and the tabs take a row of their own underneath. -->
<div class="@container/band workspace-titlebar shrink-0" data-testid="review-panel-header">
<div
  class="flex min-h-(--solus-chrome-row-h,2.5rem) items-center gap-1.5 pr-3 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))] @min-[34rem]/band:gap-2.5 @min-[53.75rem]/band:gap-3.5 @max-[30rem]/band:flex-col @max-[30rem]/band:items-stretch @max-[30rem]/band:gap-0 @max-[30rem]/band:p-0"
>
  <!-- Above the rung these wrappers are not boxes at all, so the desktop band
       is the same single row of slots it has always been. -->
  <span
    class="contents @max-[30rem]/band:order-2 @max-[30rem]/band:flex @max-[30rem]/band:h-11 @max-[30rem]/band:items-stretch @max-[30rem]/band:border-t @max-[30rem]/band:border-[var(--hairline)] @max-[30rem]/band:px-4"
  >
    {@render viewTabs?.()}
  </span>

  <span
    class="contents @max-[30rem]/band:order-1 @max-[30rem]/band:flex @max-[30rem]/band:h-14 @max-[30rem]/band:items-center @max-[30rem]/band:gap-1.5 @max-[30rem]/band:px-2"
  >
  <!-- The way out, and at this rung the only one: the ✕ it stands in for was
       the last control on a row that overflowed, so it was never reachable. -->
  <button
    type="button"
    class="no-drag hidden size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground active:bg-[var(--wash-2)] active:text-foreground @max-[30rem]/band:flex [-webkit-tap-highlight-color:transparent]"
    aria-label="Back to conversation"
    onclick={onClose}
  >
    <CaretLeftIcon size={19} />
  </button>

  <span class="flex-1"></span>

  {#if commentsCount > 0}
    <!-- Pending comments are this panel's one piece of unsent work, so they
         keep a slot on the band rather than a row in the menu. -->
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button
            {...tooltipProps}
            bind:this={commentsBtn}
            type="button"
            class="no-drag flex h-[1.625rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-(--solus-accent-light) px-2.5 text-chrome-dense font-medium text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10"
            aria-haspopup="dialog"
            aria-expanded={commentsOpen}
            aria-label={`${commentsCount} pending comments`}
            onclick={onToggleComments}
          >
            <ChatCircleTextIcon size={13} class="shrink-0" />
            <span class="font-mono tabular-nums">{commentsCount}</span>
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={commentsOpen ? "Hide comments" : "Show all comments"} />
    </TooltipUI.Root>
  {/if}

  <ChangeSummaryPopover
    {branchLabel}
    {branchTitle}
    {additions}
    {deletions}
    files={changedFiles}
    {baseLabel}
    {scopeLabel}
    {onOpenFile}
  />

  {#if showTurns}
    <!-- One control, three consequences: the map re-areas, the guide re-steps
         and the diff re-hunks off the same turn. That is why it is on the band
         and not in the menu. The label column is fixed so stepping past 9 never
         nudges the controls beside it. -->
    <div
      class="no-drag flex h-7 shrink-0 items-center gap-0.5 rounded-full bg-[var(--wash-2)] px-[0.1875rem] [.is-laptop-display_&]:h-6.5 @max-[30rem]/band:hidden"
      role="group"
      aria-label="Agent turn"
    >
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button
              {...tooltipProps}
              type="button"
              class="flex size-[1.375rem] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-[background-color,color] duration-100 ease-in-out hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
              aria-label="Previous turn"
              onclick={() => onStepTurn(-1)}
            >
              <CaretLeftIcon size={12} />
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={`Previous turn (${comboHint("diff-panel.prev-turn")})`} />
      </TooltipUI.Root>

      <span class="text-center font-mono text-chrome-dense tabular-nums">
        <span class="hidden min-w-[3.25rem] @min-[62.5rem]/band:inline-block">{turnLabelWide}</span>
        <span class="inline-block min-w-[1.75rem] @min-[62.5rem]/band:hidden">{turnLabelNarrow}</span>
      </span>

      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button
              {...tooltipProps}
              type="button"
              class="flex size-[1.375rem] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-[background-color,color] duration-100 ease-in-out hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
              aria-label="Next turn"
              onclick={() => onStepTurn(1)}
            >
              <CaretRightIcon size={12} />
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={`Next turn (${comboHint("diff-panel.next-turn")})`} />
      </TooltipUI.Root>
    </div>
  {/if}

  <ReviewPanelOverflowMenu
    {view}
    {diffStyle}
    {onSetStyle}
    {tokenHighlight}
    {onToggleTokenHighlight}
    {allCollapsed}
    {onToggleCollapseAll}
    {treeCollapsed}
    {onToggleTree}
    {onRefresh}
    {refreshing}
    {guide}
    hasFiles={changedFiles.length > 0}
  />

  <!-- The one place a divider used to be. Space, not a rule.

       Both act on a pane, and a record has one: there is no smaller state to
       restore to, and the ✕ would be a second way out beside the chevron that
       leads this row. -->
  <div
    class="flex shrink-0 items-center gap-0.5 pl-1.5 @min-[53.75rem]/band:pl-2.5 @max-[30rem]/band:hidden"
  >
    {#if onToggleMaximize}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button
              {...tooltipProps}
              type="button"
              class="no-drag flex size-[1.625rem] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-[background-color,color] duration-100 ease-in-out hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-11"
              aria-label={maximized ? "Restore panel size" : "Maximize panel"}
              onclick={onToggleMaximize}
            >
              {#if maximized}
                <ArrowsInIcon size={14} />
              {:else}
                <ArrowsOutIcon size={14} />
              {/if}
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content
          value={`${maximized ? "Restore panel" : "Maximize panel"}${maximizeHint ? ` (${maximizeHint})` : ""}`}
        />
      </TooltipUI.Root>
    {/if}

    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button
            {...tooltipProps}
            type="button"
            class="no-drag flex size-[1.625rem] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-[background-color,color] duration-100 ease-in-out hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-11"
            aria-label="Close review"
            data-testid="review-panel-close"
            onclick={onClose}
          >
            <XIcon size={15} />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={`Close review (${comboHint("diff-panel.close")})`} />
    </TooltipUI.Root>
  </div>
  </span>
</div>
</div>
