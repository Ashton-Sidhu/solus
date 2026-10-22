<script lang="ts">
  import type { ReviewGuideStatus } from "@solus/contracts/review";
  import type { LensTabState } from "../review/lib/lens-surface";
  import {
    LoaderCircle,
    CircleCheck,
    BookOpen,
    TriangleAlert,
    ChevronDown as CaretDownIcon,
    Check as CheckIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { requestInputFocus } from "../../lib/inputFocus";
  /**
   * Which view of the change you are reading: Activity · Map · Guide · Lens · Diff.
   *
   * Its own component because it has two homes — inside the masthead when the
   * review is a page (where it belongs to the content beneath it), and in the
   * panel's chrome row when the review is docked beside the list (where the
   * content is too short to carry a row of its own).
   *
   * Where the five labels are wider than the row can spare, the group folds
   * into one switcher: the current view as a pill with a caret, and every
   * view in its menu. Both are always in the markup; the rung only decides
   * which one shows, so no tab is ever lost and the active one needs no
   * re-mount when the pane is dragged across the rung.
   *
   * The rung is the home's. The panel band shares the row with the number,
   * four verbs, the overflow, and the pane controls — about 22rem before a
   * single tab — so there the group folds at 48rem, under the 52rem where
   * the verbs drop their labels. The masthead's row holds only the identity
   * link, which truncates, so the group keeps its labels down to 30rem.
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
    /** Which row the group sits in, and so where it folds into the switcher. */
    home?: "band" | "masthead";
    onSelect: (tab: "activity" | "map" | "guide" | "lens" | "diff") => void;
  } = $props();

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
      <BookOpen size={15} aria-hidden="true" /><TriangleAlert size={10} aria-hidden="true" />
    {/if}
  {:else if id === "lens"}
    {#if lensState === "generating"}
      <LoaderCircle size={12} aria-hidden="true" class="animate-spin motion-reduce:animate-none" />
    {:else if lensState === "attention"}
      <TriangleAlert size={10} aria-hidden="true" />
    {/if}
  {/if}
{/snippet}

<!-- No track behind the group and no rule under it: the active tab, raised
     as a pill like the header's actions, is the whole cue. Deliberately identical to the local review's tabs — reading a
     pull request and reading a branch are the same job, and the control that
     switches views should not change shape with where the change came from. -->
<div
  class="no-drag flex shrink-0 items-center gap-1 {home === 'band'
    ? '@max-[48rem]/band:hidden'
    : '@max-[30rem]/band:hidden'}"
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
      disabled={disabledFor(t.id)}
      title={titleFor(t.id)}
      class="inline-flex items-center gap-1 h-6.5 cursor-pointer rounded-full px-2 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-10 @min-[34rem]/band:px-2.5 @min-[53.75rem]/band:px-3 {isActive
        ? 'bg-background font-medium text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]'
        : isUnread
          ? 'bg-transparent font-medium text-(--success) hover:bg-[var(--wash-1)]'
          : 'bg-transparent font-normal text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground'}"
      onclick={() => onSelect(t.id)}
    >
      {t.label}
      {@render tabGlyph(t.id)}
    </button>
  {/each}
</div>

<!-- The switcher: the active pill with a caret, standing in for the whole
     row under the home's rung. -->
<button
  bind:this={switcherEl}
  type="button"
  class="no-drag hidden h-6.5 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-background px-2.5 text-workspace-chrome font-medium text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)] transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] aria-expanded:bg-[var(--wash-1)] pointer-coarse:h-10 {home === 'band'
    ? '@max-[48rem]/band:inline-flex'
    : '@max-[30rem]/band:inline-flex'}"
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
</button>

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
