<script lang="ts">
  import { untrack } from "svelte";
  import type { SessionPullRequestLink } from "@solus/contracts/session-pull-requests";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { pullRequestCard } from "@solus/client-core/pull-request-card";
  import { pullRequestKey } from "@solus/client-core/reply-pull-requests";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import { sessionPrLink } from "../../contexts/prs/session-pull-requests.store.svelte";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { sessionArtifactsStore } from "../../contexts/sessions/session-artifacts.store.svelte";
  import { projectRoot, runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import PullRequestTurnCard from "./PullRequestTurnCard.svelte";
  import { openArtifact } from "../session/artifacts/lib/artifact-open";
  import { watchRefusal } from "./lib/pull-request-card";

  /** A pull request the turn linked, where its final reply mentions it
   *  (`placeReplyPullRequests`): the card, kept fresh by PR sync, with the
   *  session's watch on it. */
  let { link, tabId }: { link: SessionPullRequestLink; tabId: string } = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const owner = $derived(session.sessionFor(tabId));
  const serverId = $derived(runHost(owner?.run));
  const card = $derived(pullRequestCard(link, pullRequests.projects.livePr(serverId, link.repository, link.number)));
  const canWatch = $derived(canDriveSession(serverId, link.sessionId, "edit"));
  let isWatchBusy = $state(false);

  // PR sync keeps the pull request fresh while the card shows it. The key is
  // a string: a new read of the links writes a new link object.
  const linkKey = $derived(pullRequestKey(link));
  $effect(() => {
    void linkKey;
    const host = serverId;
    if (!host) return;
    return untrack(() => {
      const root = projectRoot(owner?.run);
      return pullRequests.projects.wantLinkedPrs(
        serverConnections.apiFor(host),
        host,
        root ? session.ctxForDirectory(root) : session.ctx,
        [sessionPrLink(link)],
      );
    });
  });

  async function setWatch(watching: boolean) {
    if (isWatchBusy) return;
    isWatchBusy = true;
    try {
      const refusal = watchRefusal(await sessionArtifactsStore.setPullRequestWatch(link, watching));
      if (refusal) toasts.error("Couldn't watch the pull request", { description: refusal });
    } catch (error) {
      toasts.error(watching ? "Couldn't watch the pull request" : "Couldn't stop watching the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isWatchBusy = false;
      requestInputFocus();
    }
  }
</script>

<div class="not-prose my-2">
  <PullRequestTurnCard
    {card}
    {canWatch}
    {isWatchBusy}
    onOpen={() => openArtifact(session, { kind: "pull-request", link }, link.sessionId, serverId)}
    onSetWatch={(watching) => void setWatch(watching)}
  />
</div>
