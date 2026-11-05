<script lang="ts">
  import { turnArtifacts } from "@solus/client-core/session-artifact-chips";
  import { getWorkspaceContext } from "../../contexts";
  import { sessionArtifactsStore } from "../../contexts/sessions/session-artifacts.store.svelte";
  import { runHost } from "../../contexts/workspace/run-location";
  import ArtifactChipRow from "./agent-conversation/ArtifactChipRow.svelte";
  import { openArtifact } from "../session/artifacts/lib/artifact-open";
  import type { Turn } from "./lib/turns";
  import { galleryHrefs } from "./lib/turn-images";

  /** What the session linked during a finished turn, under its reply and gallery. */
  let { turn, nextStartedAt, tabId }: { turn: Turn; nextStartedAt: number | null; tabId: string } = $props();

  const session = getWorkspaceContext();
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
  ));

  function openAll() {
    if (!sessionId) return;
    session.router.navigate({ name: "artifacts", params: { sessionId, serverId } }, { target: "companion" });
  }
</script>

{#if sessionId && items.length > 0}
  <div class="mt-2">
    <ArtifactChipRow {items} onOpen={(artifact) => openArtifact(session, artifact, sessionId, serverId)} onOpenAll={openAll} />
  </div>
{/if}
