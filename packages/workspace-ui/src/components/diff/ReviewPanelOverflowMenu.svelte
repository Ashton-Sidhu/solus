<script lang="ts">
  import {
    Ellipsis as DotsThreeIcon,
    Highlighter as HighlighterIcon,
    PenLine as RewriteIcon,
    PanelLeft as SidebarSimpleIcon,
    RotateCw as ArrowClockwiseIcon,
    Shrink as ArrowsInLineVerticalIcon,
    Expand as ArrowsOutLineVerticalIcon,
  } from "@lucide/svelte";
  import type { ReviewView } from "../../contexts/workspace/routing/route-registry";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
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
   * The menu is contextual; the band is not. It is never empty: Refresh is on
   * every view, because every view reads the same patch.
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
    onRefresh: () => void;
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

  /** Names the tab the menu belongs to — this is how the menu declares that it
   *  is contextual rather than a panel-wide "more" list. */
  const heading = $derived(
    view === "map" ? "Change map" : view === "guide" ? "Walkthrough" : "Diff view",
  );

  const styleOptions = [
    { value: "unified" as const, label: "Unified" },
    { value: "split" as const, label: "Split" },
  ];
</script>

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
    class="w-[min(15rem,calc(100vw-2rem))]"
  >
    <DropdownMenu.Label>{heading}</DropdownMenu.Label>

    {#if view === "diff"}
      <!-- Layout is a state, not a command, so it does not wear a menu row. -->
      <div class="flex justify-center px-1.5 pb-1.5">
        <SegmentedControl
          options={styleOptions}
          isActive={(value) => diffStyle === value}
          onSelect={onSetStyle}
          ariaLabel="Diff layout"
        />
      </div>
    {/if}

    {#if showsGuideRow && guide}
      <!-- The guide's own state and the one action it implies. Stale is the
           news, so the row says what happened rather than naming the command. -->
      <DropdownMenu.Item disabled={guide.regenerating} onSelect={guide.onRegenerate}>
        <RewriteIcon size={14} />
        {guide.regenerating
          ? "Regenerating…"
          : guide.stale
            ? "New commits since guide"
            : "Regenerate guide"}
        {#if guide.stale && !guide.regenerating}
          <span class="ml-auto size-[0.3125rem] shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
        {/if}
      </DropdownMenu.Item>
    {/if}

    <DropdownMenu.Item disabled={refreshing} onSelect={onRefresh}>
      <ArrowClockwiseIcon size={14} class={refreshing ? "animate-spin [animation-duration:0.8s]" : ""} />
      {refreshing ? "Refreshing…" : "Refresh diff"}
      <DropdownMenu.Shortcut>{comboHint("diff-panel.refresh")}</DropdownMenu.Shortcut>
    </DropdownMenu.Item>

    {#if view === "diff" && hasFiles}
      <DropdownMenu.Item onSelect={onToggleTree}>
        <SidebarSimpleIcon size={14} />
        {treeCollapsed ? "Show file tree" : "Hide file tree"}
        <DropdownMenu.Shortcut>{comboHint("diff-panel.toggle-tree")}</DropdownMenu.Shortcut>
      </DropdownMenu.Item>

      <DropdownMenu.Item onSelect={onToggleCollapseAll}>
        {#if allCollapsed}
          <ArrowsOutLineVerticalIcon size={14} />
          Expand all files
        {:else}
          <ArrowsInLineVerticalIcon size={14} />
          Collapse all files
        {/if}
      </DropdownMenu.Item>

      <DropdownMenu.Item onSelect={onToggleTokenHighlight}>
        <HighlighterIcon size={14} />
        {tokenHighlight ? "Turn off token highlighting" : "Turn on token highlighting"}
        <DropdownMenu.Shortcut>{comboHint("diff-panel.toggle-token-hl")}</DropdownMenu.Shortcut>
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
