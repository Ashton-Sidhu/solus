<script lang="ts">
  /**
   * Which view of the change you are reading: Activity · Guide · Diff.
   *
   * Its own component because it has two homes — inside the masthead when the
   * review is a page (where it belongs to the content beneath it), and in the
   * panel's chrome row when the review is docked beside the list (where the
   * content is too short to carry a row of its own).
   */
  let {
    tab,
    diffOpen,
    guideDisabled = false,
    guideDisabledReason,
    tabsDisabled = false,
    diffHint,
    onSelect,
  }: {
    /** The content tab showing in this column, or `null` when the change has
     *  the column to itself — Diff is tracked separately because a page-shaped
     *  review keeps reading Activity while the diff sits in the pane beside it. */
    tab: "activity" | "map" | "guide" | null;
    /** Whether the change is showing, wherever this surface puts it. */
    diffOpen: boolean;
    guideDisabled?: boolean;
    guideDisabledReason?: string;
    /** The host target is still loading, so revision-backed tabs are not ready. */
    tabsDisabled?: boolean;
    diffHint?: string;
    onSelect: (tab: "activity" | "map" | "guide" | "diff") => void;
  } = $props();

  const TABS = [
    { id: "activity" as const, label: "Activity" },
    { id: "map" as const, label: "Map" },
    { id: "guide" as const, label: "Guide" },
    { id: "diff" as const, label: "Diff" },
  ];

  function active(id: (typeof TABS)[number]["id"]): boolean {
    return id === "diff" ? diffOpen : tab === id;
  }
</script>

<!-- No track behind the group and no rule under it: the active tab's own wash is
     the whole cue. Deliberately identical to the local review's tabs — reading a
     pull request and reading a branch are the same job, and the control that
     switches views should not change shape with where the change came from. -->
<div
  class="no-drag flex shrink-0 items-center gap-0.5"
  role="tablist"
  aria-label="Pull request views"
>
  {#each TABS as t (t.id)}
    {@const isActive = active(t.id)}
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      disabled={(t.id === "guide" && guideDisabled) ||
        (t.id !== "activity" && tabsDisabled)}
      title={t.id === "guide" && guideDisabled
        ? guideDisabledReason
        : t.id !== "activity" && tabsDisabled
          ? "Checking out this PR's worktree…"
          : t.id === "diff"
            ? diffHint
            : undefined}
      class="h-7 cursor-pointer rounded-lg px-2 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-10 @min-[34rem]/band:px-2.5 @min-[53.75rem]/band:px-3 pointer-fine:[.is-laptop-display_&]:h-6.5 {isActive
        ? 'bg-[var(--wash-2)] font-medium text-foreground'
        : 'bg-transparent font-normal text-muted-foreground hover:text-foreground'}"
      onclick={() => onSelect(t.id)}
    >
      {t.label}
    </button>
  {/each}
</div>
