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

<div
  class="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--wash-2)] p-0.5 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
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
      class="h-6 cursor-pointer rounded-full px-3 text-xs transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 {isActive
        ? 'bg-card font-medium text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
        : 'bg-transparent font-normal text-muted-foreground hover:text-foreground'}"
      onclick={() => onSelect(t.id)}
    >
      {t.label}
    </button>
  {/each}
</div>
