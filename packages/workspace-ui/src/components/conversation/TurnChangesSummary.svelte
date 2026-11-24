<script lang="ts">
  import type { TurnSnapshot } from "@solus/contracts/git-types";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import DiffSummaryCard from "./DiffSummaryCard.svelte";
  import CloudTurnDiff from "./CloudTurnDiff.svelte";
  import { turnSnapshotFor, turnWindow } from "./lib/turn-snapshot";
  import type { Turn } from "./lib/turns";

  /**
   * What one settled turn changed, under the turn. The run host's checkpoint
   * comes first; a turn read from the session's cloud copy, which the run host
   * has no checkpoint of, reads its diff from Solus Cloud.
   */
  let { tabId, sessionId, turns, turnIdx, turnSnapshots }: {
    tabId: string;
    sessionId: string;
    turns: readonly Turn[];
    turnIdx: number;
    turnSnapshots: readonly TurnSnapshot[];
  } = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const latestOnly = $derived(!settings.keepDiffSummaryOnEarlierTurns);
  const snapshot = $derived(turnSnapshotFor(turns, turnIdx, turnSnapshots, latestOnly));
  const cloudTurn = $derived(snapshot ? undefined : turnSnapshotFor(turns, turnIdx, session.cloudTranscripts.turnsFor(sessionId), latestOnly));
</script>

{#if snapshot && snapshot.filesChanged > 0}
  {@const scope = { kind: "turn", index: snapshot.index } as const}
  <!-- Stands off the turn it reports on: the summary is a footnote to
       the turn's last message, not the next line of it. -->
  <div class="flex justify-center pt-3">
    <DiffSummaryCard
      {tabId}
      {scope}
      totals={{ files: snapshot.filesChanged, additions: snapshot.additions, deletions: snapshot.deletions }}
      agentWindow={turnWindow(turns, turnIdx)}
      onOpenDiff={(filePath, repositoryPath) =>
        repositoryPath
          ? session.showRepositoryDiff(tabId, repositoryPath, scope)
          : session.showDiff(tabId, scope, filePath)}
      onOpenFile={(filePath) =>
        session.openFileInFiles({ path: filePath }, tabId)}
    />
  </div>
{:else if cloudTurn}
  <div class="flex justify-center pt-3">
    <CloudTurnDiff {sessionId} turnIndex={cloudTurn.index} />
  </div>
{/if}
