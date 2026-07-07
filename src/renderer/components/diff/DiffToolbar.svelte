<script module lang="ts">
  export interface HeaderStats {
    files: number;
    additions: number;
    deletions: number;
  }
</script>

<script lang="ts">
  import {
    XIcon,
    ArrowsOutIcon,
    ArrowsInIcon,
    GitBranchIcon,
    GitCommitIcon,
    StackIcon,
    ChatCircleTextIcon,
    SidebarSimpleIcon,
    CaretLeftIcon,
    CaretRightIcon,
    CaretDownIcon,
    CaretUpIcon,
    ColumnsIcon,
    HighlighterIcon,
    ArrowClockwiseIcon,
    ArrowsInLineVerticalIcon,
    ArrowsOutLineVerticalIcon,
  } from "phosphor-svelte";
  import { tooltip } from "../../lib/tooltip";
  import { MONO_FONT } from "../../lib/diffTheme";
  import type { TurnSnapshot } from "../../../shared/types";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";

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
    maximized: boolean;
    onToggleMaximize: (() => void) | null;
    onClose: () => void;
    commentsAnchorRef?: (el: HTMLButtonElement | null) => void;
    turns: TurnSnapshot[];
    selectedTurnIndex: number | null;
    onTurnSelect: (index: number | null) => void;
    onStepTurn: (dir: 1 | -1) => void;
    turnRunning?: boolean;
    mode?: "session" | "working-tree";
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
    maximized,
    onToggleMaximize,
    onClose,
    commentsAnchorRef,
    turns,
    selectedTurnIndex,
    onTurnSelect,
    onStepTurn,
    turnRunning = false,
    mode = "session",
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

