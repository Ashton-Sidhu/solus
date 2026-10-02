<script module lang="ts">
  export interface HeaderStats {
    files: number;
    additions: number;
    deletions: number;
  }
</script>

<script lang="ts">
  import {
    GitBranch as GitBranchIcon,
    GitCommitHorizontal as GitCommitIcon,
    Layers as StackIcon,
    MessageCircle as ChatCircleTextIcon,
    PanelLeft as SidebarSimpleIcon,
    PanelRight as FileTreeIcon,
    ChevronLeft as CaretLeftIcon,
    ChevronRight as CaretRightIcon,
    ChevronDown as CaretDownIcon,
    ChevronUp as CaretUpIcon,
    Columns3 as ColumnsIcon,
    RotateCw as ArrowClockwiseIcon,
    Shrink as ArrowsInLineVerticalIcon,
    Expand as ArrowsOutLineVerticalIcon,
  } from "@lucide/svelte";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import DiffLayoutToggle from "./DiffLayoutToggle.svelte";
  import DiffTokenToggle from "./DiffTokenToggle.svelte";
  import { MiddleTruncate } from "@solus/workspace-ui/components/ui/middle-truncate";
  import { MONO_FONT } from "../../lib/diffTheme";
  import type { Snippet } from "svelte";
  import type { TurnSnapshot } from "@solus/contracts/types";
  import type { ReviewView } from "../../contexts/workspace/routing/route-registry";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import { worktreeDisplayName } from "../../lib/git-context";

  interface Props {
    isWorktree: boolean;
    worktreeBranch: string;
    targetBranch: string;
    fallbackBranch: string | null;
    headerStats: HeaderStats | null;
    diffStyle: "unified" | "split";
    onSetStyle: (style: "unified" | "split") => void;
    tokenHighlight: boolean;
    onToggleTokenHighlight: () => void;
    allCollapsed: boolean;
    onToggleCollapseAll: () => void;
    filesCount: number;
    treeCollapsed: boolean;
    onToggleTree: () => void;
    onRefresh: () => void;
    refreshing: boolean;
    onOpenFiles: () => void;
    commentsCount: number;
    commentsOpen: boolean;
    onToggleComments: () => void;
    commentsAnchorRef?: (el: HTMLButtonElement | null) => void;
    turns: TurnSnapshot[];
    selectedTurnIndex: number | null;
    onTurnSelect: (index: number | null) => void;
    onStepTurn: (dir: 1 | -1) => void;
    turnRunning?: boolean;
    mode?: "session" | "working-tree";
    /** Which face of the change is showing. Controls that only style the diff
     *  stream hide on the other two. */
    view: ReviewView;
    /** The host's Map · Guide · Diff row. The toolbar reserves the lead
     *  position for it because it decides which face of the change is showing,
     *  ahead of every control that only styles the stream. */
    viewTabs?: Snippet;
    /** The surface above already draws the chrome row and names the change (the
     *  PR review header states `#47 head → base`). The strip then reads as a
     *  second, quieter row: no branch identity, no chrome-row height, and no
     *  gutter reserved for floating pane controls that live in that header. */
    hasHostHeaderRow?: boolean;
    /** Commit identity for a pull-request diff scoped to one commit. */
    commitSha?: string | null;
    /** Return to the full pull-request diff. */
    onClearCommitScope?: () => void;
  }

  let {
    isWorktree,
    worktreeBranch,
    targetBranch,
    fallbackBranch,
    headerStats,
    diffStyle,
    onSetStyle,
    tokenHighlight,
    onToggleTokenHighlight,
    allCollapsed,
    onToggleCollapseAll,
    filesCount,
    treeCollapsed,
    onToggleTree,
    onRefresh,
    refreshing,
    onOpenFiles,
    commentsCount,
    commentsOpen,
    onToggleComments,
    commentsAnchorRef,
    turns,
    selectedTurnIndex,
    onTurnSelect,
    onStepTurn,
    turnRunning = false,
    mode = "session",
    view,
    viewTabs,
    hasHostHeaderRow = false,
    commitSha = null,
    onClearCommitScope,
  }: Props = $props();

  const showTurns = $derived(mode === "session" && turns.length > 0);
  // Past ~8 turns the inline pill strip overflows with no affordance — collapse
  // to a compact stepper + dropdown instead.
  const COMPACT_TURN_THRESHOLD = 8;
  const compactTurns = $derived(turns.length > COMPACT_TURN_THRESHOLD);
  const lastTurnIndex = $derived(
    turns.length > 0 ? turns[turns.length - 1].index : null,
  );

  let turnMenuOpen = $state(false);
  let turnTriggerEl: HTMLButtonElement | null = $state(null);

  const selectedTurnLabel = $derived(
    selectedTurnIndex === null ? "All" : `Turn ${selectedTurnIndex + 1}`,
  );
  const branchLabel = $derived(
    mode === "working-tree"
      ? "Working tree"
      : isWorktree
        ? `${worktreeDisplayName(worktreeBranch)} → ${targetBranch}`
        : fallbackBranch,
  );

  function turnTooltipFor(turn: TurnSnapshot): string {
    const summary = turn.userMessagePreview.slice(0, 60).trim();
    const label = `Turn ${turn.index + 1}${summary ? `: ${summary}${turn.userMessagePreview.length > 60 ? "…" : ""}` : ""}`;
    const stats = `${turn.filesChanged} file${turn.filesChanged === 1 ? "" : "s"} • +${turn.additions} −${turn.deletions}`;
    return `${label}\n${stats}`;
  }

  let commentsBtn: HTMLButtonElement | null = $state(null);

  $effect(() => {
    commentsAnchorRef?.(commentsBtn);
  });
