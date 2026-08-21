<script lang="ts">
  import {
    ArrowUpRight as OpenPageIcon,
    Ellipsis as DotsThreeIcon,
    PenLine as RewriteIcon,
    RotateCw as ArrowClockwiseIcon,
  } from "@lucide/svelte";
  import type { GuideHeaderActions } from "../diff/lib/review-header";
  import * as DropdownMenu from "../ui/dropdown-menu";

  /**
   * The pull-request panel's contextual menu — the same object as the local
   * review's, so one band grammar covers both kinds of review.
   *
   * The band above it carries navigation and state. Commands used once a
   * session — refresh the pull request, open its page, rewrite the guide —
   * live here, where they cost the chrome nothing on the tabs that cannot use
   * them. The menu is contextual; the band is not, and it is never empty:
   * Refresh is on every tab because every tab reads the same pull request.
   */
  let {
    tab,
    onRefresh,
    refreshing,
    onOpenPage,
    guide,
  }: {
    tab: "activity" | "map" | "guide" | "diff";
    onRefresh: () => void;
    refreshing: boolean;
    /** Absent for the list's own detail panel, which has no route to open. */
    onOpenPage?: () => void;
    /** Absent where this pull request has no guide to rewrite. */
    guide?: GuideHeaderActions;
  } = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  const heading = $derived(
    tab === "map"
      ? "Change map"
      : tab === "guide"
        ? "Walkthrough"
        : tab === "diff"
          ? "Diff view"
          : "Activity",
  );

  const showsGuideRow = $derived(tab === "guide" && !!guide?.present);
  const flagsStale = $derived(showsGuideRow && !!guide?.stale);
</script>

<button
  bind:this={triggerEl}
  type="button"
  class="no-drag pointer-events-auto relative flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {open
    ? 'bg-[var(--wash-3)] text-foreground'
    : 'bg-transparent text-muted-foreground hover:bg-[var(--wash-3)] hover:text-foreground'}"
  aria-label={flagsStale
    ? "More pull request options — new commits since guide"
    : "More pull request options"}
  aria-haspopup="menu"
  aria-expanded={open}
  title={flagsStale ? "New commits since guide" : "More options"}
  onclick={() => (open = !open)}
>
  <DotsThreeIcon size={15} />
  {#if flagsStale}
    <span
      class="absolute top-[3px] right-[3px] size-[5px] rounded-full bg-primary"
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

    {#if showsGuideRow && guide}
      <DropdownMenu.Item disabled={guide.regenerating} onSelect={guide.onRegenerate}>
        <RewriteIcon size={14} />
        {guide.regenerating
          ? "Regenerating…"
          : guide.stale
            ? "New commits since guide"
            : "Regenerate guide"}
        {#if guide.stale && !guide.regenerating}
          <span class="ml-auto size-[5px] shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
        {/if}
      </DropdownMenu.Item>
    {/if}

    <DropdownMenu.Item disabled={refreshing} onSelect={onRefresh}>
      <ArrowClockwiseIcon
        size={14}
        class={refreshing ? "animate-spin [animation-duration:0.9s]" : ""}
      />
      {refreshing ? "Refreshing…" : "Refresh pull request"}
    </DropdownMenu.Item>

    {#if onOpenPage}
      <DropdownMenu.Item onSelect={onOpenPage}>
        <OpenPageIcon size={14} />
        Open pull request page
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
