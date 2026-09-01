<script lang="ts">
  import {
    Columns2 as ColumnsIcon,
    Ellipsis as DotsThreeIcon,
    GitCompareArrows as CompareIcon,
    Highlighter as HighlighterIcon,
    PenLine as RewriteIcon,
    PanelLeft as SidebarSimpleIcon,
    RotateCw as ArrowClockwiseIcon,
    Rows3 as StackedIcon,
    Shrink as ArrowsInLineVerticalIcon,
    Expand as ArrowsOutLineVerticalIcon,
  } from "@lucide/svelte";
  import type { ReviewView } from "../../contexts/workspace/routing/route-registry";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import type { GuideHeaderActions } from "./lib/review-header";

  /**
   * Everything the review panel's active view can be *configured* to do.
   *
   * The band above holds navigation and state — where you are, what changed,
   * which turn — and nothing else. Layout, the file tree, collapse state and
   * token highlighting are settings for one view, used once and then
   * remembered, so they live under a single trigger whose contents follow the
   * active tab rather than each claiming a permanent slot in the chrome.
   *
   * The menu is contextual; the band is not. The trigger is absent when the
   * active view has no commands to offer.
   */
  let {
    view,
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
    hasFiles,
    guide,
  }: {
    view: ReviewView;
    diffStyle: "unified" | "split";
    onSetStyle: (style: "unified" | "split") => void;
    tokenHighlight: boolean;
    onToggleTokenHighlight: () => void;
    allCollapsed: boolean;
    onToggleCollapseAll: () => void;
    treeCollapsed: boolean;
    onToggleTree: () => void;
    onRefresh?: () => void;
    refreshing: boolean;
    /** Stream-shaped rows only mean something once the patch has files. */
    hasFiles: boolean;
    /** Absent where the host has no guide to rewrite. */
    guide?: GuideHeaderActions;
  } = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  /** The guide row is the only contextual row that can carry news. When it
   *  does, the trigger says so at rest — a dot, not a banner and not a slot
   *  that appears and pushes the band around. */
  const showsGuideRow = $derived(view === "guide" && !!guide?.present);
  const flagsStale = $derived(showsGuideRow && !!guide?.stale);
  const hasItems = $derived(
    view === "diff" ||
      (showsGuideRow && !!guide) ||
      !!onRefresh,
  );

  /** Names the tab the menu belongs to — this is how the menu declares that it
   *  is contextual rather than a panel-wide "more" list. */
  const heading = $derived(
    view === "map" ? "Change map" : view === "guide" ? "Walkthrough" : "Diff view",
  );

  /** The icon says what each layout does to the lines: one column of them, or
   *  two. The label alone made a reader remember which word meant which. */
  const styleOptions = [
    { value: "unified" as const, label: "Unified", icon: StackedIcon },
    { value: "split" as const, label: "Split", icon: ColumnsIcon },
  ];
</script>

