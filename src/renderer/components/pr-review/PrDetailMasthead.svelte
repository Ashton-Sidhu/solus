<script lang="ts">
  import { ArrowRightIcon } from "phosphor-svelte";
  import type { PullRequestSummary } from "../../../shared/providers";
  import { statusLabel, statusPillColors } from "./lib/pr-status";

  /**
   * The row above the title, shared by every tab: what state this pull request
   * is in, which branch it lands on, and which view of it you are reading.
   *
   * The tabs live here rather than in the chrome band because they belong to the
   * content, not to the navigation — the band above says *where you are*, this
   * row says *what you are looking at*. Diff is a toggle, not a peer: it opens
   * the change beside the review instead of replacing it.
   */
  let {
    status,
    headRef,
    baseRef,
    tab,
    diffOpen,
    guideDisabled = false,
    guideDisabledReason,
    tabsDisabled = false,
    onSelect,
  }: {
    /** The list's own group key, so the pill agrees with the list behind it. */
    status: string;
    headRef?: string;
    baseRef?: string;
    /** The content tab showing in this column — Diff is never one of them. */
    tab: "activity" | "guide";
    /** Whether the change is open in the pane beside this one. */
    diffOpen: boolean;
    guideDisabled?: boolean;
    guideDisabledReason?: string;
    /** Still checking out — nothing but Activity can be read yet. */
    tabsDisabled?: boolean;
    onSelect: (tab: "activity" | "guide" | "diff") => void;
  } = $props();

  const pill = $derived(statusPillColors(status));

  const TABS = [
    { id: "activity" as const, label: "Activity" },
    { id: "guide" as const, label: "Guide" },
    { id: "diff" as const, label: "Diff" },
  ];

  function active(id: (typeof TABS)[number]["id"]): boolean {
    return id === "diff" ? diffOpen : tab === id;
  }
</script>

<div class="flex items-center gap-2.5">
  <span
    class="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10.5px] font-medium tracking-[.03em] whitespace-nowrap"
    style="background:{pill.background};color:{pill.color}"
  >
    {statusLabel(status)}
  </span>

  {#if headRef && baseRef}
    <!-- head → base, reading in merge direction. -->
    <span class="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
      <span class="truncate">{headRef}</span>
      <ArrowRightIcon size={10} class="shrink-0 opacity-50" aria-hidden="true" />
      <span class="truncate">{baseRef}</span>
    </span>
  {/if}

  <span class="flex-1"></span>

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
              ? "Open the change beside this review"
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
</div>