</script>

<div
  class="text-xs diff-toolbar {hasHostHeaderRow ? '' : 'workspace-titlebar'}"
  class:is-subrow={hasHostHeaderRow}
  data-testid="diff-toolbar"
>
  <div class="toolbar-section toolbar-left">
    {#if commitSha}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button
              {...tooltipProps}
              type="button"
              onclick={onClearCommitScope}
              disabled={!onClearCommitScope}
              aria-label={`Showing commit ${commitSha.slice(0, 7)}. View all changes`}
              class="no-drag inline-flex shrink-0 cursor-pointer items-center gap-1.5 border-0 h-6.5 rounded-full bg-background px-2.5 text-workspace-chrome shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors hover:bg-[var(--wash-1)] font-mono text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border) disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10"
            >
              <GitCommitIcon size={15} strokeWidth={1.5} />
              <span>{commitSha.slice(0, 7)}</span>
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={"View all changes"} />
      </TooltipUI.Root>
    {/if}

    {#if !hasHostHeaderRow}
    {#if branchLabel}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <div
              {...tooltipProps}
              class="flex min-w-0 max-w-[24rem] shrink items-center gap-1 desktop-only"
            >
              <GitBranchIcon
                size={14}
                class="text-(--solus-accent) flex-shrink-0"
                weight="bold"
              />
              <MiddleTruncate
                value={branchLabel}
                showTitle={false}
                class="font-medium text-(--solus-text-primary)"
                style="font-family:{MONO_FONT}"
              />
            </div>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={branchLabel} />
      </TooltipUI.Root>
    {/if}
    {/if}

    {#if headerStats}
      <!-- The changed-line counts use the same sage/red as the diff rows, so
           the header summary and the stream read as one palette. -->
      <div class="diff-stats" style="font-family:{MONO_FONT}">
        <span style="color:var(--solus-art-3)" class="font-medium"
          >+{headerStats.additions}</span
        >
        <span style="color:var(--solus-stop-bg)" class="font-medium"
          >−{headerStats.deletions}</span
        >
      </div>
    {/if}
  </div>

  {#if showTurns}
    <div class="toolbar-section toolbar-center">
      {#if compactTurns}
        <div class="turn-stepper">
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <button {...tooltipProps}
            type="button"
            class="turn-btn"
            class:is-active={selectedTurnIndex === null}
            onclick={() => onTurnSelect(null)}
            aria-label="Show all changes"
            aria-pressed={selectedTurnIndex === null}
          >
            <StackIcon size={14} weight="bold" />
          </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={"All changes"} />
          </TooltipUI.Root>
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <button {...tooltipProps}
            type="button"
            class="turn-step-arrow"
            onclick={() => onStepTurn(-1)}
            aria-label="Previous turn"
          >
            <CaretLeftIcon size={14} weight="bold" />
          </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={"Previous turn (⌥←)"} />
          </TooltipUI.Root>
          <button
            type="button"
            bind:this={turnTriggerEl}
            class="turn-current"
            class:is-active={selectedTurnIndex !== null}
            onclick={() => (turnMenuOpen = !turnMenuOpen)}
            aria-haspopup="menu"
            aria-expanded={turnMenuOpen}
          >
            <span>{selectedTurnLabel}</span>
            <CaretDownIcon size={14} weight="bold" />
          </button>
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <button {...tooltipProps}
            type="button"
            class="turn-step-arrow"
            onclick={() => onStepTurn(1)}
            aria-label="Next turn"
          >
            <CaretRightIcon size={14} weight="bold" />
          </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={"Next turn (⌥→)"} />
          </TooltipUI.Root>

          <DropdownMenu.Root bind:open={turnMenuOpen}>
            <DropdownMenu.Content customAnchor={turnTriggerEl} side="top" align="start" sideOffset={6} class="w-[176px]">
            <div class="turn-menu-scroll">
              <DropdownMenu.Item
                class={selectedTurnIndex === null ? "font-medium" : undefined}
                onSelect={() => {
                  turnMenuOpen = false;
                  onTurnSelect(null);
                }}
              >
                <StackIcon size={14} weight="bold" />
                All changes
              </DropdownMenu.Item>
              {#each turns as turn (turn.index)}
                <DropdownMenu.Item
                  class={selectedTurnIndex === turn.index ? "font-medium" : undefined}
                  onSelect={() => {
                    turnMenuOpen = false;
                    onTurnSelect(turn.index);
                  }}
                >
                  <GitCommitIcon
                    size={14}
                    weight={turnRunning && turn.index === lastTurnIndex
                      ? "fill"
                      : "regular"}
                    color={turn.filesChanged > 0 &&
                    selectedTurnIndex !== turn.index
                      ? "var(--solus-status-complete)"
                      : undefined}
                  />
                  <span>Turn {turn.index + 1}</span>
                  <span class="turn-menu-stats ml-auto">+{turn.additions} −{turn.deletions}</span>
                </DropdownMenu.Item>
              {/each}
            </div>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      {:else}
        <div class="turn-pills">
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <button {...tooltipProps}
            type="button"
            class="turn-btn"
            class:is-active={selectedTurnIndex === null}
            onclick={() => onTurnSelect(null)}
            aria-label="Show all changes"
            aria-pressed={selectedTurnIndex === null}
          >
            <StackIcon size={14} weight="bold" />
          </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={"All changes"} />
          </TooltipUI.Root>
          {#each turns as turn (turn.index)}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <button {...tooltipProps}
              type="button"
              class="turn-btn"
              class:is-active={selectedTurnIndex === turn.index}
              class:has-changes={turn.filesChanged > 0}
              onclick={() => onTurnSelect(turn.index)}
              aria-label={`Show turn ${turn.index + 1}`}
              aria-pressed={selectedTurnIndex === turn.index}
            >
              <GitCommitIcon
                size={14}
                weight={turnRunning && turn.index === lastTurnIndex
                  ? "fill"
                  : "regular"}
              />
              <span>{turn.index + 1}</span>
            </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value={turnTooltipFor(turn)} />
            </TooltipUI.Root>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="flex-1 desktop-only"></div>
  {/if}

  <div class="toolbar-section toolbar-right">
    {#if filesCount > 0}
      <button
        type="button"
        onclick={onOpenFiles}
        class="no-drag hidden shrink-0 cursor-pointer items-center gap-1.5 border-0 h-6.5 rounded-full bg-background px-2.5 text-workspace-chrome text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors hover:bg-[var(--wash-1)] font-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border) pointer-coarse:h-10 max-md:flex [-webkit-tap-highlight-color:transparent]"
        aria-label="Browse changed files"
      >
        <SidebarSimpleIcon size={15} strokeWidth={1.5} />
        <span class="tabular-nums">{filesCount}</span>
      </button>
    {/if}

    <!-- Layout choice leads the control cluster: it is the one setting that
         changes how the whole stream reads, so it sits ahead of the icon
         actions. Desktop gets a segmented control of two icons so the active
         layout is legible without hovering. Below 768px the pair doesn't fit
         beside the rest of the strip, so the single icon toggle stands in. -->
    <!-- The view row leads: it decides whether the panel reads as a heat map
         of where the change landed, the guided walkthrough, or the line-level
         stream, so it sits ahead of the stream-only controls it hides. -->
    {@render viewTabs?.()}

    {#if view === "diff"}
    <span class="desktop-only layout-toggle-slot">
      <DiffLayoutToggle {diffStyle} {onSetStyle} />
    </span>

    <span class="mobile-only">
      <button
        type="button"
        onclick={() => onSetStyle(diffStyle === "split" ? "unified" : "split")}
        aria-label={diffStyle === "split"
          ? "Switch to unified view"
          : "Switch to split view"}
        aria-pressed={diffStyle === "split"}
        class="{PAGE_SOFT_ICON_BTN} {diffStyle === 'split' ? 'bg-[var(--wash-3)]! text-foreground!' : ''}"
      >
        <ColumnsIcon size={15} strokeWidth={1.5} />
      </button>
    </span>
    {/if}

    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <span {...tooltipProps} class="inline-flex">
      <button
        type="button"
        onclick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh diff"
        class="{PAGE_SOFT_ICON_BTN} disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span class="flex" class:refresh-spin={refreshing}>
          <ArrowClockwiseIcon size={15} strokeWidth={1.5} />
        </span>
      </button>
    </span>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={"Refresh diff (⌥R)"} />
    </TooltipUI.Root>

    {#if filesCount > 0 && view === "diff"}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <span {...tooltipProps}
        class="desktop-only"
      >
        <button
          type="button"
          onclick={onToggleCollapseAll}
          aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
          class={PAGE_SOFT_ICON_BTN}
        >
          {#if allCollapsed}
            <ArrowsOutLineVerticalIcon size={15} strokeWidth={1.5} />
          {:else}
            <ArrowsInLineVerticalIcon size={15} strokeWidth={1.5} />
          {/if}
        </button>
      </span>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={allCollapsed ? "Expand all files" : "Collapse all files"} />
      </TooltipUI.Root>
    {/if}

    {#if filesCount > 0 && view === "diff"}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <span {...tooltipProps}
        class="desktop-only"
      >
        <button
          type="button"
          onclick={onToggleTree}
          aria-label={treeCollapsed ? "Show file tree" : "Hide file tree"}
          aria-pressed={!treeCollapsed}
          class="{PAGE_SOFT_ICON_BTN} {treeCollapsed ? '' : 'bg-[var(--wash-3)]! text-foreground!'}"
        >
          <FileTreeIcon size={15} strokeWidth={1.5} />
        </button>
      </span>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={treeCollapsed
          ? "Show file tree (⌥T)"
          : "Hide file tree (⌥T)"} />
      </TooltipUI.Root>
    {/if}

    <span class="desktop-only">
      <DiffTokenToggle {tokenHighlight} onToggle={onToggleTokenHighlight} shortcutHint="⌥H" />
    </span>

    {#if commentsCount > 0}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <span {...tooltipProps}
        class="inline-flex"
      >
        <!-- Pending comments are the one piece of unsent work in this pane, so the
             accent wash is persistent rather than hover/open-only. -->
        <button
          bind:this={commentsBtn}
          type="button"
          onclick={onToggleComments}
          class="no-drag inline-flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-(--solus-accent-light) px-2.5 text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border) pointer-coarse:h-10"
          aria-haspopup="dialog"
          aria-expanded={commentsOpen}
        >
          <ChatCircleTextIcon size={15} strokeWidth={1.5} />
          <span
            style="font-family:{MONO_FONT};font-size:var(--solus-font-ui-sm)"
            class="font-medium tabular-nums"
          >
            {commentsCount}
          </span>
        </button>
      </span>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={commentsOpen ? "Hide comments" : "Show all comments"} />
      </TooltipUI.Root>
    {/if}

  </div>
</div>

<style>
  /* A control strip sitting on the diff surface. Left padding clears the macOS
     traffic lights when the strip is the leftmost chrome (maximized diff pane).
     The trailing controls use the base gutter because pane chrome occupies its
     own row above. The hairline underneath separates the strip from the now-flat
     code surface, which no longer has washes of its own to divide the two. */
  /* Height is the workspace chrome row, not intrinsic content — the diff pane
     sits beside the tab strip and the two top rows have to share a baseline.
     Same token SidePanel.svelte uses. */
  .diff-toolbar {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-height: var(--solus-chrome-row-h, 2.5rem);
    padding-block: 0;
    /* The pane's floating chrome cluster (maximize / close) hovers over this
       same row at the top-right, so the trailing controls reserve its width —
       a flat gutter slid them underneath it. No-op where no pane publishes the
       inset (embedded diffs, mobile). */
    padding-right: max(0.75rem, var(--solus-pane-chrome-inset, 0px));
    padding-left: max(0.75rem, var(--solus-chrome-lead-inset, 0px));
    border-bottom: 0.0625rem solid
      color-mix(in srgb, var(--solus-container-border) 50%, transparent);
    flex-shrink: 0;
  }

  /* Second row under a host header (the PR review panel and page). Nothing here
     touches the window edge or the pane's floating chrome, so both safe-area
     gutters go, and the row sits below the chrome-row height it no longer has to
     share a baseline with. */
  .diff-toolbar.is-subrow {
    min-height: 2.25rem;
    padding-left: 0.75rem;
    padding-right: 0.75rem;
    /* No seam of its own: the host header above already rules off the chrome,
       and a second hairline a row below it reads as a stack of bands rather
       than one header over the change. */
    border-bottom: 0;
  }

  @media (max-width: 767px) {
    .diff-toolbar {
      gap: 0.5rem;
      padding-left: 0.5rem;
      padding-top: env(safe-area-inset-top, 0);
    }
    .diff-toolbar.is-subrow {
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
  }

  .toolbar-section {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .toolbar-left {
    flex: 1 1 0;
    min-width: 0;
    justify-content: flex-start;
  }
  .toolbar-center {
    flex: 0 1 auto;
    justify-content: center;
    min-width: 0;
  }
  .toolbar-right {
    flex: 1 1 0;
    min-width: 0;
    justify-content: flex-end;
    gap: 0.375rem;
  }

  .desktop-only {
    display: flex;
  }

  .mobile-only {
    display: none;
  }

  @media (max-width: 767px) {
    .desktop-only {
      display: none !important;
    }
    .mobile-only {
      display: inline-flex;
    }
  }

  .diff-stats {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    font-size: var(--solus-font-ui-sm);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* Segmented unified/split control. Sized to the icon actions beside it (1.625rem)
     so the whole right-hand cluster sits on one optical line. */
  /* The layout control reads as its own control, not the head of the icon
     run beside it. */
  .layout-toggle-slot {
    margin-right: 0.375rem;
  }

  .refresh-spin {
    animation: diff-refresh-spin 0.8s linear infinite;
  }
  @keyframes diff-refresh-spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .tabular-nums {
    font-variant-numeric: tabular-nums;
  }

  .turn-pills {
    display: flex;
    align-items: center;
    gap: 0.0625rem;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
  }
  .turn-pills::-webkit-scrollbar {
    display: none;
  }
  .turn-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    border-radius: 0.3125rem;
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition:
      color 120ms ease,
      background-color 120ms ease,
      transform 120ms ease;
  }
  /* Mobile tap-target expansion without changing visual size. */
  @media (pointer: coarse) {
    .turn-btn::before {
      content: "";
      position: absolute;
      inset: -0.625rem -0.125rem;
    }
  }
  .turn-btn:hover {
    color: var(--solus-text-secondary);
    background: var(--solus-surface-hover);
  }
  .turn-btn.has-changes:not(.is-active) {
    color: var(--solus-text-secondary);
  }
  .turn-btn.has-changes:not(.is-active) :global(svg) {
    color: var(--solus-status-complete);
    opacity: 0.86;
  }
  .turn-btn:active {
    transform: scale(0.96);
  }
  .turn-btn.is-active {
    color: var(--solus-text-primary);
    background: var(--solus-accent-light);
  }
  .turn-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }
  .turn-stepper {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.0625rem;
  }
  .turn-step-arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.3125rem;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      color 120ms ease,
      background-color 120ms ease;
  }
  .turn-step-arrow:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }
  .turn-step-arrow:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }
  .turn-current {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    border-radius: 0.3125rem;
    color: var(--solus-text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition:
      color 120ms ease,
      background-color 120ms ease;
  }
  .turn-current:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }
  .turn-current.is-active {
    color: var(--solus-text-primary);
    background: var(--solus-accent-light);
  }
  .turn-current:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }

  .turn-menu-scroll {
    max-height: 18rem;
    overflow-y: auto;
    padding-block: 0.25rem;
  }
  .turn-menu-stats {
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
