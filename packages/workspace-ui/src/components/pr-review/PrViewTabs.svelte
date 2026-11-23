<script lang="ts">
  import * as Tooltip from "../ui/tooltip";
  import type { ReviewGuideStatus } from "@solus/contracts/review";
  import type { LensTabState } from "../review/lib/lens-surface";
  import {
    LoaderCircle,
    CircleCheck,
    ClipboardCheck,
    TriangleAlert,
    ChevronDown as CaretDownIcon,
    Check as CheckIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { PAGE_PILL_GROUP } from "../../lib/page-chrome";
  /**
   * Which view of the change you are reading: Activity · Map · Guide · Lens · Diff.
   *
   * The page toolbar and the docked panel use the same view tabs.
   *
   * Where the five labels are wider than the row can spare, the group folds
   * into one switcher: the current view as a pill with a caret, and every
   * view in its menu. Both are always in the markup; the rung only decides
   * which one shows, so no tab is ever lost and the active one needs no
   * re-mount when the pane is dragged across the rung.
   *
   * The page toolbar has more room because the pull request number and pane
   * controls are in the row above.
   */
  let {
    tab,
    diffOpen,
    guideDisabled = false,
    guideStatus,
    guideDisabledReason,
    lensState = "absent",
    tabsDisabled = false,
    diffHint,
    changeCounts,
    home = "band",
    onSelect,
  }: {
    /** The content tab showing in this column, or `null` when the change has
     *  the column to itself — Diff is tracked separately because a page-shaped
     *  review keeps reading Activity while the diff sits in the pane beside it. */
    tab: "activity" | "map" | "guide" | "lens" | null;
    /** Whether the change is showing, wherever this surface puts it. */
    diffOpen: boolean;
    guideDisabled?: boolean;
    guideStatus?: ReviewGuideStatus;
    guideDisabledReason?: string;
    /** The Lens tab carries its own state, as Guide does. */
    lensState?: LensTabState;
    /** The host target is still loading, so revision-backed tabs are not ready. */
    tabsDisabled?: boolean;
    diffHint?: string;
    changeCounts?: { additions: number; deletions: number };
    /** Which row the group sits in, and so where it folds into the switcher. */
    home?: "band" | "toolbar";
    onSelect: (tab: "activity" | "map" | "guide" | "lens" | "diff") => void;
  } = $props();

  const changeCountsId = $props.id();

  const TABS = [
    { id: "activity" as const, label: "Activity" },
    { id: "map" as const, label: "Map" },
    { id: "guide" as const, label: "Guide" },
    { id: "lens" as const, label: "Lens" },
    { id: "diff" as const, label: "Diff" },
  ];

  type TabId = (typeof TABS)[number]["id"];

  function active(id: TabId): boolean {
    return id === "diff" ? diffOpen : tab === id;
  }
  function disabledFor(id: TabId): boolean {
    return (id === "guide" && guideDisabled) || (id !== "activity" && tabsDisabled);
  }
  function titleFor(id: TabId): string | undefined {
    return id === "guide" && guideDisabled
      ? guideDisabledReason
      : id !== "activity" && tabsDisabled
        ? "Loading PR details…"
        : id === "diff"
          ? diffHint
          : undefined;
  }

  /** The view the switcher names: the one showing, or Activity while the
   *  change has the column to itself with nothing behind it. */
  const current = $derived(TABS.find((t) => active(t.id)) ?? TABS[0]);
  let switcherOpen = $state(false);
  let switcherEl = $state<HTMLElement | null>(null);
</script>

<!-- The state glyphs Guide and Lens carry, the same in the row and the menu. -->
{#snippet tabGlyph(id: TabId)}
  {#if id === "guide"}
    {#if guideStatus === "queued" || guideStatus === "generating"}
      <LoaderCircle size={12} aria-hidden="true" class="animate-spin motion-reduce:animate-none" />
    {:else if guideStatus === "ready"}
      <CircleCheck size={13} aria-hidden="true" class="shrink-0 text-(--solus-status-complete)" />
    {:else if guideStatus === "outdated" || guideStatus === "failed" || guideStatus === "cancelled"}
      <ClipboardCheck size={15} aria-hidden="true" /><TriangleAlert size={10} aria-hidden="true" />
    {/if}
  {:else if id === "lens"}
    {#if lensState === "generating"}
      <LoaderCircle size={12} aria-hidden="true" class="animate-spin motion-reduce:animate-none" />
    {:else if lensState === "attention"}
      <TriangleAlert size={10} aria-hidden="true" />
    {/if}
  {/if}
{/snippet}

<div
  class="{PAGE_PILL_GROUP} {home === 'band'
    ? '@max-[54rem]/band:hidden'
    : '@max-[44rem]/band:hidden'}"
  role="tablist"
  aria-label="Pull request views"
>
  {#each TABS as t (t.id)}
    {@const isActive = active(t.id)}
    {@const isUnread = t.id === "lens" && lensState === "unread"}
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-label={t.id === "guide" && guideStatus ? `Guide: ${guideStatus}` : t.label}
      aria-describedby={t.id === "diff" && changeCounts ? changeCountsId : undefined}
      disabled={disabledFor(t.id)}
      title={titleFor(t.id)}
      class="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:tap-area {isActive
        ? 'bg-[var(--wash-2)] font-medium text-foreground'
        : isUnread
          ? 'bg-transparent font-medium text-(--success) hover:bg-[var(--wash-1)]'
          : 'bg-transparent font-normal text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground'}"
      onclick={() => onSelect(t.id)}
    >
      {t.label}
      {@render tabGlyph(t.id)}
      {#if t.id === "diff" && changeCounts}
        <span id={changeCountsId} class="sr-only">
          {changeCounts.additions} additions, {changeCounts.deletions} deletions
        </span>
        <span
          class="hidden items-center gap-1 font-mono font-normal tabular-nums @min-[68rem]/band:inline-flex"
          aria-hidden="true"
        >
          <span class="text-(--solus-diff-added-text-vivid)">+{changeCounts.additions}</span>
          <span class="text-(--solus-diff-removed-text-vivid)">−{changeCounts.deletions}</span>
        </span>
      {/if}
    </button>
  {/each}
</div>

<!-- The switcher: the active pill with a caret, standing in for the whole
     row under the home's rung. -->
<Tooltip.Root disabled={switcherOpen}>
  <Tooltip.Trigger
    bind:ref={switcherEl}
    type="button"
    class="no-drag hidden h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-background px-2.5 text-workspace-chrome font-medium text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] aria-expanded:bg-[var(--wash-1)] pointer-coarse:tap-area {home === 'band'
      ? '@max-[54rem]/band:inline-flex'
      : '@max-[44rem]/band:inline-flex'}"
    aria-label="Switch view"
    aria-haspopup="menu"
    aria-expanded={switcherOpen}
    onclick={() => (switcherOpen = !switcherOpen)}
  >
    {current.label}
    {@render tabGlyph(current.id)}
    <CaretDownIcon
      size={11}
      class="shrink-0 opacity-45 transition-transform duration-150 {switcherOpen ? 'rotate-180' : ''}"
      aria-hidden="true"
    />
  </Tooltip.Trigger>
  <Tooltip.Content side="bottom" value="Switch pull request view" />
</Tooltip.Root>

<DropdownMenu.Root bind:open={switcherOpen}>
  <DropdownMenu.Content
    customAnchor={switcherEl}
    side="bottom"
    align="start"
    sideOffset={6}
    collisionPadding={8}
    class="w-[min(14rem,calc(100vw-2rem))] [&_.menu-row]:text-workspace-chrome"
    aria-label="Pull request views"
    onInteractOutside={(event) => {
      if (switcherEl?.contains(event.target as Node)) event.preventDefault();
    }}
  >
    {#each TABS as t (t.id)}
      {@const isActive = active(t.id)}
      <DropdownMenu.Item
        data-menu-current={isActive ? "" : undefined}
        disabled={disabledFor(t.id)}
        title={titleFor(t.id)}
        onSelect={() => {
          switcherOpen = false;
          onSelect(t.id);
          requestInputFocus();
        }}
      >
        <span class="flex min-w-0 flex-1 items-center gap-1.5 {isActive ? 'font-medium text-foreground' : ''}">
          {t.label}
          {@render tabGlyph(t.id)}
        </span>
        {#if isActive}
          <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" aria-hidden="true" />
        {/if}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