{#if hasItems}
  <button
    bind:this={triggerEl}
    type="button"
    class="no-drag relative inline-flex size-[1.625rem] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 transition-[background-color,color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-11 {open
      ? 'bg-[var(--wash-3)] text-foreground'
      : 'bg-transparent text-muted-foreground hover:bg-[var(--wash-3)] hover:text-foreground'}"
    aria-label={flagsStale ? "More review options — new commits since guide" : "More review options"}
    aria-haspopup="menu"
    aria-expanded={open}
    title={flagsStale ? "New commits since guide" : "More options"}
    onclick={() => (open = !open)}
  >
    <DotsThreeIcon size={15} />
    {#if flagsStale}
      <span
        class="absolute top-[0.1875rem] right-[0.1875rem] size-[0.3125rem] rounded-full bg-primary"
        aria-hidden="true"
      ></span>
    {/if}
  </button>

  <DropdownMenu.Root bind:open>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[min(18rem,calc(100vw-2rem))]"
  >
    <!-- Labels stay on one line — a menu row is a fixed 32px, so a label that
         wraps overflows its own row instead of growing it. -->
    <DropdownMenu.Label>{heading}</DropdownMenu.Label>

    {#if view === "diff"}
      <!-- Layout is a choice between two states, and a menu already has a form
           for that: two rows, one of them checked. The segmented control that
           used to sit here was a second control language inside a list of rows,
           it pinned its own type size, and its track read as a widget dropped
           into the menu rather than part of it. -->
      <DropdownMenu.RadioGroup value={diffStyle}>
        {#each styleOptions as option (option.value)}
          <DropdownMenu.RadioItem
            value={option.value}
            onSelect={() => onSetStyle(option.value)}
          >
            <option.icon size={14} />
            <span class="whitespace-nowrap">{option.label}</span>
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>

      <!-- Only when a command follows: a rule under the last row is a divider
           that divides nothing. -->
      {#if onRefresh || hasFiles}
        <DropdownMenu.Separator />
      {/if}
    {/if}

    {#if showsGuideRow && guide && guide.stale && !guide.regenerating}
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger>
          <CompareIcon size={14} />
          <span class="whitespace-nowrap">New commits since guide</span>
          <span class="ml-auto size-[0.3125rem] shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class="w-auto min-w-52">
          <DropdownMenu.Item onSelect={() => guide.onRegenerate("new-commits")}>
            <CompareIcon size={14} />
            <span class="whitespace-nowrap">Review new commits only</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => guide.onRegenerate("full")}>
            <RewriteIcon size={14} />
            <span class="whitespace-nowrap">Regenerate full guide</span>
          </DropdownMenu.Item>
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    {:else if showsGuideRow && guide}
      <!-- The guide's own state and the one action it implies. Stale is the
           news, so the row says what happened rather than naming the command. -->
      <DropdownMenu.Item
        disabled={guide.regenerating}
        onSelect={() => guide.onRegenerate("full")}
      >
        <RewriteIcon size={14} />
        <span class="whitespace-nowrap">
          {guide.regenerating ? "Regenerating…" : "Regenerate guide"}
        </span>
      </DropdownMenu.Item>
    {/if}

    {#if onRefresh}
      <DropdownMenu.Item disabled={refreshing} onSelect={onRefresh}>
        <ArrowClockwiseIcon size={14} class={refreshing ? "animate-spin [animation-duration:0.8s]" : ""} />
        <span class="whitespace-nowrap">{refreshing ? "Refreshing…" : "Refresh diff"}</span>
        <DropdownMenu.Shortcut>{comboHint("diff-panel.refresh")}</DropdownMenu.Shortcut>
      </DropdownMenu.Item>
    {/if}

    {#if view === "diff" && hasFiles}
      <DropdownMenu.Item onSelect={onToggleTree}>
        <SidebarSimpleIcon size={14} />
        <span class="whitespace-nowrap">{treeCollapsed ? "Show file tree" : "Hide file tree"}</span>
        <DropdownMenu.Shortcut>{comboHint("diff-panel.toggle-tree")}</DropdownMenu.Shortcut>
      </DropdownMenu.Item>

      <DropdownMenu.Item onSelect={onToggleCollapseAll}>
        {#if allCollapsed}
          <ArrowsOutLineVerticalIcon size={14} />
          <span class="whitespace-nowrap">Expand all files</span>
        {:else}
          <ArrowsInLineVerticalIcon size={14} />
          <span class="whitespace-nowrap">Collapse all files</span>
        {/if}
      </DropdownMenu.Item>

      <DropdownMenu.Item onSelect={onToggleTokenHighlight}>
        <HighlighterIcon size={14} />
        <span class="whitespace-nowrap">
          {tokenHighlight ? "Turn off token highlighting" : "Turn on token highlighting"}
        </span>
        <DropdownMenu.Shortcut>{comboHint("diff-panel.toggle-token-hl")}</DropdownMenu.Shortcut>
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
