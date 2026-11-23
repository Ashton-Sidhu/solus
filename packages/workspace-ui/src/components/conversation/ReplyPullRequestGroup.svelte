<script lang="ts">
  import { GitPullRequestIcon } from "../ui/octicons";
  import type { SessionPullRequestLink } from "@solus/contracts/session-pull-requests";
  import { pullRequestCard, pullRequestGroupSummary } from "@solus/client-core/pull-request-card";
  import { pullRequestKey } from "@solus/client-core/reply-pull-requests";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import { runHost } from "../../contexts/workspace/run-location";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import ReplyPullRequestCard from "./ReplyPullRequestCard.svelte";
  import TranscriptCard from "./TranscriptCard.svelte";

  /**
   * Two or more pull requests the final reply links in a row
   * (`placeReplyPullRequests`): one card, as several sub-agents are. The line
   * counts them and their states; open, it lists one row per pull request,
   * each with its own watch. It opens unfolded, because each row is a link the
   * reader came for.
   */
  let { links, tabId }: { links: SessionPullRequestLink[]; tabId: string } = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const serverId = $derived(runHost(session.sessionFor(tabId)?.run));
  // The rows keep PR sync reading each pull request; the line only reads what it has.
  const summary = $derived(
    pullRequestGroupSummary(
      links.map((link) => pullRequestCard(link, pullRequests.projects.livePr(serverId, link.repository, link.number))),
    ),
  );

  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`pull-requests:${links.map(pullRequestKey).join(" ")}`));
  const expanded = $derived(view.openedByUser ?? true);
</script>

<div class="not-prose my-2">
  <TranscriptCard
    title={summary.title}
    target={summary.status}
    {expanded}
    bodyLayout="rows"
    ariaLabel={summary.status ? `${summary.title}, ${summary.status}` : summary.title}
    skipMotion
    data-testid="pull-request-group-card"
    onOpen={() => (view.openedByUser = !expanded)}
  >
    {#snippet glyph()}
      <GitPullRequestIcon aria-hidden="true" />
    {/snippet}
    {#snippet rail()}
      {#if !expanded && summary.filesLabel}<span>{summary.filesLabel}</span>{/if}
    {/snippet}
    {#snippet body()}
      {#each links as link (pullRequestKey(link))}
        <ReplyPullRequestCard {link} {tabId} grouped />
      {/each}
    {/snippet}
  </TranscriptCard>
</div>
