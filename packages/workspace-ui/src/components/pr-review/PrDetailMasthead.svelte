<script lang="ts">
  import PrIdentityLink from "./PrIdentityLink.svelte";
  import PrViewTabs from "./PrViewTabs.svelte";

  /**
   * The row above the title, shared by every tab: which pull request this is,
   * on the left, and which view of it you are reading, on the right. The
   * state and the refs are stated in the lines beside the author, the way a
   * code host states them — this row carries identity and the switch between
   * views.
   *
   * The tabs live here rather than in the chrome band because they belong to the
   * content, not to the navigation — the band above says *where you are*, this
   * row says *what you are looking at*. Diff is a toggle, not a peer: it opens
   * the change beside the review instead of replacing it.
   *
   * The panel-shaped review has no room for a row of its own and carries the
   * same facts in its chrome band instead; see PrPanelHeader.
   */
  let {
    repo,
    number,
    onOpenPage,
    tab,
    diffOpen,
    guideDisabled = false,
    guideDisabledReason,
    tabsDisabled = false,
    onSelect,
  }: {
    /** `owner/repo`, or null when the target does not carry its repository. */
    repo: string | null;
    number: number;
    /** Open the pull request on its host. */
    onOpenPage?: () => void;
    /** The content tab showing in this column — Diff is never one of them. */
    tab: "activity" | "map" | "guide";
    /** Whether the change is open in the pane beside this one. */
    diffOpen: boolean;
    guideDisabled?: boolean;
    guideDisabledReason?: string;
    /** The host target is still loading, so revision-backed tabs are not ready. */
    tabsDisabled?: boolean;
    onSelect: (tab: "activity" | "map" | "guide" | "diff") => void;
  } = $props();
</script>

<!-- The same container name the panel band declares, so the shared tab group
     reads its rungs off this row's width here too rather than falling back to
     its narrowest step on a full-width page. -->
<div class="@container/band flex items-center gap-2.5">
  <PrIdentityLink {repo} {number} {onOpenPage} />

  <span class="min-w-2 flex-1"></span>

  <PrViewTabs
    {tab}
    {diffOpen}
    {guideDisabled}
    {guideDisabledReason}
    {tabsDisabled}
    diffHint="Open the change beside this review"
    {onSelect}
  />
</div>
