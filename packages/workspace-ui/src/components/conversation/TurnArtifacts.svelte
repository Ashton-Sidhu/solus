<script lang="ts">
  import { pullRequestKey } from "@solus/client-core/reply-pull-requests";
  import { turnArtifacts } from "@solus/client-core/session-artifact-chips";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { sessionArtifactsStore } from "../../contexts/sessions/session-artifacts.store.svelte";
  import { runHost } from "../../contexts/workspace/run-location";
  import ArtifactChipRow from "./agent-conversation/ArtifactChipRow.svelte";
  import { openArtifact } from "../session/artifacts/lib/artifact-open";
  import type { Turn } from "./lib/turns";
  import { galleryHrefs } from "./lib/turn-images";

  /** What the session linked during a finished turn, under its reply and
   *  gallery. A pull request the reply mentions has its card in the reply, so
   *  it takes no chip here. */
  let { turn, nextStartedAt, tabId, placedPullRequests }: {
    turn: Turn;
    nextStartedAt: number | null;
    tabId: string;
    /** `pullRequestKey`s of the pull requests the final reply shows as cards. */
    placedPullRequests: ReadonlySet<string>;
  } = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const owner = $derived(session.sessionFor(tabId));
  const sessionId = $derived(owner?.id);
  const serverId = $derived(runHost(owner?.run));
  $effect(() => {
    if (sessionId && serverId) sessionArtifactsStore.ensure(serverId, sessionId);
  });
  const items = $derived(turnArtifacts(
    sessionArtifactsStore.artifactsFor(sessionId)?.own ?? [],
    { startedAt: turn.startedAt, nextStartedAt },
    () => galleryHrefs(turn.images),
  ).filter((item) => item.kind !== "pull-request" || !placedPullRequests.has(pullRequestKey(item.link))));

  function openAll() {
    if (!sessionId) return;
    session.router.navigate({ name: "artifacts", params: { sessionId, serverId } }, { target: "companion" });
  }
</script>

{#if sessionId && items.length > 0}
  <div class="mt-2">
    <ArtifactChipRow {items} size={settings.artifactChipSize} onOpen={(artifact) => openArtifact(session, artifact, sessionId, serverId)} onOpenAll={openAll} />
  </div>
{/if}
