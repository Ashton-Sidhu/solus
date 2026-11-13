<script lang="ts">
  import { BitsConfig } from "bits-ui";
  import { getPullRequestsContext } from "../../../contexts";
  import { getPopoverLayer } from "../../popoverLayer.svelte";
  import PrListRow from "../../prs/PrListRow.svelte";
  import { prRow } from "../../prs/lib/prs-list-view";
  import type { FoundPullRequest } from "./lib/picker-records";

  /**
   * A pull request in the search: the row of the pull requests page, built by
   * that page's row builder, so the two surfaces never say different things of
   * one pull request. The verdict is its icon alone: the list has half the
   * card's width.
   */
  interface Props {
    found: FoundPullRequest;
    /** Row identity: two projects can hold the same number. */
    rowKey: string;
    selected: boolean;
    onSelect: () => void;
  }
  let { found, rowKey, selected, onSelect }: Props = $props();

  const pullRequests = getPullRequestsContext();
  const layer = getPopoverLayer();
  // The search asked for the pull request through the context, so the context
  // holds it: its check runs and its churn by kind are read from there when
  // the reader opens them.
  const stored = $derived(
    pullRequests.projects.at(found.serverId, found.projectRoot)?.prFor(found.pullRequest.number) ?? null,
  );
  // Whose pull request it is sorts the page's sections. It changes nothing in a row.
  const row = $derived(prRow(found.pullRequest, { isMine: () => false }, Date.now(), null, rowKey, found.projectLabel));
</script>

<!-- The checks popover and the churn tooltip portal into the search's layer,
     or they open under its scrim. -->
<BitsConfig defaultPortalTo={layer.el ?? undefined}>
  <PrListRow
    {row}
    {selected}
    iconVerdict
    leading={titleInset}
    breakdown={stored?.changeBreakdown}
    onWantBreakdown={() => void stored?.loadChangedFiles().catch(() => {})}
    checksSummary={stored?.checks}
    checksLoadFailed={stored?.checksLoadFailed ?? false}
    headSha={found.pullRequest.headSha}
    onWantChecks={() => void stored?.loadChecks().catch(() => {})}
    {onSelect}
  />
</BitsConfig>

<!-- Space before the state icon, so the title starts where the title of every
     other row of the search starts. -->
{#snippet titleInset()}
  <span class="w-[1.375rem] shrink-0" aria-hidden="true"></span>
{/snippet}