<div class="diff-toolbar" data-testid="diff-toolbar">
  <!-- Mobile: back button -->
  <button
    type="button"
    onclick={onClose}
    aria-label="Close diff panel"
    class="mobile-back-btn mobile-only"
  >
    <CaretLeftIcon size={16} weight="bold" />
    <span class="text-[0.8125rem] font-semibold text-(--solus-text-primary)"
      >Changes</span
    >
  </button>

  <!-- Left section -->
  <div class="toolbar-section toolbar-left">
    <div class="flex items-center gap-1 min-w-0 shrink desktop-only">
      <GitBranchIcon
        size={10}
        class="text-(--solus-text-tertiary) flex-shrink-0"
        weight="bold"
      />
      {#if mode === "working-tree"}
        <span
          class="text-[0.6875rem] font-medium truncate text-(--solus-text-primary)"
          style="font-family:{MONO_FONT}"
        >
          Working tree
        </span>
      {:else if isWorktree}
        <span
          class="text-[0.6875rem] font-medium truncate text-(--solus-text-primary)"
          style="font-family:{MONO_FONT}"
        >
          {worktreeBranch}
        </span>
        <span
          class="text-[0.625rem] text-(--solus-text-tertiary) flex-shrink-0"
          style="font-family:{MONO_FONT}"
        >
          →&nbsp;{targetBranch}
        </span>
      {:else if fallbackBranch}
        <span
          class="text-[0.6875rem] font-medium text-(--solus-text-primary) truncate"
          style="font-family:{MONO_FONT}"
        >
          {fallbackBranch}
        </span>
      {/if}
    </div>

    {#if headerStats}
      <!-- Stats are passive text. Navigation lives in the dedicated jump
           controls on the right (the old clickable stats read as plain text). -->
      <div class="diff-stats" style="font-variant-numeric:tabular-nums">
        <span class="text-(--solus-text-tertiary)">
          {headerStats.files}
          {headerStats.files === 1 ? "file" : "files"}
        </span>
        <span style="color:var(--solus-status-complete)" class="font-medium"
          >+{headerStats.additions}</span
        >
        <span style="color:var(--solus-status-error)" class="font-medium"
          >−{headerStats.deletions}</span
        >
      </div>
    {/if}
  </div>

  <!-- Center section: turn pills / stepper -->
  {#if showTurns}
    <div class="toolbar-section toolbar-center">
      {#if compactTurns}
        <div class="turn-stepper">
          <button
            type="button"
            class="turn-btn"
            class:is-active={selectedTurnIndex === null}
            onclick={() => onTurnSelect(null)}
            use:tooltip={"All changes"}
            aria-label="Show all changes"
            aria-pressed={selectedTurnIndex === null}
          >
            <StackIcon size={11} weight="bold" />
          </button>
          <button
            type="button"
            class="turn-step-arrow"
            onclick={() => onStepTurn(-1)}
            aria-label="Previous turn"
            use:tooltip={"Previous turn (⌥←)"}
          >
            <CaretLeftIcon size={10} weight="bold" />
          </button>
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
            <CaretDownIcon size={9} weight="bold" />
          </button>
          <button
            type="button"
            class="turn-step-arrow"
            onclick={() => onStepTurn(1)}
            aria-label="Next turn"
            use:tooltip={"Next turn (⌥→)"}
          >
            <CaretRightIcon size={10} weight="bold" />
          </button>

          <Dropdown
            bind:open={turnMenuOpen}
            triggerEl={turnTriggerEl}
            align="top"
            anchor="left"
            width={176}
          >
            <div class="turn-menu-scroll">
              <DropdownItem
                selected={selectedTurnIndex === null}
                onclick={() => {
                  turnMenuOpen = false;
                  onTurnSelect(null);
                }}
              >
                <StackIcon size={11} weight="bold" />
                All changes
              </DropdownItem>
              {#each turns as turn (turn.index)}
                <DropdownItem
                  selected={selectedTurnIndex === turn.index}
                  onclick={() => {
                    turnMenuOpen = false;
                    onTurnSelect(turn.index);
                  }}
                >
                  <GitCommitIcon
                    size={11}
                    weight={turnRunning && turn.index === lastTurnIndex
                      ? "fill"
                      : "regular"}
                    color={turn.filesChanged > 0 &&
                    selectedTurnIndex !== turn.index
                      ? "var(--solus-status-complete)"
                      : undefined}
                  />
                  <span>Turn {turn.index + 1}</span>
                  {#snippet trailing()}
                    <span class="turn-menu-stats"
                      >+{turn.additions} −{turn.deletions}</span
                    >
                  {/snippet}
                </DropdownItem>
              {/each}
            </div>
          </Dropdown>
        </div>
      {:else}
        <div class="turn-pills">
          <button
            type="button"
            class="turn-btn"
            class:is-active={selectedTurnIndex === null}
            onclick={() => onTurnSelect(null)}
            use:tooltip={"All changes"}
            aria-label="Show all changes"
            aria-pressed={selectedTurnIndex === null}
          >
            <StackIcon size={11} weight="bold" />
          </button>
          {#each turns as turn (turn.index)}
            <button
              type="button"
              class="turn-btn"
              class:is-active={selectedTurnIndex === turn.index}
              class:has-changes={turn.filesChanged > 0}
              onclick={() => onTurnSelect(turn.index)}
              use:tooltip={turnTooltipFor(turn)}
              aria-label={`Show turn ${turn.index + 1}`}
              aria-pressed={selectedTurnIndex === turn.index}
            >
              <GitCommitIcon
                size={11}
                weight={turnRunning && turn.index === lastTurnIndex
                  ? "fill"
                  : "regular"}
              />
              <span>{turn.index + 1}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="flex-1 desktop-only"></div>
  {/if}

  <!-- Right section -->
  <div class="toolbar-section toolbar-right">
    {#if filesCount > 0}
      <button
        type="button"
        onclick={onOpenFiles}
        class="mobile-files-btn mobile-only"
        aria-label="Browse changed files"
      >
        <SidebarSimpleIcon size={14} weight="bold" />
        <span class="tabular-nums">{filesCount}</span>
      </button>
    {/if}

    <button
      type="button"
      onclick={onRefresh}
      disabled={refreshing}
      aria-label="Refresh diff"
      class="ghost-btn flex items-center justify-center rounded"
      style="width:var(--solus-tap-target);height:var(--solus-tap-target)"
      use:tooltip={"Refresh diff (⌥R)"}
    >
      <span class="flex" class:refresh-spin={refreshing}>
        <ArrowClockwiseIcon size={12} weight="bold" />
      </span>
    </button>

    {#if filesCount > 0}
      <button
        type="button"
        onclick={onToggleCollapseAll}
        aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
        class="ghost-btn flex items-center justify-center rounded desktop-only"
        style="width:var(--solus-tap-target);height:var(--solus-tap-target)"
        use:tooltip={allCollapsed ? "Expand all files" : "Collapse all files"}
      >
        {#if allCollapsed}
          <ArrowsOutLineVerticalIcon size={12} weight="bold" />
        {:else}
          <ArrowsInLineVerticalIcon size={12} weight="bold" />
        {/if}
      </button>
    {/if}

    {#if filesCount > 0}
      <button
        type="button"
        onclick={onToggleTree}
        aria-label={treeCollapsed ? "Show file tree" : "Hide file tree"}
        class="ghost-btn flex items-center justify-center rounded desktop-only"
        style="width:var(--solus-tap-target);height:var(--solus-tap-target)"
        class:is-active={!treeCollapsed}
        use:tooltip={treeCollapsed
          ? "Show file tree (⌥T)"
          : "Hide file tree (⌥T)"}
      >
        <SidebarSimpleIcon size={11} weight="bold" />
      </button>
    {/if}

    <button
      type="button"
      onclick={() => onSetStyle(diffStyle === "split" ? "unified" : "split")}
      aria-label={diffStyle === "split"
        ? "Switch to unified view"
        : "Switch to split view"}
      class="ghost-btn flex items-center justify-center rounded"
      style="width:var(--solus-tap-target);height:var(--solus-tap-target)"
      class:is-active={diffStyle === "split"}
      use:tooltip={diffStyle === "split"
        ? "Unified view (⌥V)"
        : "Split view (⌥V)"}
    >
      <ColumnsIcon
        size={12}
        weight={diffStyle === "split" ? "fill" : "regular"}
      />
    </button>

    <button
      type="button"
      onclick={onToggleTokenHighlight}
      aria-label={tokenHighlight
        ? "Disable token highlighting"
        : "Enable token highlighting"}
      aria-pressed={tokenHighlight}
      class="ghost-btn flex items-center justify-center rounded desktop-only"
      style="width:var(--solus-tap-target);height:var(--solus-tap-target)"
      class:is-active={tokenHighlight}
      use:tooltip={tokenHighlight
        ? "Token highlighting on (⌥H)"
        : "Token highlighting off (⌥H)"}
    >
      <HighlighterIcon
        size={12}
        weight={tokenHighlight ? "fill" : "regular"}
      />
    </button>

    {#if commentsCount > 0}
      <button
        bind:this={commentsBtn}
        type="button"
        onclick={onToggleComments}
        class="ghost-btn inline-flex items-center gap-1 rounded"
        style="height:var(--solus-tap-target)"
        class:is-active={commentsOpen}
        style:color="var(--solus-accent)"
        aria-haspopup="dialog"
        aria-expanded={commentsOpen}
        use:tooltip={commentsOpen ? "Hide comments" : "Show all comments"}
      >
        <ChatCircleTextIcon size={12} weight="fill" />
        <span
          style="font-size:var(--solus-font-ui-sm);font-variant-numeric:tabular-nums"
          class="font-semibold"
        >
          {commentsCount}
        </span>
      </button>
    {/if}

    {#if onToggleMaximize}
      <button
        type="button"
        onclick={onToggleMaximize}
        aria-label={maximized ? "Restore panel size" : "Maximize panel"}
        class="ghost-btn flex items-center justify-center rounded desktop-only"
        style="width:var(--solus-tap-target);height:var(--solus-tap-target)"
        use:tooltip={maximized ? "Restore panel (⌥M)" : "Maximize (⌥M)"}
      >
        {#if maximized}
          <ArrowsInIcon size={12} />
        {:else}
          <ArrowsOutIcon size={12} />
        {/if}
      </button>
    {/if}

    <button
      type="button"
      onclick={onClose}
      aria-label="Close diff panel"
      class="ghost-btn flex items-center justify-center rounded desktop-only"
      style="width:var(--solus-tap-target);height:var(--solus-tap-target)"
      use:tooltip={"Close (Esc)"}
    >
      <XIcon size={12} />
    </button>
  </div>
</div>

<style>
  .diff-toolbar {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding-right: 0.75rem;
    /* Left padding clears the macOS traffic lights when this toolbar is the
       leftmost chrome (maximized diff pane); collapses to the normal 0.75rem
       otherwise and off-mac (lead inset is 0 there). */
    padding-left: max(0.75rem, var(--solus-chrome-lead-inset, 0px));
    /* In the editor's secondary pane the toolbar shares the tab strip's chrome
       row — match its height and seam so they read as one continuous bar. */
    height: var(--solus-chrome-row-h, var(--solus-tap-target-lg));
    flex-shrink: 0;
    border-bottom: 0.0625rem solid var(--solus-chrome-row-border, var(--solus-container-border));
  }

  @media (max-width: 767px) {
    .diff-toolbar {
      gap: 0.5rem;
      padding-inline: 0.5rem;
      padding-top: max(0, env(safe-area-inset-top, 0));
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
    gap: 0.125rem;
  }

  .mobile-only {
    display: none;
  }
  .desktop-only {
    display: flex;
  }

  @media (max-width: 767px) {
    .mobile-only {
      display: flex;
    }
    .desktop-only {
      display: none !important;
    }
  }

  .diff-stats {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    font-size: var(--solus-font-ui-sm);
    flex-shrink: 0;
  }

  .ghost-btn {
    color: var(--solus-text-tertiary);
    transition:
      color 120ms ease,
      background-color 120ms ease,
      transform 120ms ease;
    cursor: pointer;
    padding-inline: 0.25rem;
  }
  .ghost-btn:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }
  .ghost-btn:active {
    transform: scale(0.96);
  }
  .ghost-btn.is-active {
    color: var(--solus-accent);
    background: var(--solus-accent-light);
  }
  .ghost-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
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

  .mobile-files-btn {
    align-items: center;
    gap: 0.25rem;
    height: 2rem;
    padding: 0 0.625rem;
    border-radius: 0.5rem;
    background: var(--solus-surface-hover);
    border: none;
    color: var(--solus-text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
    flex-shrink: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .mobile-files-btn:active {
    background: var(--solus-surface-active);
  }
  .tabular-nums {
    font-variant-numeric: tabular-nums;
  }

  .mobile-back-btn {
    align-items: center;
    gap: 0.25rem;
    min-height: 2.25rem;
    padding: 0 0.5rem 0 0.25rem;
    border-radius: 0.5rem;
    background: transparent;
    border: none;
    color: var(--solus-accent);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s ease;
    -webkit-tap-highlight-color: transparent;
  }
  .mobile-back-btn:active {
    background: var(--solus-surface-hover);
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
    font-size: 0.625rem;
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
    font-size: 0.625rem;
    font-weight: 600;
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
    scrollbar-width: thin;
  }
  .turn-menu-stats {
    color: var(--solus-text-tertiary);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }
</style>
