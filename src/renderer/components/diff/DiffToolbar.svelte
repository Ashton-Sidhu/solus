<script module lang="ts">
  export interface HeaderStats {
    files: number;
    additions: number;
    deletions: number;
  }
</script>

<script lang="ts">
  import {
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
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { MONO_FONT } from "../../lib/diffTheme";
  import type { TurnSnapshot } from "../../../shared/types";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";

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
            <StackIcon size={11} weight="bold" />
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
            <CaretLeftIcon size={10} weight="bold" />
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
            <CaretDownIcon size={9} weight="bold" />
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
            <CaretRightIcon size={10} weight="bold" />
          </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={"Next turn (⌥→)"} />
          </TooltipUI.Root>

          <DropdownMenu.Root bind:open={turnMenuOpen}>
            <DropdownMenu.Content customAnchor={turnTriggerEl} side="top" align="start" sideOffset={6} class="w-[176px]">
            <div class="turn-menu-scroll">
              <DropdownMenu.Item
                class={selectedTurnIndex === null ? "font-semibold" : undefined}
                onSelect={() => {
                  turnMenuOpen = false;
                  onTurnSelect(null);
                }}
              >
                <StackIcon size={11} weight="bold" />
                All changes
              </DropdownMenu.Item>
              {#each turns as turn (turn.index)}
                <DropdownMenu.Item
                  class={selectedTurnIndex === turn.index ? "font-semibold" : undefined}
                  onSelect={() => {
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
            <StackIcon size={11} weight="bold" />
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
                size={11}
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

  <!-- Right section -->
  <div class="toolbar-section toolbar-right">
    {#if filesCount > 0}
      <Button
        variant="secondary"
        size="default"
        type="button"
        onclick={onOpenFiles}
        class="hidden max-md:flex shrink-0 font-secondary text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
        aria-label="Browse changed files"
      >
        <SidebarSimpleIcon size={14} weight="bold" />
        <span class="tabular-nums">{filesCount}</span>
      </Button>
    {/if}

    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <span {...tooltipProps} class="inline-flex">
      <Button
        variant="ghost"
        size="icon"
        type="button"
        onclick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh diff"
        class="rounded [&_svg:not([class*='size-'])]:size-3 text-(--solus-text-tertiary) pointer-coarse:size-10"
      >
        <span class="flex" class:refresh-spin={refreshing}>
          <ArrowClockwiseIcon size={12} weight="bold" />
        </span>
      </Button>
    </span>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={"Refresh diff (⌥R)"} />
    </TooltipUI.Root>

    {#if filesCount > 0}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <span {...tooltipProps}
        class="desktop-only"
      >
        <Button
          variant="ghost"
          size="icon"
          type="button"
          onclick={onToggleCollapseAll}
          aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
          class="rounded [&_svg:not([class*='size-'])]:size-3 text-(--solus-text-tertiary) pointer-coarse:size-10"
        >
          {#if allCollapsed}
            <ArrowsOutLineVerticalIcon size={12} weight="bold" />
          {:else}
            <ArrowsInLineVerticalIcon size={12} weight="bold" />
          {/if}
        </Button>
      </span>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={allCollapsed ? "Expand all files" : "Collapse all files"} />
      </TooltipUI.Root>
    {/if}

    {#if filesCount > 0}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <span {...tooltipProps}
        class="desktop-only"
      >
        <Button
          variant="ghost"
          size="icon"
          type="button"
          onclick={onToggleTree}
          aria-label={treeCollapsed ? "Show file tree" : "Hide file tree"}
          class="rounded [&_svg:not([class*='size-'])]:size-3 pointer-coarse:size-10 {!treeCollapsed
            ? 'bg-(--solus-accent-light) text-(--solus-accent) hover:bg-(--solus-accent-light) dark:hover:bg-(--solus-accent-light) hover:text-(--solus-accent)'
            : 'text-(--solus-text-tertiary)'}"
        >
          <SidebarSimpleIcon size={11} weight="bold" />
        </Button>
      </span>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={treeCollapsed
          ? "Show file tree (⌥T)"
          : "Hide file tree (⌥T)"} />
      </TooltipUI.Root>
    {/if}

    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <span {...tooltipProps}
      class="inline-flex"
    >
      <Button
        variant="ghost"
        size="icon"
        type="button"
        onclick={() => onSetStyle(diffStyle === "split" ? "unified" : "split")}
        aria-label={diffStyle === "split"
          ? "Switch to unified view"
          : "Switch to split view"}
        class="rounded [&_svg:not([class*='size-'])]:size-3 pointer-coarse:size-10 {diffStyle === 'split'
          ? 'bg-(--solus-accent-light) text-(--solus-accent) hover:bg-(--solus-accent-light) dark:hover:bg-(--solus-accent-light) hover:text-(--solus-accent)'
          : 'text-(--solus-text-tertiary)'}"
      >
        <ColumnsIcon
          size={12}
          weight={diffStyle === "split" ? "fill" : "regular"}
        />
      </Button>
    </span>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={diffStyle === "split"
        ? "Unified view (⌥V)"
        : "Split view (⌥V)"} />
    </TooltipUI.Root>

    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <span {...tooltipProps}
      class="desktop-only"
    >
      <Button
        variant="ghost"
        size="icon"
        type="button"
        onclick={onToggleTokenHighlight}
        aria-label={tokenHighlight
          ? "Disable token highlighting"
          : "Enable token highlighting"}
        aria-pressed={tokenHighlight}
        class="rounded [&_svg:not([class*='size-'])]:size-3 pointer-coarse:size-10 {tokenHighlight
          ? 'bg-(--solus-accent-light) text-(--solus-accent) hover:bg-(--solus-accent-light) dark:hover:bg-(--solus-accent-light) hover:text-(--solus-accent)'
          : 'text-(--solus-text-tertiary)'}"
      >
        <HighlighterIcon
          size={12}
          weight={tokenHighlight ? "fill" : "regular"}
        />
      </Button>
    </span>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={tokenHighlight
        ? "Token highlighting on (⌥H)"
        : "Token highlighting off (⌥H)"} />
    </TooltipUI.Root>

    {#if commentsCount > 0}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <span {...tooltipProps}
        class="inline-flex"
      >
        <Button
          bind:ref={commentsBtn}
          variant="ghost"
          size="default"
          type="button"
          onclick={onToggleComments}
          class="rounded [&_svg:not([class*='size-'])]:size-3 gap-1 px-1 text-(--solus-accent) hover:text-(--solus-accent) pointer-coarse:h-10 {commentsOpen
            ? 'bg-(--solus-accent-light) hover:bg-(--solus-accent-light) dark:hover:bg-(--solus-accent-light)'
            : ''}"
          aria-haspopup="dialog"
          aria-expanded={commentsOpen}
        >
          <ChatCircleTextIcon size={12} weight="fill" />
          <span
            style="font-size:var(--solus-font-ui-sm);font-variant-numeric:tabular-nums"
            class="font-semibold"
          >
            {commentsCount}
          </span>
        </Button>
      </span>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={commentsOpen ? "Hide comments" : "Show all comments"} />
      </TooltipUI.Root>
    {/if}

  </div>
</div>

<style>
  /* A borderless control strip sitting on the diff surface — not a chrome row.
     Left padding clears the macOS traffic lights when the strip is the leftmost
     chrome (maximized diff pane); the right gutter clears the pane's floating
     chrome cluster. Both collapse to the base 0.75rem otherwise. */
  .diff-toolbar {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding-block: 0.4375rem;
    padding-right: max(0.75rem, var(--solus-pane-chrome-inset, 0px));
    padding-left: max(0.75rem, var(--solus-chrome-lead-inset, 0px));
    flex-shrink: 0;
  }

  @media (max-width: 767px) {
    .diff-toolbar {
      gap: 0.5rem;
      padding-left: 0.5rem;
      padding-top: max(0.4375rem, env(safe-area-inset-top, 0));
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

  .desktop-only {
    display: flex;
  }

  @media (max-width: 767px) {
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
